import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True, type=Path)
parser.add_argument('--mode', choices=['source', 'bundle'], default='source')
parser.add_argument('--phase', required=True)
parser.add_argument('--expect', choices=['preserved', 'deleted'], default='preserved')
parser.add_argument('--evidence', type=Path, default=Path(__file__).parent)
args = parser.parse_args()
repo = args.repo.resolve()
evidence = args.evidence.resolve()
evidence.mkdir(parents=True, exist_ok=True)
preload = Path(__file__).with_name('isolated-home.mjs').resolve()
assert preload.is_file()
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
before_diff = subprocess.check_output(['git', 'diff', '--binary', 'HEAD'], cwd=repo)
entry = repo / ('packages/cli/index.ts' if args.mode == 'source' else 'dist/cli.js')
assert entry.is_file(), str(entry)
node = shutil.which('node')
assert node
parent_home = os.environ.get('HOME')
observations = []

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None

def server_names(path):
    return sorted(json.loads(path.read_text()).get('mcpServers', {}))

def credential_names(path):
    return sorted(item['serverName'] for item in json.loads(path.read_text())) if path.exists() else []

cases = [
    ('explicit-separator-remove', ['mcp', '--', '--safe-mode', 'remove', 'victim'], True),
    ('plain-separator-list', ['mcp', '--', 'list'], False),
    ('direct-remove-control', ['mcp', 'remove', 'victim'], True),
]
for name, argv, with_servers in cases:
    # Keep the pathname below the Unix-domain socket limit used by tsx IPC.
    with tempfile.TemporaryDirectory(prefix='mcp-', dir=repo.parent) as temp:
        root = Path(temp)
        config = root / 'config'
        workspace = root / 'workspace'
        for directory in [config, workspace, root / 'os-home/.qwen', root / 'runtime', root / 'tmp', root / 'system']:
            directory.mkdir(parents=True, exist_ok=True)
        # Blank local/home env files keep discovery in this isolated tree.
        for file in [config / '.env', workspace / '.env', root / 'os-home/.env', root / 'os-home/.qwen/.env']:
            file.write_text('')
        settings = config / 'settings.json'
        tokens = config / 'mcp-oauth-tokens.json'
        servers = {key: {'command': 'node', 'args': [key + '.js']} for key in ['victim', 'sentinel']} if with_servers else {}
        settings.write_text(json.dumps({'mcpServers': servers, 'security': {'folderTrust': {'enabled': False}}}, indent=2) + '\n')
        fake_credentials = [{'serverName': key, 'token': {'accessToken': 'TEST_ONLY_' + key, 'tokenType': 'Bearer'}, 'updatedAt': 1}
                            for key in ['victim', 'sentinel']]
        tokens.write_text(json.dumps(fake_credentials, indent=2) + '\n')
        tokens.chmod(0o600)
        for file in [root / 'system/settings.json', root / 'system/defaults.json']:
            file.write_text('{}\n')
        before = {'settings_sha256': digest(settings), 'tokens_sha256': digest(tokens),
                  'servers': server_names(settings), 'credential_servers': credential_names(tokens),
                  'settings': json.loads(settings.read_text())}
        # Inherit only process basics, not provider credentials or real config routing.
        env = {key: os.environ[key] for key in ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM'] if key in os.environ}
        env.update({
            'QWEN_MCP_PROBE_ROOT': str(root), 'QWEN_HOME': str(config), 'QWEN_RUNTIME_DIR': str(root / 'runtime'),
            'QWEN_MCP_PROBE_REPO': str(repo),
            'QWEN_CODE_SYSTEM_SETTINGS_PATH': str(root / 'system/settings.json'),
            'QWEN_CODE_SYSTEM_DEFAULTS_PATH': str(root / 'system/defaults.json'),
            'QWEN_CODE_FORCE_FILE_STORAGE': 'true', 'QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE': 'false',
            'QWEN_CODE_NO_RELAUNCH': 'true', 'CI': 'true', 'NO_COLOR': '1', 'TMPDIR': str(root / 'tmp'),
            'NODE_OPTIONS': '--import=' + preload.as_uri(),
        })
        assert env.get('HOME') == parent_home
        command = [node]
        if args.mode == 'source':
            command.extend(['--import', str(preload.with_name('register-source.mjs')),
                            '--import', str(repo / 'node_modules/tsx/dist/esm/index.mjs')])
        command.extend([str(entry), *argv])
        result = subprocess.run(command, cwd=workspace, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=90)
        after = {'settings_sha256': digest(settings), 'tokens_sha256': digest(tokens),
                 'servers': server_names(settings), 'credential_servers': credential_names(tokens),
                 'settings': json.loads(settings.read_text())}
        item = {'case': name, 'argv': argv, 'exit_code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr,
                'before': before, 'after': after, 'home_env_unchanged': env.get('HOME') == parent_home,
                'fixture_paths': {'root': str(root), 'settings': str(settings), 'tokens': str(tokens)}}
        observations.append(item)
        (evidence / (args.phase + '-' + name + '.log')).write_text(
            'ARGV ' + json.dumps(argv) + '\nEXIT ' + str(result.returncode) + '\nSTDOUT\n' + result.stdout + '\nSTDERR\n' + result.stderr)
        print(json.dumps(item), flush=True)
assert os.environ.get('HOME') == parent_home
report = {'phase': args.phase, 'mode': args.mode, 'head': head, 'entry': str(entry), 'observations': observations,
          'expected_separator_behavior': args.expect,
          'source_unchanged': before_diff == subprocess.check_output(['git', 'diff', '--binary', 'HEAD'], cwd=repo),
          'home_env_unchanged': os.environ.get('HOME') == parent_home,
          'boundary': 'Actual CLI source/bundle entry and real MCP remove/token-storage code. Only child-process homedir and documented config/runtime paths are isolated. All OAuth data is fake; HOME is unchanged. List control has no configured servers, so no MCP connection is attempted.'}
(evidence / (args.phase + '-observations.json')).write_text(json.dumps(report, indent=2) + '\n')
assert report['source_unchanged']
for item in observations:
    assert item['exit_code'] == 0, (item['case'], item['stderr'])
separator, listing, direct = observations
assert 'No MCP servers configured.' in listing['stdout']
assert listing['before']['servers'] == listing['after']['servers'] == [], listing
assert listing['before']['credential_servers'] == listing['after']['credential_servers'], listing
assert listing['before']['tokens_sha256'] == listing['after']['tokens_sha256'], listing
for item in [direct] + ([separator] if args.expect == 'deleted' else []):
    assert 'Server "victim" removed from user settings.' in item['stdout'], item
    assert item['after']['servers'] == ['sentinel'], item
    assert item['after']['credential_servers'] == ['sentinel'], item
if args.expect == 'preserved':
    assert 'Usage: qwen mcp' in separator['stdout'], separator
    assert separator['before'] == separator['after'], separator
report['checks_passed'] = True
(evidence / (args.phase + '-observations.json')).write_text(json.dumps(report, indent=2) + '\n')
