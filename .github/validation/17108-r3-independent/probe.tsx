// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonWorkspaceMemoryFile,
  DaemonWorkspaceMemoryStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const harness = vi.hoisted(() => ({
  availability: 'available',
  memoryVersion: 0,
  loadMemoryStatus: vi.fn(),
  readWorkspaceFile: vi.fn(),
  writeMemory: vi.fn(),
  onMessage: vi.fn(),
  outcomes: [] as Array<{
    data: DaemonWorkspaceMemoryStatus | undefined;
    superseded: boolean;
  }>,
}));

vi.mock('../../daemon/availability-context.js', () => ({
  useDaemonAvailability: () => harness.availability,
  useDaemonAvailabilityController: () => undefined,
}));
vi.mock('../../daemon/workspace/DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspaceActions: () => harness,
}));
vi.mock('../../daemon/session/DaemonSessionProvider.js', () => ({
  useDaemonWorkspaceEventSignals: () => ({
    memoryVersion: harness.memoryVersion,
  }),
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', async () => {
  const { useDaemonMemory } = await import(
    '../../daemon/workspace/hooks/useDaemonMemory.js'
  );
  return {
    useMemory: (options: Parameters<typeof useDaemonMemory>[0]) => {
      const result = useDaemonMemory(options);
      const reload = result.reloadWithOutcome;
      const reloadWithOutcome = useCallback(async () => {
        const outcome = await reload();
        harness.outcomes.push(outcome);
        return outcome;
      }, [reload]);
      return { ...result, reloadWithOutcome };
    },
  };
});

const { MemoryMessage } = await import('./MemoryMessage');

const workspaceFile: DaemonWorkspaceMemoryFile = {
  kind: 'memory_file',
  path: '/workspace/QWEN.md',
  scope: 'workspace',
  bytes: 17,
  content: 'existing memory\n',
};

function statusWith(
  files: DaemonWorkspaceMemoryFile[],
): DaemonWorkspaceMemoryStatus {
  return {
    v: 1,
    workspaceCwd: '/workspace',
    initialized: true,
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    fileCount: files.length,
    ruleCount: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;

async function renderPanel() {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <MemoryMessage onMessage={harness.onMessage} />
      </I18nProvider>,
    );
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function refresh() {
  act(() => {
    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Refresh',
    );
    expect(button?.disabled).toBe(false);
    button!.click();
  });
  await flush();
}

function contentReads() {
  return harness.loadMemoryStatus.mock.calls.filter(
    ([options]) => options?.includeContent === true,
  ).length;
}

beforeEach(() => {
  harness.availability = 'available';
  harness.memoryVersion = 0;
  harness.outcomes = [];
  harness.onMessage.mockReset();
  harness.readWorkspaceFile.mockReset();
  harness.writeMemory.mockReset();
  harness.loadMemoryStatus
    .mockReset()
    .mockResolvedValue(statusWith([workspaceFile]));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});


function editDisabled() {
  const edit = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === 'Edit',
  );
  expect(edit).toBeDefined();
  return edit!.disabled;
}

function recordCase(label: string, readsBefore: number) {
  console.log(
    'QWEN17108_INDEPENDENT ' +
      JSON.stringify({
        label,
        contentReadsDelta: contentReads() - readsBefore,
        editDisabled: editDisabled(),
        panel: container.textContent,
        messages: harness.onMessage.mock.calls,
        outcomes: harness.outcomes.map(({ data, superseded }) => ({
          hasData: data !== undefined,
          superseded,
        })),
        writes: harness.writeMemory.mock.calls.length,
      }),
  );
}

async function renderReadFailure() {
  harness.loadMemoryStatus.mockImplementation(
    (options?: { includeContent?: boolean }) =>
      options?.includeContent
        ? Promise.reject(new Error('temporary read failure'))
        : Promise.resolve(statusWith([workspaceFile])),
  );
  await renderPanel();
  await flush();
  expect(container.textContent).toContain('temporary read failure');
  expect(editDisabled()).toBe(true);
  harness.onMessage.mockClear();
}

describe('MemoryMessage R3 independent reproduction', () => {
  it('reports the list-load cause to both panel and transcript', async () => {
    await renderPanel();
    const readsBefore = contentReads();
    harness.loadMemoryStatus.mockRejectedValueOnce(
      new Error('workspace not trusted'),
    );

    await refresh();
    await flush();

    recordCase('list-error', readsBefore);
    expect(container.textContent).toContain('workspace not trusted');
    expect(harness.onMessage).toHaveBeenCalledWith(
      'workspace not trusted',
      'error',
    );
    expect(contentReads()).toBe(readsBefore);
    expect(harness.writeMemory).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'recovers a read-only panel when a same-path event supersedes a refresh that %ss',
    async (completion) => {
      await renderReadFailure();
      const oldRefresh = deferred<DaemonWorkspaceMemoryStatus>();
      const eventRefresh = deferred<DaemonWorkspaceMemoryStatus>();
      let listCalls = 0;
      harness.loadMemoryStatus.mockImplementation(
        (options?: { includeContent?: boolean }) => {
          if (options?.includeContent) {
            return Promise.resolve(
              statusWith([
                { ...workspaceFile, content: 'recovered current memory\n' },
              ]),
            );
          }
          listCalls++;
          return listCalls === 1 ? oldRefresh.promise : eventRefresh.promise;
        },
      );
      const readsBefore = contentReads();
      await refresh();

      harness.memoryVersion++;
      await renderPanel();
      await act(async () => {
        eventRefresh.resolve(
          statusWith([{ ...workspaceFile, content: 'current list metadata\n' }]),
        );
      });
      await act(async () => {
        if (completion === 'resolve') {
          oldRefresh.resolve(
            statusWith([{ ...workspaceFile, content: 'obsolete metadata\n' }]),
          );
        } else {
          oldRefresh.reject(new Error('obsolete failure'));
        }
      });
      await flush();

      recordCase('superseded-' + completion, readsBefore);
      expect(listCalls).toBe(2);
      expect(harness.outcomes).toEqual([
        expect.objectContaining({ data: undefined, superseded: true }),
      ]);
      expect(contentReads()).toBe(readsBefore + 1);
      expect(container.textContent).toContain('recovered current memory');
      expect(container.textContent).not.toContain('temporary read failure');
      expect(container.textContent).not.toContain('obsolete');
      expect(editDisabled()).toBe(false);
      expect(harness.onMessage).not.toHaveBeenCalled();
      expect(harness.writeMemory).not.toHaveBeenCalled();
    },
  );

  it('recovers a read-only panel on an uncontended refresh', async () => {
    await renderReadFailure();
    const readsBefore = contentReads();
    harness.loadMemoryStatus.mockResolvedValue(
      statusWith([{ ...workspaceFile, content: 'recovered current memory\n' }]),
    );

    await refresh();
    await flush();

    recordCase('uncontended-control', readsBefore);
    expect(contentReads()).toBe(readsBefore + 1);
    expect(container.textContent).toContain('recovered current memory');
    expect(container.textContent).toContain('Memory refreshed.');
    expect(editDisabled()).toBe(false);
    expect(harness.onMessage).not.toHaveBeenCalled();
    expect(harness.writeMemory).not.toHaveBeenCalled();
  });

  it('keeps generic feedback when an unavailable refresh has no cause', async () => {
    await renderPanel();
    harness.availability = 'unavailable';
    await renderPanel();
    const readsBefore = contentReads();

    await refresh();
    await flush();

    recordCase('unavailable-control', readsBefore);
    expect(container.textContent).toContain(
      'Could not refresh memory. Please try again.',
    );
    expect(harness.onMessage).toHaveBeenCalledWith(
      'Could not refresh memory. Please try again.',
      'error',
    );
    expect(contentReads()).toBe(readsBefore);
    expect(harness.writeMemory).not.toHaveBeenCalled();
  });
});
