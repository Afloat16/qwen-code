import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPOSE_FLOOR_ENV,
  DEADLINE_ENV,
  DEFAULT_ROUND_SECONDS,
  RESERVE_ENV,
  planReserveSeconds,
  reverseAuditBudgetExhausted,
} from './lib/deadline.js';

const spawnMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: { ...actual, spawn: spawnMock, execFileSync: execFileSyncMock },
    spawn: spawnMock,
    execFileSync: execFileSyncMock,
  };
});
const { runCommand } = await import('./run.js');
const observations: unknown[] = [];
const start = 1_700_000_000_000;
const outputPath = process.env['QWEN_17118_PROBE_OUTPUT'];
let previousCwd: string;
let previousExit: string | number | undefined;
let fixtureDir: string;
let stderr: string[];

class ProbeChild extends EventEmitter {
  pid = 424242;
  stdout = Object.assign(new EventEmitter(), { resume: () => {} });
  stderr = Object.assign(new EventEmitter(), { resume: () => {} });
  kill = vi.fn();
}

beforeEach(() => {
  previousCwd = process.cwd();
  previousExit = process.exitCode;
  fixtureDir = mkdtempSync(join(previousCwd, '17118-probe-'));
  process.chdir(fixtureDir);
  stderr = [];
  vi.useFakeTimers();
  vi.setSystemTime(start);
  vi.stubEnv(DEADLINE_ENV, undefined);
  vi.stubEnv(RESERVE_ENV, undefined);
  vi.stubEnv(COMPOSE_FLOOR_ENV, undefined);
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  spawnMock.mockReset();
  execFileSyncMock.mockReset();
});

afterEach(() => {
  process.exitCode = previousExit;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  process.chdir(previousCwd);
  rmSync(fixtureDir, { recursive: true, force: true });
});

afterAll(() => {
  if (outputPath) writeFileSync(outputPath, JSON.stringify(observations, null, 2));
});

async function observe(label: string, minutes: number, inheritedReserve?: string) {
  vi.stubEnv(RESERVE_ENV, inheritedReserve);
  const child = new ProbeChild();
  let beforeSpawn: string[] = [];
  spawnMock.mockImplementation(() => {
    beforeSpawn = [...stderr];
    return child;
  });
  const pending = (runCommand.handler as (args: unknown) => Promise<void>)({
    comment: false,
    json: true,
    'fail-on': 'none',
    'timeout-minutes': minutes,
    'approval-mode': 'yolo',
    quiet: true,
  });
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const env = spawnMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
  const result = {
    label,
    minutes,
    inheritedReserve,
    exportedReserve: env[RESERVE_ENV],
    exportedDeadline: env[DEADLINE_ENV],
    defaultReserve: planReserveSeconds(minutes * 60),
    defaultRound: DEFAULT_ROUND_SECONDS,
    actualGate: reverseAuditBudgetExhausted(env, DEFAULT_ROUND_SECONDS, start),
    stderrBeforeSpawn: beforeSpawn.join(''),
    parentReserveUnchanged: process.env[RESERVE_ENV] === inheritedReserve,
  };
  observations.push(result);
  child.emit('close', 0, null);
  await pending;
  expect(result.parentReserveUnchanged).toBe(true);
  return result;
}

describe('independent reserve and default-budget observations', () => {
  it('replaces an inherited empty reserve for an explicit 100-minute run', async () => {
    const result = await observe('empty-reserve-100', 100, '');
    expect(result.exportedReserve).toBe('2000');
    expect(result.actualGate).toBeNull();
  });

  it('replaces an inherited malformed reserve for an explicit 120-minute run', async () => {
    const result = await observe('invalid-reserve-120', 120, 'invalid');
    expect(result.exportedReserve).toBe('2400');
  });

  it('preserves zero as a valid override that admits a 45-minute round', async () => {
    const result = await observe('zero-reserve-45', 45, '0');
    expect(result.exportedReserve).toBe('0');
    expect(result.actualGate).toBeNull();
    expect(result.defaultReserve + result.defaultRound).toBeGreaterThan(45 * 60);
  });

  it('warns before spawning when a 45-minute budget is below the default estimate', async () => {
    const result = await observe('default-estimate-45', 45);
    expect(result.actualGate).toEqual({
      remainingSeconds: 2700,
      reserveSeconds: 1200,
      expectedRoundSeconds: 1800,
    });
    expect(result.stderrBeforeSpawn).toMatch(/default/i);
    expect(result.stderrBeforeSpawn).toMatch(/reserve/i);
    expect(result.stderrBeforeSpawn).toMatch(/round/i);
  });

  it('keeps a 120-minute default budget admissible without a warning', async () => {
    const result = await observe('default-estimate-120', 120);
    expect(result.actualGate).toBeNull();
    expect(result.stderrBeforeSpawn).toBe('');
  });
});

