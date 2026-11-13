import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

repo = Path.cwd()
phase = sys.argv[1] if len(sys.argv) > 1 else 'verification'
assert phase in ('baseline', 'verification')
out = Path(os.environ['RUNNER_TEMP']) / ('qwen17120-r3-bundle-baseline' if phase == 'baseline' else 'qwen17120-r3-validation')
out.mkdir(parents=True, exist_ok=True)
preload = Path(__file__).with_name('isolated-home.mjs').resolve()
entry = repo / 'dist/cli.js'
assert preload.is_file() and entry.is_file()
parent_home = os.environ.get('HOME')
before_diff = subprocess.check_output(['git', 'diff', '--binary', 'HEAD'])
observations = []

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

cases = [
    ('unknown-prefix', ['mcp', '--deubg', 'list']),
    ('numeric-server-argument', ['mcp', '--debug', 'add', 'round7-numeric', 'node', '0x10']),
    ('normal-list-control', ['mcp', 'list']),
]
for label, argv in cases:
    with tempfile.TemporaryDirectory(prefix='mcp-r3-', dir=repo.parent) as temp:
        root = Path(temp)
        config = root / 'config'
        workspace = root / 'workspace'
        for directory in [config, workspace, root / 'os-home/.qwen', root / 'runtime', root / 'tmp', root / 'system']:
            directory.mkdir(parents=True, exist_ok=True)
        for path in [config / '.env', workspace / '.env', root / 'os-home/.env', root / 'os-home/.qwen/.env']:
            path.write_text('')
        settings = config / 'settings.json'
        tokens = config / 'mcp-oauth-tokens.json'
        settings.write_text(json.dumps({
            '$version': 4, 'mcpServers': {},
            'security': {'folderTrust': {'enabled': False}},
        }, indent=2) + '\n')
        tokens.write_text('[]\n')
        tokens.chmod(0o600)
        for path in [root / 'system/settings.json', root / 'system/defaults.json']:
            path.write_text('{}\n')
        before = {'settings': json.loads(settings.read_text()), 'settings_sha256': digest(settings), 'tokens_sha256': digest(tokens)}
        env = {key: os.environ[key] for key in ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM'] if key in os.environ}
        env.update({
            'QWEN_MCP_PROBE_ROOT': str(root), 'QWEN_HOME': str(config),
            'QWEN_RUNTIME_DIR': str(root / 'runtime'),
            'QWEN_CODE_SYSTEM_SETTINGS_PATH': str(root / 'system/settings.json'),
            'QWEN_CODE_SYSTEM_DEFAULTS_PATH': str(root / 'system/defaults.json'),
            'QWEN_CODE_FORCE_FILE_STORAGE': 'true', 'QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE': 'false',
            'QWEN_CODE_NO_RELAUNCH': 'true', 'CI': 'true', 'NO_COLOR': '1',
            'TMPDIR': str(root / 'tmp'), 'NODE_OPTIONS': '--import=' + preload.as_uri(),
        })
        assert env.get('HOME') == parent_home
        command = [shutil.which('node'), str(entry), *argv]
        done = subprocess.run(command, cwd=workspace, env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
        after = {'settings': json.loads(settings.read_text()), 'settings_sha256': digest(settings), 'tokens_sha256': digest(tokens)}
        item = {'case': label, 'argv': argv, 'exit_code': done.returncode,
                'stdout': done.stdout, 'stderr': done.stderr, 'before': before, 'after': after}
        observations.append(item)
        (out / ('bundle-' + label + '.log')).write_text(json.dumps(item, indent=2) + '\n')
        print('BUNDLE_CASE ' + json.dumps(item), flush=True)
report = {
    'source': os.environ['CANDIDATE_SHA'], 'phase': phase, 'mode': 'actual built CLI bundle',
    'observations': observations,
    'home_env_unchanged': os.environ.get('HOME') == parent_home,
    'tracked_diff_unchanged': subprocess.check_output(['git', 'diff', '--binary', 'HEAD']) == before_diff,
    'boundary': 'Real bundle entry, MCP parser and settings write. Temporary config/runtime and child homedir only; HOME is unchanged. List fixture has no configured servers and add does not launch the configured command.',
}
(out / 'bundle-observations.json').write_text(json.dumps(report, indent=2) + '\n')
unknown, numeric, normal = observations
assert unknown['exit_code'] == 1, unknown
assert 'Unknown argument: deubg' in unknown['stderr'], unknown
assert ('Usage: qwen mcp' in unknown['stdout']) == (phase == 'verification'), unknown
assert 'No MCP servers configured.' not in unknown['stdout'], unknown
assert unknown['before'] == unknown['after'], unknown
assert numeric['exit_code'] == 0, numeric
assert 'added to user settings' in numeric['stdout'], numeric
servers = numeric['after']['settings']['mcpServers']
assert list(servers) == ['round7-numeric'], numeric
assert servers['round7-numeric']['command'] == 'node', numeric
assert servers['round7-numeric']['args'] == (['0x10'] if phase == 'verification' else ['16']), numeric
assert numeric['before']['tokens_sha256'] == numeric['after']['tokens_sha256'], numeric
assert normal['exit_code'] == 0 and 'No MCP servers configured.' in normal['stdout'], normal
assert normal['after']['settings']['mcpServers'] == {}, normal
assert normal['before']['tokens_sha256'] == normal['after']['tokens_sha256'], normal
assert report['home_env_unchanged'] and report['tracked_diff_unchanged']
report['checks_passed'] = True
(out / 'bundle-observations.json').write_text(json.dumps(report, indent=2) + '\n')
print('BUNDLE_REPORT ' + json.dumps(report), flush=True)
