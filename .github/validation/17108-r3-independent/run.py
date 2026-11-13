import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

repo = Path.cwd()
verification = Path(__file__).resolve().parent
phase = sys.argv[1]
assert phase in ('baseline', 'verification')
out = Path(os.environ['RUNNER_TEMP']) / ('qwen17108-r3-independent-' + phase)
out.mkdir(parents=True, exist_ok=True)
expected = os.environ['SOURCE_SHA']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == expected
assert subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip() == os.environ['SOURCE_TREE']
source_files = [
    'packages/web-shell/client/components/messages/MemoryMessage.tsx',
    'packages/web-shell/client/daemon/workspace/hooks/useDaemonResource.ts',
    'packages/web-shell/client/daemon/workspace/hooks/useDaemonMemory.ts',
    'packages/web-shell/client/daemon/workspace/hooks/useWorkspaceEventReload.ts',
]
def identity():
    return {path: hashlib.sha256((repo / path).read_bytes()).hexdigest() for path in source_files}
before = identity()
diff_before = subprocess.check_output(['git', 'diff', '--binary', 'HEAD'])
target = repo / 'packages/web-shell/client/components/messages/MemoryMessage.round7-independent.test.tsx'
assert not target.exists()
report_path = out / 'tests.json'
report_path.unlink(missing_ok=True)
result = {}
try:
    shutil.copyfile(verification / 'probe.tsx', target)
    command = [
        'corepack', 'pnpm', 'exec', 'vitest', 'run',
        'client/components/messages/MemoryMessage.round7-independent.test.tsx',
        '--maxWorkers=1', '--minWorkers=1', '--retry=0',
        '--reporter=json', '--reporter=default',
        '--outputFile.json=' + str(report_path),
    ]
    completed = subprocess.run(command, cwd=repo / 'packages/web-shell',
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, timeout=300)
    (out / 'tests.log').write_text(completed.stdout)
    print(completed.stdout, end='', flush=True)
    report = json.loads(report_path.read_text())
    assertions = [item for suite in report['testResults'] for item in suite['assertionResults']]
    failed = [item for item in assertions if item['status'] == 'failed']
    result = {
        'phase': phase, 'source': expected, 'command': command,
        'exit_code': completed.returncode,
        'total': report['numTotalTests'],
        'passed': report['numPassedTests'],
        'failed': report['numFailedTests'],
        'pending': report['numPendingTests'],
        'failed_assertions': [{'name': item['fullName'], 'messages': item['failureMessages']} for item in failed],
        'unhandled_errors': report.get('numRuntimeErrorTestSuites', 0),
    }
    expected_failed = 3 if phase == 'baseline' else 0
    assert result['total'] == 5, result
    assert result['pending'] == 0, result
    assert result['failed'] == expected_failed, result
    assert result['passed'] == 5 - expected_failed, result
    assert completed.returncode == (1 if expected_failed else 0), result
    assert result['unhandled_errors'] == 0, result
    if phase == 'baseline':
        assert len([item for item in failed if 'reports the list-load cause' in item['fullName']]) == 1
        assert len([item for item in failed if 'same-path event supersedes' in item['fullName']]) == 2
        assert all('AssertionError' in '\n'.join(item['failureMessages']) for item in failed), result
    result['accepted'] = True
finally:
    target.unlink(missing_ok=True)
    result['source_before'] = before
    result['source_after'] = identity()
    result['source_unchanged'] = before == result['source_after']
    result['tracked_diff_unchanged'] = subprocess.check_output(['git', 'diff', '--binary', 'HEAD']) == diff_before
    result['temporary_test_removed'] = not target.exists()
    (out / 'verification-results.json').write_text(json.dumps(result, indent=2) + '\n')
    print('INDEPENDENT_REPORT ' + json.dumps(result), flush=True)
    assert result['source_unchanged'] and result['tracked_diff_unchanged'] and result['temporary_test_removed']
