import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--repo", required=True)
parser.add_argument("--evidence", required=True)
args = parser.parse_args()
repo = Path(args.repo).resolve()
evidence = Path(args.evidence).resolve()
evidence.mkdir(parents=True, exist_ok=True)
candidate = "58069518e9971bae2c989e1c99bd3e24f18b2221"
parent = "640a94fa53f690bafea90ec4e7d30dfe542a661a"
assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip() == candidate
assert subprocess.check_output(["git", "rev-parse", "HEAD^"], cwd=repo, text=True).strip() == parent
sdk = repo / "packages/sdk-typescript"
test_path = sdk / "test/unit/negotiateTransport.test.ts"
source_path = sdk / "src/daemon/negotiateTransport.ts"
test_original = test_path.read_bytes()
source_original = source_path.read_bytes()
assert hashlib.sha256(test_original).hexdigest() == "5cf837b1ce4ba8e91c8df316ae3d18ba9710d9db2a6bab88ce6f82b5edbb6b21"
assert hashlib.sha256(source_original).hexdigest() == "ad442f2abdb38ce367226fd775290c068787d58ab7929000f8889a52ddbb4116"
test_text = test_original.decode()
source_text = source_original.decode()

def replace_once(text, before, after):
    assert text.count(before) == 1, (before, text.count(before))
    return text.replace(before, after, 1)

def report_counts(data):
    assertions = [a for result in data["testResults"] for a in result["assertionResults"]]
    return {
        "files": len(data["testResults"]),
        "total": len(assertions),
        "passed": sum(a["status"] == "passed" for a in assertions),
        "failed": sum(a["status"] == "failed" for a in assertions),
        "not_selected_or_pending": sum(a["status"] not in ("passed", "failed") for a in assertions),
        "reporter_summary": {key: data[key] for key in ("numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests")},
        "failures": [{"name": a["fullName"], "messages": a["failureMessages"]} for a in assertions if a["status"] == "failed"],
    }

def run(label, selected=None):
    output = evidence / (label + ".json")
    command = [
        "node", "node_modules/vitest/vitest.mjs", "run",
        "test/unit/negotiateTransport.test.ts", "--pool=forks",
        "--poolOptions.forks.singleFork=true", "--retry=0",
        "--reporter=json", "--outputFile=" + str(output),
    ]
    if selected:
        command += ["-t", selected]
    with (evidence / (label + ".log")).open("w") as log:
        process = subprocess.Popen(command, cwd=sdk, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=45)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
    result = {"label": label, "exit_code": code, **report_counts(json.loads(output.read_text()))}
    print(json.dumps(result), flush=True)
    return result

full_sdk = report_counts(json.loads((evidence / "sdk-full.json").read_text()))
print(json.dumps({"label": "full-sdk", **full_sdk}), flush=True)
assert full_sdk["files"] == 64 and full_sdk["passed"] == 2434 and full_sdk["failed"] == 0 and full_sdk["not_selected_or_pending"] == 0, full_sdk
focused = run("candidate-focused")
assert focused["exit_code"] == 0 and focused["passed"] == 19 and focused["failed"] == 0 and focused["not_selected_or_pending"] == 0, focused

hook = """      signal?.addEventListener('abort', () => release(signal?.reason), {
        once: true,
      });"""
timer = "    const timer = setTimeout(() => ctrl.abort(), probeTimeoutMs);"
header_end = """        signal: ctrl.signal,
      });"""
mutations = [
    (
        "fixture-abort-hook-removed", test_path,
        replace_once(test_text, hook, ""),
        "capabilities fetch fixture",
        ["capabilities fetch fixture delivers the first chunk and headers, then rejects a stalled read on abort"],
    ),
    (
        "default-timeout-30s", source_path,
        replace_once(source_text, "opts?.probeTimeoutMs ?? 5_000", "opts?.probeTimeoutMs ?? 30_000"),
        None,
        ["negotiateTransport probe timeout uses default 5000ms timeout when not specified"],
    ),
    (
        "timer-starts-after-headers", source_path,
        replace_once(
            replace_once(source_text, timer, "    let timer: ReturnType<typeof setTimeout> | undefined;"),
            header_end, header_end + "\n      timer = setTimeout(() => ctrl.abort(), probeTimeoutMs);",
        ),
        None,
        ["negotiateTransport probe timeout custom probeTimeoutMs aborts a request whose headers never arrive"],
    ),
    (
        "deadline-clear-removed", source_path,
        replace_once(source_text, "      clearTimeout(timer);", ""),
        None,
        [
            "negotiateTransport probe timeout keeps a complete delayed capabilities response and clears its deadline",
            "negotiateTransport probe timeout clears the capabilities deadline when body parsing fails",
        ],
    ),
]
results = []
try:
    for label, path, mutated, selected, expected in mutations:
        test_path.write_bytes(test_original)
        source_path.write_bytes(source_original)
        path.write_text(mutated)
        result = run(label, selected)
        results.append(result)
        assert result["exit_code"] != 0, result
        assert sorted(item["name"].strip() for item in result["failures"]) == sorted(expected), result
        assert all("expected" in "\n".join(item["messages"]).lower() and "timed out" not in "\n".join(item["messages"]).lower() for item in result["failures"]), result
        assert result["not_selected_or_pending"] == (18 if selected else 0), result
finally:
    test_path.write_bytes(test_original)
    source_path.write_bytes(source_original)
    (evidence / "mutation-results.json").write_text(json.dumps(results, indent=2) + "\n")
assert test_path.read_bytes() == test_original
assert source_path.read_bytes() == source_original
restored = run("restored-focused")
assert restored["exit_code"] == 0 and restored["passed"] == 19 and restored["failed"] == 0 and restored["not_selected_or_pending"] == 0, restored
subprocess.run(["git", "diff", "--exit-code", "--", str(test_path.relative_to(repo)), str(source_path.relative_to(repo))], cwd=repo, check=True)
result = {
    "candidate": candidate, "parent": parent, "sdk_full": full_sdk,
    "focused": focused, "mutations": results, "restored": restored,
    "restored_hashes": {
        str(test_path.relative_to(repo)): hashlib.sha256(test_path.read_bytes()).hexdigest(),
        str(source_path.relative_to(repo)): hashlib.sha256(source_path.read_bytes()).hexdigest(),
    },
    "source_restored": True,
    "runtime": subprocess.check_output(["node", "--version"], text=True).strip(),
    "counting": "Counts use assertionResults.status; filtered tests are never counted as executed passes.",
}
(evidence / "verification-results.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"candidate": candidate, "sdk": {"files": full_sdk["files"], "passed": full_sdk["passed"]}, "focused": focused["passed"], "mutations_failed": [r["failed"] for r in results], "restored": restored["passed"], "restored_hashes": result["restored_hashes"], "source_restored": True}), flush=True)
