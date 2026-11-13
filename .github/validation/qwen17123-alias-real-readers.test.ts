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
import { needsMigration, runMigrations } from '../index.js';
import {
  getSettingsWarnings,
  loadSettings,
  type Settings,
} from '../../settings.js';
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

const input = { folderTrustFeature: 'false' };
let taskDir: string;
let workspace: string;
let userSettings: string;

function record(name: string, result: unknown) {
  const evidenceDir = process.env['QWEN_R1_3_EVIDENCE_DIR'];
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, `${name}.json`), JSON.stringify(result, null, 2));
  }
}

beforeEach(() => {
  expect(existsSync(join(homedir(), '.env'))).toBe(false);
  expect(existsSync(join(homedir(), '.qwen', '.env'))).toBe(false);
  taskDir = mkdtempSync(join(tmpdir(), 'qwen-r1-3-real-readers-'));
  workspace = join(taskDir, 'workspace');
  const qwenHome = join(taskDir, 'config');
  mkdirSync(workspace);
  mkdirSync(qwenHome);
  userSettings = join(qwenHome, 'settings.json');
  vi.stubEnv('QWEN_HOME', qwenHome);
  vi.stubEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', join(taskDir, 'system.json'));
  vi.stubEnv('QWEN_CODE_SYSTEM_DEFAULTS_PATH', join(taskDir, 'defaults.json'));
  vi.stubEnv('QWEN_CODE_TRUSTED_FOLDERS_PATH', join(taskDir, 'trusted.json'));
  writeFileSync(userSettings, JSON.stringify(input));
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

describe('R1-3 actual migration and settings readers', () => {
  it('keeps the invalid alias inert through the complete migration chain', () => {
    const result = runMigrations(input, 'User');
    const enabled = isFolderTrustEnabled(result.settings as Settings);
    record('chain', { input, ...result, enabled, type: typeof enabled });
    expect(enabled).toBe(false);
    expect(result.finalVersion).toBe(4);
    expect(needsMigration(result.settings)).toBe(false);
    expect(result.warnings).toEqual([
      "Ignored legacy setting 'folderTrustFeature' in user settings because the value is not a boolean.",
    ]);
    expect(input).toEqual({ folderTrustFeature: 'false' });
  });

  it('keeps the invalid alias inert in the real fast-path reader', () => {
    let error: string | undefined;
    let settings: ReturnType<typeof loadServeFastPathSettings> | undefined;
    try {
      settings = loadServeFastPathSettings(workspace);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    record('fast-path', { input, settings, error });
    expect(error).toBeUndefined();
    expect(settings?.security?.folderTrust?.enabled ?? false).toBe(false);
  });

  it('keeps the invalid alias inert in the real daemon policy reader', async () => {
    const snapshot = await readDaemonTrustPolicySnapshot();
    record('daemon', { input, snapshot });
    expect(snapshot.folderTrustEnabled).toBe(false);
    expect(snapshot.settingsError).toBeUndefined();
  });

  it('persists a valid migration and exposes its warning through loadSettings', () => {
    const settings = loadSettings(workspace);
    const enabled = isFolderTrustEnabled(settings.merged);
    const warnings = getSettingsWarnings(settings);
    const persisted = JSON.parse(readFileSync(userSettings, 'utf8'));
    record('load-settings', { input, enabled, warnings, persisted });
    expect(enabled).toBe(false);
    expect(persisted.$version).toBe(4);
    expect(persisted.folderTrustFeature).toBeUndefined();
    expect(persisted.security?.folderTrust?.enabled).toBeUndefined();
    expect(warnings).toContain(
      "Warning: Ignored legacy setting 'folderTrustFeature' in user settings because the value is not a boolean.",
    );
    expect(needsMigration(persisted)).toBe(false);
  });
});
