import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../index.js';
import { loadSettings, type Settings } from '../../settings.js';
import {
  isFolderTrustEnabled,
  resetTrustedFoldersForTesting,
} from '../../trustedFolders.js';
import { resetHomeEnvBootstrapForTesting } from '../../environment.js';
import { readDaemonTrustPolicySnapshot } from '../../daemon-trust-policy.js';
import {
  loadServeFastPathSettings,
  resetServeFastPathHomeEnvBootstrapForTesting,
} from '../../../serve/fast-path-settings.js';

let taskDir: string;
let workspace: string;
let userSettings: string;

beforeEach(() => {
  expect(existsSync(join(homedir(), '.env'))).toBe(false);
  expect(existsSync(join(homedir(), '.qwen', '.env'))).toBe(false);
  taskDir = mkdtempSync(join(tmpdir(), 'qwen-17123-r2-readers-'));
  workspace = join(taskDir, 'workspace');
  const qwenHome = join(taskDir, 'config');
  mkdirSync(workspace);
  mkdirSync(qwenHome);
  userSettings = join(qwenHome, 'settings.json');
  vi.stubEnv('QWEN_HOME', qwenHome);
  vi.stubEnv('QWEN_RUNTIME_DIR', join(taskDir, 'runtime'));
  vi.stubEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', join(taskDir, 'system.json'));
  vi.stubEnv('QWEN_CODE_SYSTEM_DEFAULTS_PATH', join(taskDir, 'defaults.json'));
  vi.stubEnv('QWEN_CODE_TRUSTED_FOLDERS_PATH', join(taskDir, 'trusted.json'));
  writeFileSync(join(taskDir, 'system.json'), '{}');
  writeFileSync(join(taskDir, 'defaults.json'), '{}');
  writeFileSync(join(taskDir, 'trusted.json'), '{}');
  resetHomeEnvBootstrapForTesting();
  resetServeFastPathHomeEnvBootstrapForTesting();
  resetTrustedFoldersForTesting();
});

afterEach(() => {
  resetHomeEnvBootstrapForTesting();
  resetServeFastPathHomeEnvBootstrapForTesting();
  resetTrustedFoldersForTesting();
  vi.unstubAllEnvs();
  if (taskDir) rmSync(taskDir, { recursive: true, force: true });
});

const cases: Array<{
  name: string;
  input: Record<string, unknown>;
  enabled: boolean;
  fastEnabled: boolean | undefined;
}> = [
  {
    name: 'empty nested object',
    input: { security: { folderTrust: {} }, folderTrustFeature: true },
    enabled: false,
    fastEnabled: undefined,
  },
  {
    name: 'legacy dead nested key',
    input: {
      security: { folderTrust: { featureEnabled: true } },
      folderTrustFeature: true,
    },
    enabled: false,
    fastEnabled: undefined,
  },
  {
    name: 'alias-only control',
    input: { folderTrustFeature: true },
    enabled: true,
    fastEnabled: true,
  },
  {
    name: 'explicit nested false control',
    input: {
      security: { folderTrust: { enabled: false } },
      folderTrustFeature: true,
    },
    enabled: false,
    fastEnabled: false,
  },
];

describe('R2-1 independent real reader agreement', () => {
  it.each(cases)('$name', async ({ name, input, enabled, fastEnabled }) => {
    writeFileSync(userSettings, JSON.stringify(input));
    const original = readFileSync(userSettings, 'utf8');
    const fast = loadServeFastPathSettings(workspace);
    const daemon = await readDaemonTrustPolicySnapshot();
    const migrated = runMigrations(input, 'User');
    const migrationEnabled = isFolderTrustEnabled(migrated.settings as Settings);
    const beforeLoader = readFileSync(userSettings, 'utf8');
    const loaded = loadSettings(workspace);
    const loadedEnabled = isFolderTrustEnabled(loaded.merged);
    const persisted = JSON.parse(readFileSync(userSettings, 'utf8'));

    const evidenceDir = process.env['QWEN_R7_READER_EVIDENCE_DIR'];
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        join(evidenceDir, name.replaceAll(' ', '-') + '.json'),
        JSON.stringify(
          {
            name,
            input,
            expected: { enabled, fastEnabled: fastEnabled ?? null },
            actual: {
              fastEnabled: fast.security?.folderTrust?.enabled ?? null,
              daemonEnabled: daemon.folderTrustEnabled,
              daemonError: daemon.settingsError ?? null,
              migrationEnabled,
              loadedEnabled,
              migrated: migrated.settings,
              persisted,
            },
            priorReadersPreservedFile: original === beforeLoader,
          },
          null,
          2,
        ),
      );
    }

    expect(beforeLoader).toBe(original);
    expect(daemon.settingsError).toBeUndefined();
    expect(daemon.folderTrustEnabled).toBe(enabled);
    expect(migrationEnabled).toBe(enabled);
    expect(loadedEnabled).toBe(enabled);
    expect(fast.security?.folderTrust?.enabled).toBe(fastEnabled);
  });
});
