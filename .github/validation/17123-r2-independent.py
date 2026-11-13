import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

root = Path.cwd()
verification = root.parent / "verification"
evidence = Path(os.environ["RUNNER_TEMP"]) / "qwen17123-r2-independent"
evidence.mkdir(parents=True, exist_ok=True)
fixture_source = verification / ".github/validation/17123-r2-independent.test.ts"
fixture_target = root / "packages/cli/src/config/migration/versions/17123-r2-independent.test.ts"
mode = os.environ.get("EXPECT_READER_RESULT", "baseline")
expected_sha = os.environ["SOURCE_SHA"]
tracked_before = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], text=True)
assert not tracked_before.strip(), tracked_before
assert subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip() == expected_sha
assert not fixture_target.exists(), str(fixture_target)
identity = {
    "source_sha": expected_sha,
    "mode": mode,
    "fixture_sha256": hashlib.sha256(fixture_source.read_bytes()).hexdigest(),
    "command": ["corepack", "pnpm", "exec", "vitest", "run",
        "src/config/migration/versions/17123-r2-independent.test.ts",
        "--maxWorkers=1", "--minWorkers=1", "--retry=0",
        "--reporter=default", "--reporter=json",
        "--outputFile.json=" + str(evidence / "report.json")],
}
(evidence / "identity.json").write_text(json.dumps(identity, indent=2))
env = dict(os.environ)
env["QWEN_R7_READER_EVIDENCE_DIR"] = str(evidence / "observations")
try:
    shutil.copyfile(fixture_source, fixture_target)
    result = subprocess.run(identity["command"], cwd=root / "packages/cli", env=env,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            timeout=180)
    (evidence / "test.log").write_text(result.stdout)
    print(result.stdout, flush=True)
    report = json.loads((evidence / "report.json").read_text())
    assertions = [a for f in report["testResults"] for a in f["assertionResults"]]
    failed = [a for a in assertions if a["status"] == "failed"]
    passed = [a for a in assertions if a["status"] == "passed"]
    assert len(assertions) == 4, assertions
    assert report["numPendingTests"] == 0, report["numPendingTests"]
    assert report.get("numRuntimeErrorTestSuites", 0) == 0
    assert not report.get("unhandledErrors", [])
    if mode == "baseline":
        assert result.returncode == 1, result.returncode
        assert len(passed) == 2 and len(failed) == 2, (len(passed), len(failed))
        for fragment in ["empty nested object", "legacy dead nested key"]:
            matches = [a for a in failed if fragment in a["fullName"]]
            assert len(matches) == 1, (fragment, failed)
            assert any("expected true to be undefined" in msg for msg in matches[0]["failureMessages"]), matches
    else:
        assert mode == "candidate"
        assert result.returncode == 0, result.returncode
        assert len(passed) == 4 and not failed, (len(passed), len(failed))
    outcome = {
        "source_sha": expected_sha, "mode": mode,
        "status": "REPRODUCED" if mode == "baseline" else "VERIFIED_FIXED",
        "passed": len(passed), "failed": len(failed), "skipped": 0,
        "failed_tests": [a["fullName"] for a in failed],
    }
    (evidence / "outcome.json").write_text(json.dumps(outcome, indent=2))
    print(json.dumps(outcome, indent=2), flush=True)
finally:
    fixture_target.unlink(missing_ok=True)
    tracked_after = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], text=True)
    assert tracked_after == tracked_before, tracked_after
    subprocess.run(["git", "diff", "--check"], check=True)
    identity["tracked_source_unchanged"] = True
    identity["temporary_fixture_removed"] = not fixture_target.exists()
    (evidence / "identity.json").write_text(json.dumps(identity, indent=2))
