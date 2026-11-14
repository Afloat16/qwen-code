import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

repo = Path.cwd()
out = Path(os.environ['RUNNER_TEMP']) / 'qwen17120-r4-validation'
out.mkdir(parents=True, exist_ok=True)
preload = Path(__file__).with_name('isolated-home.mjs').resolve()
entry = repo / 'dist/cli.js'
assert preload.is_file() and entry.is_file()
candidate = os.environ['CANDIDATE_SHA']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == candidate
parent_home = os.environ.get('HOME')
before_diff = subprocess.check_output(['git', 'diff', '--binary', 'HEAD'])
assert before_diff == b''
server = 'round8-server'
tails = [
    ('args-separated', ['run', 'image', '--args', 'value'], ['run', 'image', '--args', 'value'], None),
    ('args-equals', ['run', 'image', '--args=value', 'img'], ['run', 'image', '--args=value', 'img'], None),
    ('similar-name', ['run', 'image', '--argsNote', 'x'], ['run', 'image', '--argsNote', 'x'], None),
    ('serverArgs-collision', ['run', 'image', '--serverArgs', 'value'], ['run', 'image', '--serverArgs', 'value'], None),
    ('server-args-collision', ['run', 'image', '--server-args', 'value'], ['run', 'image', '--server-args', 'value'], None),
    ('numeric-literals', ['0x10', '1e3', '007'], ['0x10', '1e3', '007'], None),
    ('timeout-number', ['run', 'image', '--timeout', '1500'], ['run', 'image'], 1500),
    ('separator-data', ['run', 'image', '--', '--args', '0x10', '--timeout', '1500'], ['run', 'image', '--args', '0x10', '--timeout', '1500'], None),
    ('empty-args', [], [], None),
]
cases = []
for index, (label, tail, expected, timeout) in enumerate(tails):
    prefix = ['--debug'] if index % 2 else []
    cases.append({'name': label, 'argv': ['mcp', *prefix, 'add', server, 'docker', *tail], 'args': expected, 'timeout': timeout, 'exit': 0})
cases.extend([
    {'name': 'unknown-prefix', 'argv': ['mcp', '--deubg', 'list'], 'exit': 1, 'stderr': 'Unknown argument: deubg', 'stdout': 'Usage: qwen mcp'},
    {'name': 'missing-command', 'argv': ['mcp', 'add', server], 'exit': 1, 'stderr': 'Not enough non-option arguments'},
    {'name': 'invalid-transport', 'argv': ['mcp', 'add', server, 'docker', '--transport', 'invalid'], 'exit': 1, 'stderr': 'Invalid values'},
    {'name': 'normal-list', 'argv': ['mcp', 'list'], 'exit': 0, 'stdout': 'No MCP servers configured.'},
])

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

observations = []
for case in cases:
    with tempfile.TemporaryDirectory(prefix='mcp-r4-', dir=repo.parent) as temp:
        root = Path(temp)
        config, workspace = root / 'config', root / 'workspace'
        for directory in [config, workspace, root / 'os-home/.qwen', root / 'runtime', root / 'tmp', root / 'system']:
            directory.mkdir(parents=True, exist_ok=True)
        for path in [config / '.env', workspace / '.env', root / 'os-home/.env', root / 'os-home/.qwen/.env']:
            path.write_text('')
        settings, tokens = config / 'settings.json', config / 'mcp-oauth-tokens.json'
        settings.write_text(json.dumps({'$version': 4, 'mcpServers': {}, 'security': {'folderTrust': {'enabled': False}}}, indent=2) + '\n')
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
        done = subprocess.run([shutil.which('node'), str(entry), *case['argv']], cwd=workspace, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
        after = {'settings': json.loads(settings.read_text()), 'settings_sha256': digest(settings), 'tokens_sha256': digest(tokens)}
        item = {**case, 'exit_code': done.returncode, 'stdout_actual': done.stdout, 'stderr_actual': done.stderr, 'before': before, 'after': after}
        observations.append(item)
        (out / ('bundle-' + case['name'] + '.json')).write_text(json.dumps(item, indent=2) + '\n')
        print('BUNDLE_CASE ' + json.dumps(item), flush=True)
        assert done.returncode == case['exit'], item
        assert before['tokens_sha256'] == after['tokens_sha256'], item
        if 'args' in case:
            saved = after['settings']['mcpServers']
            assert list(saved) == [server], item
            assert saved[server]['command'] == 'docker', item
            assert saved[server]['args'] == case['args'], item
            assert all(type(value) is str for value in saved[server]['args']), item
            assert saved[server].get('timeout') == case['timeout'], item
            if case['timeout'] is not None:
                assert type(saved[server]['timeout']) is int, item
            assert 'added to user settings' in done.stdout, item
        else:
            assert before == after, item
            if 'stderr' in case:
                assert case['stderr'] in done.stderr, item
            if 'stdout' in case:
                assert case['stdout'] in done.stdout, item
report = {
    'source': candidate, 'mode': 'actual built CLI bundle',
    'observations': observations, 'passed': len(observations), 'failed': 0,
    'home_env_unchanged': os.environ.get('HOME') == parent_home,
    'tracked_diff_unchanged': subprocess.check_output(['git', 'diff', '--binary', 'HEAD']) == before_diff,
    'boundary': 'Real bundle entry, MCP parser, handler and settings writer. Temporary config/runtime and child homedir only; HOME is unchanged. Add stores a command but does not launch it.',
}
assert report['home_env_unchanged'] and report['tracked_diff_unchanged']
(out / 'bundle-observations.json').write_text(json.dumps(report, indent=2) + '\n')
print('BUNDLE_REPORT ' + json.dumps(report), flush=True)
