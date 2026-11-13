import hashlib
import json
import os
import subprocess
from pathlib import Path

repo = Path.cwd()
cli = repo / 'packages/cli'
verification = Path(__file__).resolve().parent
out = Path(os.environ['RUNNER_TEMP']) / 'qwen-r2-validation'
out.mkdir(parents=True, exist_ok=True)
candidate = os.environ['CANDIDATE_SHA']
parent = '1c8ea983faf86dbaa0a958741f1c6cd76f8e937d'
expected_total = int(os.environ['EXPECTED_CLI_TEST_COUNT'])
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == candidate
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^'], text=True).strip() == parent

source_path = 'packages/cli/src/cli.ts'
source = repo / source_path
original = source.read_bytes()
original_text = original.decode()
separator_test = 'runCliEntry does not interpret positional tokens after mcp -- as global options'
model_test = 'runCliEntry rejects default-command options before an MCP subcommand'
unknown_test = 'runCliEntry rejects unknown prefix options before running MCP commands'
results = {}


def run_tests(label, failed_names=()):
    report_path = out / (label + '.json')
    command = [
        'corepack', 'pnpm', 'exec', 'vitest', 'run', 'src/cli.test.ts',
        '--maxWorkers=1', '--minWorkers=1', '--retry=0',
        '--reporter=json', '--outputFile=' + str(report_path),
    ]
    completed = subprocess.run(command, cwd=cli, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, timeout=900)
    (out / (label + '.log')).write_text(completed.stdout)
    print(completed.stdout, end='', flush=True)
    report = json.loads(report_path.read_text())
    assertions = [item for suite in report['testResults'] for item in suite['assertionResults']]
    result = {
        'exit_code': completed.returncode,
        'total': report['numTotalTests'],
        'passed': report['numPassedTests'],
        'failed': report['numFailedTests'],
        'pending': report['numPendingTests'],
        'failed_names': sorted(item['fullName'] for item in assertions if item['status'] == 'failed'),
        'help_case_names': [item['fullName'] for item in assertions
                            if 'prints MCP help without executing a subcommand:' in item['fullName']],
    }
    results[label] = result
    print(label + ': ' + json.dumps(result), flush=True)
    assert result['exit_code'] == (1 if failed_names else 0), result
    assert result['total'] == expected_total, result
    assert result['passed'] == expected_total - len(failed_names), result
    assert result['failed'] == len(failed_names), result
    assert result['pending'] == 0, result
    assert result['failed_names'] == sorted(failed_names), result


def run_isolated(label, mode, expected):
    command = [
        'python3', str(verification / 'run-isolated-cli.py'),
        '--repo', str(repo), '--mode', mode, '--phase', label,
        '--expect', expected, '--evidence', str(out),
    ]
    completed = subprocess.run(command, cwd=repo, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, timeout=400)
    (out / (label + '.log')).write_text(completed.stdout)
    print(completed.stdout, end='', flush=True)
    report = json.loads((out / (label + '-observations.json')).read_text())
    results[label] = {
        'exit_code': completed.returncode,
        'mode': mode,
        'case_count': len(report['observations']),
        'expected_separator_behavior': expected,
        'checks_passed': report.get('checks_passed', False),
        'home_env_unchanged': report['home_env_unchanged'],
        'source_unchanged': report['source_unchanged'],
    }
    assert completed.returncode == 0, results[label]
    assert report['checks_passed'] and report['home_env_unchanged'] and report['source_unchanged']
    assert len(report['observations']) == 3


try:
    run_tests('candidate-cli')
    run_isolated('candidate-bundle', 'bundle', 'preserved')

    source.write_bytes(subprocess.check_output(['git', 'show', parent + ':' + source_path]))
    run_tests('parent-dispatch-source', [separator_test])
    run_isolated('parent-source', 'source', 'deleted')

    guard = '    !hasSeparator &&\n'
    assert original_text.count(guard) == 1
    source.write_text(original_text.replace(guard, '', 1))
    run_tests('mutation-separator-guard', [separator_test])

    strict = '      .strictOptions()\n'
    assert original_text.count(strict) == 1
    source.write_text(original_text.replace(strict, '', 1))
    run_tests('mutation-prefix-strict-options', [unknown_test, model_test])

    source.write_bytes(original)
    run_tests('restored-candidate-cli')
finally:
    source.write_bytes(original)
    assert source.read_bytes() == original
    (out / 'verification-results.json').write_text(json.dumps({
        'candidate': candidate,
        'parent': parent,
        'candidate_dispatch_sha256': hashlib.sha256(original).hexdigest(),
        'restored_dispatch_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'counterfactual_scope': 'Only packages/cli/src/cli.ts is restored to the parent; the new candidate tests stay unchanged.',
        'results': results,
    }, indent=2) + '\n')

subprocess.run(['git', 'diff', '--exit-code'], check=True)
print('Restored exact candidate source after parent and mutation comparisons.', flush=True)
