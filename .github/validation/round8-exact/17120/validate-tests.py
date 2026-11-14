import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

repo = Path.cwd()
out = Path(os.environ['RUNNER_TEMP']) / 'qwen17120-r4-validation'
out.mkdir(parents=True, exist_ok=True)
candidate = os.environ['CANDIDATE_SHA']
parent = '40978fcaae8aed6cbc67bc4c11e46b099a4450bd'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == candidate
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip() == 'a2f4efec0b37e4c921381684bd214a8fb8793fad'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^'], text=True).strip() == parent
source = repo / 'packages/cli/src/commands/mcp/add.ts'
original = source.read_bytes()
diff_before = subprocess.check_output(['git', 'diff', '--binary', 'HEAD'])
assert diff_before == b''
tests = ['packages/cli/src/cli.test.ts', 'packages/cli/src/commands/mcp/add.test.ts']
test_hashes = {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in tests}
pattern = 'should handle unknown options as MCP server args|should handle MCP server args with -- separator|should still reject invalid MCP options'
results = {}

def run(label, passed, failed, selection=None):
    path = out / (label + '.json')
    path.unlink(missing_ok=True)
    command = ['corepack', 'pnpm', 'exec', 'vitest', 'run', 'src/cli.test.ts', 'src/commands/mcp/add.test.ts', '--maxWorkers=1', '--minWorkers=1', '--retry=0', '--reporter=json', '--reporter=default', '--outputFile.json=' + str(path)]
    if selection:
        command.append('--testNamePattern=' + selection)
    done = subprocess.run(command, cwd=repo / 'packages/cli', text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=900)
    (out / (label + '.log')).write_text(done.stdout)
    print(done.stdout, end='', flush=True)
    report = json.loads(path.read_text())
    assertions = [item for suite in report['testResults'] for item in suite['assertionResults']]
    failures = [item for item in assertions if item['status'] == 'failed']
    item = {
        'exit_code': done.returncode,
        'total': report['numTotalTests'],
        'passed': report['numPassedTests'],
        'failed': report['numFailedTests'],
        'filtered': report['numPendingTests'],
        'runtime_error_suites': report.get('numRuntimeErrorTestSuites', 0),
        'failures': [{'name': entry['fullName'], 'messages': entry['failureMessages']} for entry in failures],
        'by_file': [{'file': suite['name'], 'passed': sum(entry['status'] == 'passed' for entry in suite['assertionResults']), 'failed': sum(entry['status'] == 'failed' for entry in suite['assertionResults'])} for suite in report['testResults']],
    }
    results[label] = item
    print('TEST_RESULT ' + label + ' ' + json.dumps(item), flush=True)
    assert item['total'] == 201, item
    assert item['passed'] == passed and item['failed'] == failed, item
    assert item['filtered'] == 201 - passed - failed, item
    assert item['runtime_error_suites'] == 0, item
    clean = re.sub(r'\x1b\[[0-9;]*m', '', done.stdout)
    assert not any(marker in clean for marker in ['Unhandled Errors', 'Unhandled Rejection', 'Uncaught Exception']), item
    assert done.returncode == (1 if failed else 0), item
    assert all('AssertionError' in '\n'.join(entry['failureMessages']) for entry in failures), item

try:
    run('candidate-cli-and-add', 201, 0)
    source.write_bytes(subprocess.check_output(['git', 'show', parent + ':packages/cli/src/commands/mcp/add.ts']))
    run('parent-production-new-tests', 5, 3, pattern)
finally:
    source.write_bytes(original)
    restored = {
        'source_sha256_before': hashlib.sha256(original).hexdigest(),
        'source_sha256_after': hashlib.sha256(source.read_bytes()).hexdigest(),
        'source_restored': source.read_bytes() == original,
        'test_hashes_before': test_hashes,
        'test_hashes_after': {name: hashlib.sha256((repo / name).read_bytes()).hexdigest() for name in tests},
        'tracked_diff_restored': subprocess.check_output(['git', 'diff', '--binary', 'HEAD']) == diff_before,
    }
    (out / 'verification-results.json').write_text(json.dumps({'source': candidate, 'results': results, **restored}, indent=2) + '\n')
    assert restored['source_restored'] and restored['tracked_diff_restored']
    assert restored['test_hashes_before'] == restored['test_hashes_after']
run('restored-targeted', 8, 0, pattern)
report = {'source': candidate, 'results': results, **restored}
(out / 'verification-results.json').write_text(json.dumps(report, indent=2) + '\n')
print('CANDIDATE_REPORT ' + json.dumps(report), flush=True)
