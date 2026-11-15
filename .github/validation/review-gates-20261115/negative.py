import json
import os
import subprocess
from pathlib import Path

source = Path.cwd()
path = 'packages/cli/src/commands/mcp/add.ts'
candidate = source.joinpath(path).read_bytes()
out = Path(os.environ['RUNNER_TEMP']) / 'qwen17120-followup-validation'
out.mkdir(parents=True, exist_ok=True)
report = out / 'parent-control-tests.json'
try:
    source.joinpath(path).write_bytes(subprocess.check_output(['git', 'show', '0011890a48a2e9d1775453d096a4e5c8a1982076:' + path]))
    proc = subprocess.run(['corepack', 'pnpm', 'exec', 'vitest', 'run', 'src/commands/mcp/add.test.ts', '-t', 'reports add validation through the real MCP entry point', '--coverage.enabled=false', '--maxWorkers=2', '--no-file-parallelism', '--reporter=json', '--outputFile=' + str(report)], cwd=source / 'packages/cli', text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (out / 'parent-control.log').write_text(proc.stdout)
    print(proc.stdout)
    assert proc.returncode != 0, 'Parent source unexpectedly passed'
    data = json.loads(report.read_text())
    assert data['numFailedTests'] == 3, data
    assert data['numPassedTests'] == 0, data
    assert data['numFailedTestSuites'] > 0, data
    print('PARENT_CONTROL: all three new entry-point cases failed as expected')
finally:
    source.joinpath(path).write_bytes(candidate)
    assert source.joinpath(path).read_bytes() == candidate
subprocess.run(['git', 'diff', '--exit-code'], check=True)
