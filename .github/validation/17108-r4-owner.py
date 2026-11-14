import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

root = Path.cwd()
evidence = Path(os.environ["RUNNER_TEMP"]) / "qwen17108-r4-owner"
evidence.mkdir(parents=True, exist_ok=True)
source_sha = os.environ["SOURCE_SHA"]
parent_sha = "caa528f0d4dcccf5521971d902257c3ecdeed8cd"
component = "packages/web-shell/client/components/messages/MemoryMessage.tsx"
refresh_test = "client/components/messages/MemoryMessage.refresh.test.tsx"
suite = [
    "client/components/messages/MemoryMessage.test.tsx",
    refresh_test,
    "client/daemon/workspace/hooks/useDaemonResource.test.tsx",
    "client/daemon/workspace/hooks/useDaemonMemory.test.tsx",
]
changed = [component, "packages/web-shell/" + refresh_test, "packages/web-shell/client/i18n.tsx"]
originals = {path: (root / path).read_bytes() for path in changed}
hashes = {path: hashlib.sha256(value).hexdigest() for path, value in originals.items()}
assert subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() == source_sha
assert subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], text=True).strip() == os.environ["SOURCE_TREE"]
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

selection = "reports a neutral retryable refresh|keeps a newer save confirmation"
try:
    run("candidate-full", suite, 39, 0)
    try:
        previous = subprocess.check_output(["git", "show", parent_sha + ":" + component])
        (root / component).write_bytes(previous)
        run("parent-selected", [refresh_test], 0, 4, selection, {
            "reports a neutral retryable refresh": 2,
            "keeps a newer save confirmation": 2,
        })
    finally:
        restore()
    try:
        replace_once(component, "    refreshSeqRef.current++;\n", "")
        run("mutation-save-sequence", [refresh_test], 0, 2,
            "keeps a newer save confirmation", {"keeps a newer save confirmation": 2})
    finally:
        restore()
    try:
        replace_once(component,
            "        if (superseded) {\n          const text = t('memory.refreshSuperseded');\n          setMessage(text);\n          onMessage?.(text, 'status');",
            "        if (superseded) {\n          const text = t('memory.refreshSuperseded');\n          setMessage(text);\n          onMessage?.(text, 'error');")
        run("mutation-superseded-error", [refresh_test], 0, 2,
            "reports a neutral retryable refresh", {"reports a neutral retryable refresh": 2})
    finally:
        restore()
    run("restored-selected", [refresh_test], 4, 0, selection)
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
