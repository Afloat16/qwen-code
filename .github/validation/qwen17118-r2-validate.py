#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

repo = Path.cwd()
verification = Path(__file__).resolve().parent
out = Path(os.environ['RUNNER_TEMP']) / 'qwen17118-r2-validation'
out.mkdir(parents=True, exist_ok=True)
candidate = os.environ['CANDIDATE_SHA']
candidate_tree = os.environ['CANDIDATE_TREE']
parent = 'f5a08285854d03543c586e0bfdcc826acc1c32ec'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == candidate
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip() == candidate_tree
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^'], text=True).strip() == parent

source_path = 'packages/cli/src/commands/review/run.ts'
source = repo / source_path
original = source.read_bytes()
original_text = original.decode()
probe_source = verification / 'independent-reserve-probe.test.ts'
probe_target = repo / 'packages/cli/src/commands/review/round6-independent-reserve-probe.test.ts'
probe_relative = 'src/commands/review/round6-independent-reserve-probe.test.ts'
assert not probe_target.exists()
run_file = 'src/commands/review/run.test.ts'
deadline_file = 'src/commands/review/lib/deadline.test.ts'
results = {}
source_hash = hashlib.sha256(original).hexdigest()
assert source_hash == '39de470b0ed907c3295d6ffd860c27f11cd11c796a58ddae520df0a116c07219'
for artifact in [Path(__file__), probe_source]:
    shutil.copyfile(artifact, out / artifact.name)


