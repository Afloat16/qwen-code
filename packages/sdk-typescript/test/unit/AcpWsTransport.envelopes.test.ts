/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpWsTransport } from '../../src/daemon/AcpWsTransport.js';

class FakeWebSocket {
  static latest: FakeWebSocket;
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeWebSocket.latest = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string) {
    const message = JSON.parse(data);
    if (message.method === 'initialize') {
      queueMicrotask(() =>
        this.receive({ jsonrpc: '2.0', id: message.id, result: {} }),
      );
    }
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close() {
    this.onclose?.({ code: 1000, reason: 'closed' });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebSocket protocol envelope validation', () => {
  it.each([null, 42, true, 'heartbeat', []].map((frame) => ({ frame })))(
    'ignores non-object JSON frame $frame without disrupting events',
    async ({ frame }) => {
      vi.stubGlobal('WebSocket', FakeWebSocket);
      const transport = new AcpWsTransport('ws://daemon/acp');
      const abort = new AbortController();
      const iterator = transport.subscribeEvents('target', {
        signal: abort.signal,
      });
      const next = iterator.next();
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        expect(() => FakeWebSocket.latest.receive(frame)).not.toThrow();
        FakeWebSocket.latest.receive({
          jsonrpc: '2.0',
          method: 'workspace_changed',
          params: { marker: 'valid' },
        });
        expect((await next).value?.type).toBe('workspace_changed');
      } finally {
        abort.abort();
        await next;
        await iterator.return(undefined);
        transport.dispose();
      }
    },
  );
});
