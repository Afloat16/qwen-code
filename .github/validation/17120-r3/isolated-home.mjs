import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const root = process.env.QWEN_MCP_PROBE_ROOT;
assert(root && path.isAbsolute(root), 'The fixture root must be explicit');
assert(fs.statSync(root).isDirectory(), 'The fixture root must already exist');
for (const key of ['QWEN_HOME', 'QWEN_RUNTIME_DIR', 'QWEN_CODE_SYSTEM_SETTINGS_PATH', 'QWEN_CODE_SYSTEM_DEFAULTS_PATH']) {
  const value = process.env[key];
  assert(value && path.resolve(value).startsWith(path.resolve(root) + path.sep), `${key} must stay in the fixture tree`);
}
const originalHome = process.env.HOME;
// Test-only storage boundary: keep legacy .env/config lookups in the fixture.
// HOME itself is neither assigned nor deleted, and CLI parsing is untouched.
os.homedir = () => path.join(root, 'os-home');
syncBuiltinESMExports();
assert.equal(process.env.HOME, originalHome);
assert.equal(process.env.QWEN_CODE_FORCE_FILE_STORAGE, 'true');
assert.equal(process.env.QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE, 'false');
process.stderr.write('MCP_PROBE_ISOLATION home_env_unchanged=true config_and_legacy_home_are_temporary=true\n');