def run_tests(label, package, tests, passed, failed=0, pending=0, pattern=None, failure_groups=None, extra_env=None):
    report_path = out / (label + '.json')
    command = ['corepack', 'pnpm', 'exec', 'vitest', 'run', *tests,
               '--maxWorkers=1', '--minWorkers=1', '--retry=0',
               '--reporter=default', '--reporter=json', '--outputFile.json=' + str(report_path)]
    if pattern is not None:
        command += ['-t', pattern]
    env = os.environ.copy()
    env.update(extra_env or {})
    completed = subprocess.run(command, cwd=repo/package, env=env, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
    (out/(label+'.log')).write_text(completed.stdout)
    print(completed.stdout, end='', flush=True)
    report = json.loads(report_path.read_text())
    assertions = [a for suite in report['testResults'] for a in suite['assertionResults']]
    failures = [a for a in assertions if a['status'] == 'failed']
    observed = {
        'command': command, 'package': package, 'exit_code': completed.returncode,
        'total': report['numTotalTests'], 'passed': report['numPassedTests'],
        'failed': report['numFailedTests'], 'pending': report['numPendingTests'],
        'failures': [{'name': a['fullName'], 'messages': a['failureMessages']} for a in failures],
    }
    results[label] = observed
    print(label + ': ' + json.dumps(observed), flush=True)
    assert completed.returncode == (1 if failed else 0), observed
    assert (observed['passed'], observed['failed'], observed['pending']) == (passed, failed, pending), observed
    assert observed['total'] == passed + failed + pending, observed
    assert len(failures) == failed, observed
    assert not any(token in completed.stdout for token in ['Test timed out', 'Unhandled Errors', 'Unhandled Rejection']), observed
    if failure_groups:
        for text, expected in failure_groups.items():
            assert sum(text in a['fullName'] for a in failures) == expected, observed
        assert sum(failure_groups.values()) == failed, observed
    if failed:
        assert all(any('AssertionError:' in m for m in a['failureMessages']) for a in failures), observed


def run_probe(label, passed, failed=0):
    assert not probe_target.exists()
    shutil.copyfile(probe_source, probe_target)
    try:
        groups = None if failed == 0 else {
            'replaces an inherited empty reserve': 1,
            'replaces an inherited malformed reserve': 1,
            'warns before spawning': 1,
        }
        run_tests(label, 'packages/cli', [probe_relative], passed, failed,
                  failure_groups=groups,
                  extra_env={'QWEN_17118_PROBE_OUTPUT': str(out/(label+'-observations.json'))})
        observations = json.loads((out/(label+'-observations.json')).read_text())
        assert len(observations) == 5
        assert all(item['parentReserveUnchanged'] for item in observations)
    finally:
        probe_target.unlink(missing_ok=True)


reserve_guard = """    if (
      reserve === undefined ||
      reserve.trim() === '' ||
      !Number.isFinite(Number(reserve)) ||
      Number(reserve) < 0
    ) {"""
mutations = [
    ('absent-only-reserve', reserve_guard, '    if (reserve === undefined) {',
     'replaces the invalid inherited reserve', 0, 6, 90),
    ('warning-removed', 'if (timeoutSeconds < reserveSeconds + DEFAULT_ROUND_SECONDS) {', 'if (false) {',
     'uses environment-free budget estimates', 3, 2, 91),
    ('environment-dependent-warning', 'const reserveSeconds = planReserveSeconds(timeoutSeconds);',
     'const reserveSeconds = planReserveSeconds(timeoutSeconds, process.env);',
     'uses environment-free budget estimates', 4, 1, 91),
    ('reject-equality-boundary', 'if (timeoutSeconds < reserveSeconds + DEFAULT_ROUND_SECONDS) {',
     'if (timeoutSeconds <= reserveSeconds + DEFAULT_ROUND_SECONDS) {',
     'uses environment-free budget estimates', 4, 1, 91),
    ('absent-timeout-90', 'timeoutMinutes: Number.isFinite(timeout) ? Math.max(1, timeout) : 120,',
     'timeoutMinutes: Number.isFinite(timeout) ? Math.max(1, timeout) : 90,',
     'distinguishes parsed absence', 2, 1, 93),
]
try:
    run_tests('candidate-run-deadline', 'packages/cli', [run_file, deadline_file], 206)
    run_tests('candidate-skill', 'packages/core', ['src/skills/bundled/review/SKILL.test.ts'], 79)

    source.write_bytes(subprocess.check_output(['git', 'show', parent + ':' + source_path]))
    run_tests('parent-run-source', 'packages/cli', [run_file], 88, 8, failure_groups={
        'replaces the invalid inherited reserve': 6,
        'short default budget': 1,
        'zero reserve override': 1,
    })
    run_probe('parent-independent', 2, 3)

    for name, old, new, pattern, passed, failed, pending in mutations:
        assert original_text.count(old) == 1, name
        source.write_text(original_text.replace(old, new))
        try:
            run_tests('mutation-' + name, 'packages/cli', [run_file], passed, failed, pending,
                      pattern=pattern, failure_groups={pattern: failed})
        finally:
            source.write_bytes(original)

    source.write_bytes(original)
    run_tests('restored-candidate-run', 'packages/cli', [run_file], 96)
    run_probe('candidate-independent', 5)
finally:
    source.write_bytes(original)
    probe_target.unlink(missing_ok=True)
    restored_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    tracked_clean = subprocess.run(['git', 'diff', '--exit-code'], capture_output=True, text=True).returncode == 0
    (out/'verification-results.json').write_text(json.dumps({
        'candidate': candidate, 'tree': candidate_tree, 'parent': parent,
        'original_source_sha256': source_hash, 'restored_source_sha256': restored_hash,
        'probe_sha256': hashlib.sha256(probe_source.read_bytes()).hexdigest(),
        'source_restored': restored_hash == source_hash, 'tracked_clean': tracked_clean,
        'counterfactual_scope': 'Only run.ts is changed for the parent and mutants; candidate committed tests remain unchanged. All Vitest commands use the standard package configuration and global setup after the full build. The independent fixture controls only the child process and clock.',
        'results': results,
    }, indent=2)+'\n')
    assert restored_hash == source_hash
    assert tracked_clean
print('All exact-candidate, parent, and targeted mutation checks completed; source restored.', flush=True)
