import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path.cwd()
evidence = Path(os.environ["RUNNER_TEMP"]) / "qwen17123-r2-independent"
evidence.mkdir(parents=True, exist_ok=True)
paths = [
    "src/serve/fast-path.test.ts",
    "src/config/migration/versions/v1-to-v2.test.ts",
    "src/config/daemon-trust-policy.test.ts",
]
source_files = [
    "packages/cli/src/serve/fast-path-settings.ts",
    "packages/cli/src/serve/fast-path.test.ts",
]
before = {path: hashlib.sha256((root / path).read_bytes()).hexdigest() for path in source_files}
command = ["corepack", "pnpm", "exec", "vitest", "run", *paths,
           "--maxWorkers=1", "--minWorkers=1", "--retry=0",
           "--reporter=default", "--reporter=json",
           "--outputFile.json=" + str(evidence / "committed-report.json")]
result = subprocess.run(command, cwd=root / "packages/cli", text=True,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
(evidence / "committed-tests.log").write_text(result.stdout)
print(result.stdout, flush=True)
report = json.loads((evidence / "committed-report.json").read_text())
tests = [a for f in report["testResults"] for a in f["assertionResults"]]
assert result.returncode == 0, result.returncode
assert len(report["testResults"]) == 3, len(report["testResults"])
for path in paths:
    matching = [f for f in report["testResults"] if f["name"].endswith(path)]
    assert len(matching) == 1 and matching[0]["assertionResults"], path
assert tests and all(a["status"] == "passed" for a in tests)
assert report["numPendingTests"] == 0
assert report.get("numRuntimeErrorTestSuites", 0) == 0
assert not report.get("unhandledErrors", [])
summary = {
    "source_sha": os.environ["SOURCE_SHA"],
    "total": len(tests), "passed": len(tests), "failed": 0, "skipped": 0,
    "files": [{"name": f["name"], "passed": len(f["assertionResults"])} for f in report["testResults"]],
    "source_sha256_before": before,
}
after = {path: hashlib.sha256((root / path).read_bytes()).hexdigest() for path in source_files}
assert after == before
subprocess.run(["git", "diff", "--exit-code"], check=True)
summary["source_sha256_after"] = after
summary["tracked_source_unchanged"] = True
(evidence / "committed-summary.json").write_text(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2), flush=True)
