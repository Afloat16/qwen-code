import hashlib
import json
import os
import subprocess
from pathlib import Path

repo = Path.cwd()
out = Path(os.environ['RUNNER_TEMP']) / 'qwen17120-r3-baseline'
out.mkdir(parents=True, exist_ok=True)
expected = os.environ['TESTS_SHA']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == expected
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip() == os.environ['TESTS_TREE']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^'], text=True).strip() == '546de1455e62c4187288f0ce77248bf72b393f76'
source = repo / 'packages/cli/src/cli.ts'
original = source.read_bytes()
assert original == subprocess.check_output(['git', 'show', 'HEAD^:packages/cli/src/cli.ts'])
diff_before = subprocess.check_output(['git', 'diff', '--binary', 'HEAD'])
results = {}
unknown = 'runCliEntry rejects unknown prefix options before running MCP commands'
matrix = 'preserves MCP server arguments after global prefix'

def run(label, pattern, expected_passed, expected_failed):
    report_path = out / (label + '.json')
    report_path.unlink(missing_ok=True)
    command = ['corepack', 'pnpm', 'exec', 'vitest', 'run', 'src/cli.test.ts',
               '--testNamePattern=' + pattern, '--maxWorkers=1', '--minWorkers=1',
               '--retry=0', '--reporter=json', '--reporter=default',
               '--outputFile.json=' + str(report_path)]
    done = subprocess.run(command, cwd=repo / 'packages/cli', text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
    (out / (label + '.log')).write_text(done.stdout)
    print(done.stdout, end='', flush=True)
    report = json.loads(report_path.read_text())
    cases = [item for suite in report['testResults'] for item in suite['assertionResults']]
    failed = [item for item in cases if item['status'] == 'failed']
    result = {
        'exit_code': done.returncode,
        'reported_total': report['numTotalTests'],
        'passed': report['numPassedTests'], 'failed': report['numFailedTests'],
        'filtered': report['numPendingTests'],
        'executed': report['numPassedTests'] + report['numFailedTests'],
        'failures': [{'name': item['fullName'], 'messages': item['failureMessages']} for item in failed],
        'passed_names': [item['fullName'] for item in cases if item['status'] == 'passed'],
        'runtime_error_suites': report.get('numRuntimeErrorTestSuites', 0),
    }
    results[label] = result
    print(label + ': ' + json.dumps(result), flush=True)
    assert result['passed'] == expected_passed and result['failed'] == expected_failed, result
    assert result['runtime_error_suites'] == 0, result
    assert done.returncode == (1 if expected_failed else 0), result
    assert all('AssertionError' in '\n'.join(item['failureMessages']) for item in failed), result
    if label == 'unknown-prefix-baseline':
        assert failed[0]['fullName'] == unknown, result
        assert 'Usage: qwen mcp' in '\n'.join(failed[0]['failureMessages']), result
    if label == 'numeric-guard-removed':
        assert all(matrix in item['fullName'] for item in failed), result
        assert all('0x10' in '\n'.join(item['failureMessages']) and '16' in '\n'.join(item['failureMessages']) for item in failed), result

try:
    run('unknown-prefix-baseline', unknown, 0, 1)
    run('numeric-baseline', matrix, 8, 0)
    needle = "        'parse-positional-numbers': false,\n"
    text = original.decode()
    assert text.count(needle) == 1
    source.write_text(text.replace(needle, '', 1))
    run('numeric-guard-removed', matrix, 1, 7)
finally:
    source.write_bytes(original)
    restored = {
        'source_sha256_before': hashlib.sha256(original).hexdigest(),
        'source_sha256_after': hashlib.sha256(source.read_bytes()).hexdigest(),
        'source_restored': source.read_bytes() == original,
        'tracked_diff_restored': subprocess.check_output(['git', 'diff', '--binary', 'HEAD']) == diff_before,
    }
    (out / 'baseline-results.json').write_text(json.dumps({
        'tests_sha': expected, 'production_sha': '546de1455e62c4187288f0ce77248bf72b393f76',
        'results': results, **restored,
    }, indent=2) + '\n')
    assert restored['source_restored'] and restored['tracked_diff_restored']
run('numeric-restored', matrix, 8, 0)
final = {'tests_sha': expected, 'production_sha': '546de1455e62c4187288f0ce77248bf72b393f76', 'results': results, **restored}
(out / 'baseline-results.json').write_text(json.dumps(final, indent=2) + '\n')
print('BASELINE_REPORT ' + json.dumps(final), flush=True)
subprocess.run(['git', 'diff', '--exit-code'], check=True)
