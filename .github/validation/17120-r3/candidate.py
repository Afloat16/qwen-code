import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

repo = Path.cwd()
out = Path(os.environ['RUNNER_TEMP']) / 'qwen17120-r3-validation'
out.mkdir(parents=True, exist_ok=True)
candidate = os.environ['CANDIDATE_SHA']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == candidate
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip() == os.environ['CANDIDATE_TREE']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^'], text=True).strip() == '546de1455e62c4187288f0ce77248bf72b393f76'
source = repo / 'packages/cli/src/cli.ts'
add_source = repo / 'packages/cli/src/commands/mcp/add.ts'
original = source.read_bytes()
add_original = add_source.read_bytes()
text = original.decode()
add_text = add_original.decode()
diff_before = subprocess.check_output(['git', 'diff', '--binary', 'HEAD'])
unknown = 'runCliEntry rejects unknown prefix options before running MCP commands'
matrix = 'preserves MCP server arguments after global prefix'
add_case = 'mcp add command should add a stdio server to user settings by default'
results = {}

def run(label, expected_passed, expected_failed, pattern=None):
    report_path = out / (label + '.json')
    report_path.unlink(missing_ok=True)
    command = ['corepack', 'pnpm', 'exec', 'vitest', 'run', 'src/cli.test.ts', 'src/commands/mcp/add.test.ts',
               '--maxWorkers=1', '--minWorkers=1', '--retry=0',
               '--reporter=json', '--reporter=default', '--outputFile.json=' + str(report_path)]
    if pattern:
        command.append('--testNamePattern=' + pattern)
    done = subprocess.run(command, cwd=repo / 'packages/cli', text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=900)
    (out / (label + '.log')).write_text(done.stdout)
    print(done.stdout, end='', flush=True)
    report = json.loads(report_path.read_text())
    assertions = [item for suite in report['testResults'] for item in suite['assertionResults']]
    failed = [item for item in assertions if item['status'] == 'failed']
    result = {
        'exit_code': done.returncode, 'reported_total': report['numTotalTests'],
        'executed': report['numPassedTests'] + report['numFailedTests'],
        'passed': report['numPassedTests'], 'failed': report['numFailedTests'],
        'filtered': report['numPendingTests'],
        'failures': [{'name': item['fullName'], 'messages': item['failureMessages']} for item in failed],
        'runtime_error_suites': report.get('numRuntimeErrorTestSuites', 0),
        'by_file': [{'file': suite['name'], 'passed': sum(item['status'] == 'passed' for item in suite['assertionResults']), 'failed': sum(item['status'] == 'failed' for item in suite['assertionResults']), 'filtered': sum(item['status'] in ('pending', 'skipped') for item in suite['assertionResults'])} for suite in report['testResults']],
    }
    results[label] = result
    print(label + ': ' + json.dumps(result), flush=True)
    assert result['reported_total'] == 195, result
    assert result['passed'] == expected_passed and result['failed'] == expected_failed, result
    assert result['filtered'] == 195 - expected_passed - expected_failed, result
    assert result['runtime_error_suites'] == 0, result
    clean_output = re.sub(r'\x1b\[[0-9;]*m', '', done.stdout)
    assert not any(marker in clean_output for marker in ['Unhandled Errors', 'Unhandled Rejection', 'Uncaught Exception']), result
    assert done.returncode == (1 if expected_failed else 0), result
    assert all('AssertionError' in '\n'.join(item['failureMessages']) for item in failed), result
    if label == 'help-call-removed':
        assert failed[0]['fullName'] == unknown, result
        assert 'Usage: qwen mcp' in '\n'.join(failed[0]['failureMessages']), result
    if label == 'real-add-string-declaration-removed':
        assert failed[0]['fullName'] == add_case, result
        assert '0x10' in '\n'.join(failed[0]['failureMessages']) and '16' in '\n'.join(failed[0]['failureMessages']), result
    if label == 'numeric-guard-removed':
        assert all(matrix in item['fullName'] for item in failed), result
        assert all('0x10' in '\n'.join(item['failureMessages']) and '16' in '\n'.join(item['failureMessages']) for item in failed), result

try:
    run('candidate-cli-and-add', 195, 0)
    bundle = subprocess.run(['python3', str(Path(__file__).with_name('bundle.py'))], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=300)
    (out / 'bundle.log').write_text(bundle.stdout)
    print(bundle.stdout, end='', flush=True)
    assert bundle.returncode == 0
    results['bundle'] = json.loads((out / 'bundle-observations.json').read_text())
    assert results['bundle']['checks_passed'] and len(results['bundle']['observations']) == 3
    help_call = "        writeStderrLine(message || error?.message || 'Unknown argument error');\n        printMcpHelp();\n"
    assert text.count(help_call) == 1
    source.write_text(text.replace(help_call, "        writeStderrLine(message || error?.message || 'Unknown argument error');\n", 1))
    run('help-call-removed', 0, 1, unknown)
    numeric_guard = "        'parse-positional-numbers': false,\n"
    assert text.count(numeric_guard) == 1
    source.write_text(text.replace(numeric_guard, '', 1))
    run('numeric-guard-removed', 1, 7, matrix)
    source.write_bytes(original)
    string_declaration = "      .positional('args', { type: 'string', array: true })\n"
    assert add_text.count(string_declaration) == 1
    add_source.write_text(add_text.replace(string_declaration, '', 1))
    run('real-add-string-declaration-removed', 0, 1, add_case)
finally:
    source.write_bytes(original)
    add_source.write_bytes(add_original)
    restored = {
        'source_sha256_before': hashlib.sha256(original).hexdigest(),
        'source_sha256_after': hashlib.sha256(source.read_bytes()).hexdigest(),
        'source_restored': source.read_bytes() == original,
        'add_sha256_before': hashlib.sha256(add_original).hexdigest(),
        'add_sha256_after': hashlib.sha256(add_source.read_bytes()).hexdigest(),
        'add_source_restored': add_source.read_bytes() == add_original,
        'tracked_diff_restored': subprocess.check_output(['git', 'diff', '--binary', 'HEAD']) == diff_before,
    }
    (out / 'verification-results.json').write_text(json.dumps({'candidate': candidate, 'results': results, **restored}, indent=2) + '\n')
    assert restored['source_restored'] and restored['add_source_restored'] and restored['tracked_diff_restored']
run('restored-targeted', 10, 0, unknown + '|' + matrix + '|' + add_case)
report = {'candidate': candidate, 'results': results, **restored}
(out / 'verification-results.json').write_text(json.dumps(report, indent=2) + '\n')
print('CANDIDATE_REPORT ' + json.dumps(report), flush=True)
subprocess.run(['git', 'diff', '--exit-code'], check=True)
