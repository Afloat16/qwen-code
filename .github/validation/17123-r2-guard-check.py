import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path.cwd()
out = Path(os.environ["RUNNER_TEMP"]) / "qwen17123-r2-guard-check"
out.mkdir(parents=True, exist_ok=True)
source = root / "packages/cli/src/serve/fast-path-settings.ts"
tests = root / "packages/cli/src/serve/fast-path.test.ts"
expected_sha = "b86af9512bb437b63fc014ff2e8aa74b7f42c9b4"
assert subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() == expected_sha
assert subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], text=True).strip() == "73048b97756a586744c47a65c23d754963c7a5b8"
subprocess.run(["git", "diff", "--exit-code"], check=True)
original = source.read_bytes()
test_original = tests.read_bytes()
guard = "!(isPlainObject(security) && isPlainObject(security['folderTrust']))"
assert original.decode().count(guard) == 1
mutant = original.decode().replace(guard, "out.security === undefined", 1).encode()
parent = subprocess.check_output(["git", "show", "HEAD^:packages/cli/src/serve/fast-path-settings.ts"])
assert mutant == parent, "The counterfactual must be exactly the parent production file"

def run_case(label, expected_failed):
    report_path = out / (label + ".json")
    command = ["corepack", "pnpm", "exec", "vitest", "run", "src/serve/fast-path.test.ts",
               "-t", "keeps a nested folder-trust object ahead of the feature alias",
               "--maxWorkers=1", "--minWorkers=1", "--retry=0",
               "--reporter=default", "--reporter=json", "--outputFile.json=" + str(report_path)]
    result = subprocess.run(command, cwd=root / "packages/cli", text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    print(result.stdout, flush=True)
    (out / (label + ".log")).write_text(result.stdout)
    report = json.loads(report_path.read_text())
    assert len(report["testResults"]) == 1
    assertions = report["testResults"][0]["assertionResults"]
    selected = [a for a in assertions if "keeps a nested folder-trust object ahead of the feature alias" in a["fullName"]]
    assert len(selected) == 2, len(selected)
    assert report.get("numRuntimeErrorTestSuites", 0) == 0
    assert not report.get("unhandledErrors", [])
    assert report["numFailedTests"] == expected_failed
    assert report["numPassedTests"] == 2 - expected_failed
    assert result.returncode == (1 if expected_failed else 0), result.returncode
    assert all(a["status"] == ("failed" if expected_failed else "passed") for a in selected)
    if expected_failed:
        for assertion in selected:
            assert any("expected true to be undefined" in message for message in assertion["failureMessages"])
    assert tests.read_bytes() == test_original
    return {"selected": 2, "passed": 2 - expected_failed, "failed": expected_failed,
            "filtered": len(assertions) - len(selected), "runtime_errors": 0,
            "test_names": [a["fullName"] for a in selected]}

try:
    source.write_bytes(mutant)
    before_restore = run_case("parent-guard", 2)
finally:
    source.write_bytes(original)
    assert tests.read_bytes() == test_original
    subprocess.run(["git", "diff", "--exit-code"], check=True)

restored = run_case("restored-candidate", 0)
assert source.read_bytes() == original
assert tests.read_bytes() == test_original
subprocess.run(["git", "diff", "--exit-code"], check=True)
summary = {"source_sha": expected_sha, "role": "production-owner counterfactual",
           "parent_guard": before_restore, "restored_candidate": restored,
           "source_sha256": hashlib.sha256(original).hexdigest(),
           "tests_sha256": hashlib.sha256(test_original).hexdigest(),
           "tracked_source_unchanged": True}
(out / "summary.json").write_text(json.dumps(summary, indent=2))
print("GUARD_CHECK " + json.dumps(summary), flush=True)
