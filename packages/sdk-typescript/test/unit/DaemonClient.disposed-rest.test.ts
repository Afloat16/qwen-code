/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonTransportClosedError } from '../../src/daemon/DaemonTransport.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('disposed daemon client REST operations', () => {
  it.each([
    'native-rest',
    'upload',
    'progress-upload',
    'btw-stream',
    'transport',
  ] as const)('rejects %s before opening another request', async (kind) => {
    const fetch = vi.fn(async () => new Response('{}', { status: 404 }));
    const xhr = vi.fn(() => {
      throw new Error('XHR should not be created');
    });
    vi.stubGlobal('XMLHttpRequest', xhr);
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    client.dispose();
    const operation =
      kind === 'native-rest'
        ? client.requestRest('/file', { method: 'POST', body: '{}' })
        : kind === 'btw-stream'
          ? client.streamSessionBtw('session', 'question').next()
          : kind === 'transport'
            ? client.health()
            : client.uploadWorkspaceFile({
                path: 'file.txt',
                data: new Blob(['text']),
                ...(kind === 'progress-upload' ? { onProgress: () => {} } : {}),
              });
    await expect(operation).rejects.toBeInstanceOf(DaemonTransportClosedError);
    expect(fetch).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
  });
});
