import json
import os
import shutil
import subprocess
from pathlib import Path

repo = Path.cwd()
cli = repo / 'packages/cli'
out = Path(os.environ['RUNNER_TEMP']) / 'qwen-r1-3-validation'
out.mkdir(parents=True, exist_ok=True)
candidate = os.environ['CANDIDATE_SHA']
parent = '9fe37b8653a312b200f95b8d57cca763d414e025'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == candidate
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^'], text=True).strip() == parent

fixture_rel = 'src/config/migration/versions/round6-alias-real-readers.test.ts'
fixture = cli / fixture_rel
fixture_source = Path(__file__).with_name('qwen17123-alias-real-readers.test.ts')
assert not fixture.exists()
production_paths = [
    'packages/cli/src/config/migration/versions/v1-to-v2.ts',
    'packages/cli/src/serve/fast-path-settings.ts',
]
original = {name: (repo / name).read_bytes() for name in production_paths}
results = {}


def run_tests(name, files, total, failed):
    evidence_dir = out / name
    evidence_dir.mkdir()
    env = {**os.environ, 'QWEN_R1_3_EVIDENCE_DIR': str(evidence_dir)}
    report_file = out / (name + '.json')
    command = [
        'corepack', 'pnpm', 'exec', 'vitest', 'run', *files,
        '--maxWorkers=1', '--minWorkers=1', '--retry=0',
        '--reporter=json', '--outputFile=' + str(report_file),
    ]
    completed = subprocess.run(
        command, cwd=cli, env=env, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, timeout=900,
    )
    (out / (name + '.log')).write_text(completed.stdout)
    print(completed.stdout, end='', flush=True)
    report = json.loads(report_file.read_text())
    result = {
        'exit_code': completed.returncode,
        'total': report['numTotalTests'],
        'passed': report['numPassedTests'],
        'failed': report['numFailedTests'],
        'pending': report['numPendingTests'],
        'failed_names': [
            item['fullName'] for suite in report['testResults']
            for item in suite['assertionResults'] if item['status'] == 'failed'
        ],
    }
    results[name] = result
    print(name + ': ' + json.dumps(result), flush=True)
    assert result['exit_code'] == (1 if failed else 0), result
    assert result['total'] == total, result
    assert result['failed'] == failed, result
    assert result['passed'] == total - failed, result
    assert result['pending'] == 0, result
    return evidence_dir


try:
    shutil.copyfile(fixture_source, fixture)
    run_tests('candidate-focused', [
        'src/config/migration/versions/v1-to-v2.test.ts',
        'src/serve/fast-path.test.ts',
        'src/config/daemon-trust-policy.test.ts',
        fixture_rel,
    ], int(os.environ['EXPECTED_FOCUSED_TEST_COUNT']), 0)

    for name in production_paths:
        (repo / name).write_bytes(subprocess.check_output(['git', 'show', parent + ':' + name]))
    baseline_dir = run_tests('parent-real-readers', [fixture_rel], 4, 4)
    chain = json.loads((baseline_dir / 'chain.json').read_text())
    fast_path = json.loads((baseline_dir / 'fast-path.json').read_text())
    daemon = json.loads((baseline_dir / 'daemon.json').read_text())
    loaded = json.loads((baseline_dir / 'load-settings.json').read_text())
    assert chain['enabled'] == 'false' and chain['type'] == 'string'
    assert fast_path['error'] == 'Serve fast path settings folderTrustFeature must be a boolean.'
    assert daemon['snapshot']['settingsError']['code'] == 'trust_policy_invalid'
    assert loaded['enabled'] == 'false'
    assert loaded['persisted']['security']['folderTrust']['enabled'] == 'false'

    for name, content in original.items():
        (repo / name).write_bytes(content)
    run_tests('restored-candidate-real-readers', [fixture_rel], 4, 0)
finally:
    for name, content in original.items():
        (repo / name).write_bytes(content)
    fixture.unlink(missing_ok=True)
    (out / 'verification-results.json').write_text(json.dumps({
        'candidate': candidate,
        'parent': parent,
        'results': results,
    }, indent=2) + '\n')

subprocess.run(['git', 'diff', '--exit-code'], check=True)
assert all((repo / name).read_bytes() == content for name, content in original.items())
print('Restored exact candidate source after the parent comparison.', flush=True)
