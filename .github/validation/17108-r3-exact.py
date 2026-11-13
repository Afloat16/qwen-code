import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

root = Path.cwd()
evidence = Path(os.environ["RUNNER_TEMP"]) / "qwen17108-r3-exact"
evidence.mkdir(parents=True, exist_ok=True)
source_sha = os.environ["SOURCE_SHA"]
parent_sha = "eedc5dc22d7b67d4b6210088b277ede7347e3181"
component = "packages/web-shell/client/components/messages/MemoryMessage.tsx"
resource = "packages/web-shell/client/daemon/workspace/hooks/useDaemonResource.ts"
refresh_test = "client/components/messages/MemoryMessage.refresh.test.tsx"
resource_test = "client/daemon/workspace/hooks/useDaemonResource.test.tsx"
suite = [
    "client/components/messages/MemoryMessage.test.tsx",
    refresh_test,
    resource_test,
    "client/daemon/workspace/hooks/useDaemonMemory.test.tsx",
]
changed = [component, resource, "packages/web-shell/" + refresh_test, "packages/web-shell/" + resource_test]
originals = {path: (root / path).read_bytes() for path in changed}
hashes = {path: hashlib.sha256(value).hexdigest() for path, value in originals.items()}
assert subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() == source_sha
assert subprocess.check_output(["git", "rev-parse", "HEAD^"], text=True).strip() == parent_sha
subprocess.run(["git", "diff", "--exit-code"], check=True)
results = []

def run(name, paths, passed, failed, selection=None, failure_groups=None):
    command = ["corepack", "pnpm", "exec", "vitest", "run", *paths,
               "--maxWorkers=1", "--minWorkers=1", "--retry=0",
               "--reporter=default", "--reporter=json",
               "--outputFile.json=" + str(evidence / (name + ".json"))]
    if selection:
        command.extend(["-t", selection])
    proc = subprocess.run(command, cwd=root / "packages/web-shell", text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    (evidence / (name + ".log")).write_text(proc.stdout)
    print(proc.stdout, flush=True)
    data = json.loads((evidence / (name + ".json")).read_text())
    assertions = [a for f in data["testResults"] for a in f["assertionResults"]]
    selected = [a for a in assertions if a["status"] in ["passed", "failed"]]
    failures = [a for a in selected if a["status"] == "failed"]
    successes = [a for a in selected if a["status"] == "passed"]
    filtered = [a for a in assertions if a["status"] not in ["passed", "failed"]]
    assert proc.returncode == (1 if failed else 0), (name, proc.returncode)
    assert len(successes) == passed and len(failures) == failed, (name, len(successes), len(failures))
    assert data.get("numRuntimeErrorTestSuites", 0) == 0, name
    assert not data.get("unhandledErrors", []), name
    plain = re.sub(r"\x1b\[[0-9;]*m", "", proc.stdout)
    assert "Unhandled Error" not in plain and "Unhandled Rejection" not in plain, name
    if not selection:
        assert not filtered and data["numPendingTests"] == 0, name
    for failure in failures:
        assert any("AssertionError" in message for message in failure["failureMessages"]), failure
    for text, count in (failure_groups or {}).items():
        assert sum(text in a["fullName"] for a in failures) == count, (name, text, failures)
    summary = {
        "name": name, "command": command, "passed": len(successes), "failed": len(failures),
        "filtered_out": len(filtered), "selected": len(selected),
        "failures": [a["fullName"] for a in failures],
    }
    results.append(summary)
    print(json.dumps(summary, indent=2), flush=True)
    (evidence / "results.json").write_text(json.dumps(results, indent=2))

def replace_once(path, before, after):
    current = (root / path).read_text()
    assert current.count(before) == 1, (path, before, current.count(before))
    (root / path).write_text(current.replace(before, after, 1))

def restore():
    for path, content in originals.items():
        (root / path).write_bytes(content)
    actual = {path: hashlib.sha256((root / path).read_bytes()).hexdigest() for path in changed}
    assert actual == hashes
    subprocess.run(["git", "diff", "--exit-code"], check=True)

selection = "reports a list-load error to both|reports a retryable refresh|keeps errors specific to each reload outcome"
try:
    run("candidate-full", suite, 37, 0)

    try:
        for path in [component, resource]:
            previous = subprocess.check_output(["git", "show", parent_sha + ":" + path])
            (root / path).write_bytes(previous)
        run("parent-selected", [refresh_test, resource_test], 0, 4, selection, {
            "reports a list-load error": 1,
            "reports a retryable refresh": 2,
            "keeps errors specific": 1,
        })
    finally:
        restore()

    try:
        replace_once(resource, "      onError?.(normalized);\n", "")
        run("mutation-producer-error", [refresh_test, resource_test], 0, 2,
            "reports a list-load error to both|keeps errors specific to each reload outcome", {
                "reports a list-load error": 1, "keeps errors specific": 1,
            })
    finally:
        restore()

    try:
        replace_once(component,
            ": (refreshError?.message ?? t('memory.refreshFailed'));",
            ": t('memory.refreshFailed');")
        run("mutation-consumer-error", [refresh_test], 0, 1,
            "reports a list-load error to both", {"reports a list-load error": 1})
    finally:
        restore()

    try:
        replace_once(component, "        if (superseded || !nextStatus) {",
            "        if (superseded) return;\n        if (superseded || !nextStatus) {")
        run("mutation-superseded-feedback", [refresh_test], 0, 2,
            "reports a retryable refresh", {"reports a retryable refresh": 2})
    finally:
        restore()

    run("restored-selected", [refresh_test, resource_test], 4, 0, selection)
finally:
    restore()
    identity = {
        "source_sha": source_sha, "parent_sha": parent_sha,
        "source_tree": subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], text=True).strip(),
        "sha256_before": hashes,
        "sha256_after": {path: hashlib.sha256((root / path).read_bytes()).hexdigest() for path in changed},
        "source_restored": True,
    }
    (evidence / "identity.json").write_text(json.dumps(identity, indent=2))
    print(json.dumps(identity, indent=2), flush=True)
