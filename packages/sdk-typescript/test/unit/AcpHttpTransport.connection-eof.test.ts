/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AcpHttpTransport } from '../../src/daemon/AcpHttpTransport.js';

function harness() {
  const connections: ReadableStreamDefaultController<Uint8Array>[] = [];
  const sessions = new Map<
    string,
    ReadableStreamDefaultController<Uint8Array>
  >();
  const requests: { id: number; method: string }[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/capabilities')) return Response.json({ v: 1 });
    if (init?.method === 'POST') {
      const request = JSON.parse(String(init.body)) as {
        id: number;
        method: string;
      };
      if (request.method === 'initialize') {
        return Response.json({ jsonrpc: '2.0', id: request.id, result: {} });
      }
      requests.push(request);
      return new Response(null, { status: 202 });
    }
    const sessionId = new Headers(init?.headers).get('acp-session-id');
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (sessionId) sessions.set(sessionId, controller);
          else connections.push(controller);
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const transport = new AcpHttpTransport('http://daemon', undefined, fetchImpl);
  const create = () =>
    transport.fetch('http://daemon/session', {
      method: 'POST',
      body: JSON.stringify({ model: 'test' }),
    });
  return { transport, connections, sessions, requests, create };
}

function observe(promise: Promise<Response>) {
  const outcome: { value?: Response | Error } = {};
  void promise.then(
    (response) => {
      outcome.value = response;
    },
    (error: unknown) => {
      outcome.value = error instanceof Error ? error : new Error(String(error));
    },
  );
  return outcome;
}

function reply(
  stream: ReadableStreamDefaultController<Uint8Array>,
  id: number,
  result: unknown,
) {
  stream.enqueue(
    new TextEncoder().encode(
      `data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`,
    ),
  );
}

describe('AcpHttpTransport connection stream completion', () => {
  it('rejects a pending request on clean EOF and reopens for the next request', async () => {
    const h = harness();
    try {
      const first = observe(h.create());
      await vi.waitFor(() => expect(h.connections).toHaveLength(1));
      h.connections[0]!.close();
      await vi.waitFor(() => expect(first.value).toBeInstanceOf(Error));
      expect((first.value as Error).message).toContain('Connection SSE');

      const next = h.create();
      await vi.waitFor(() => expect(h.connections).toHaveLength(2));
      reply(h.connections[1]!, h.requests[1]!.id, { sessionId: 'created' });
      expect(await (await next).json()).toEqual({ sessionId: 'created' });
    } finally {
      h.transport.dispose();
    }
  });

  it('preserves the original stream failure', async () => {
    const h = harness();
    try {
      const outcome = observe(h.create());
      await vi.waitFor(() => expect(h.connections).toHaveLength(1));
      const failure = new Error('network reply stream failed');
      h.connections[0]!.error(failure);
      await vi.waitFor(() => expect(outcome.value).toBe(failure));
    } finally {
      h.transport.dispose();
    }
  });

  it('retains a matching response delivered before clean EOF', async () => {
    const h = harness();
    try {
      const pending = h.create();
      await vi.waitFor(() => expect(h.connections).toHaveLength(1));
      reply(h.connections[0]!, h.requests[0]!.id, { sessionId: 'created' });
      h.connections[0]!.close();
      expect(await (await pending).json()).toEqual({ sessionId: 'created' });
    } finally {
      h.transport.dispose();
    }
  });

  it('leaves the session reply stream responsible for its pending requests', async () => {
    const h = harness();
    try {
      const session = h.transport.fetch('http://daemon/session/s-1/prompt', {
        method: 'POST',
        body: JSON.stringify({ prompt: [{ type: 'text', text: 'hello' }] }),
      });
      const sessionOutcome = observe(session);
      await vi.waitFor(() => expect(h.sessions.has('s-1')).toBe(true));
      const connectionOutcome = observe(h.create());
      await vi.waitFor(() => expect(h.connections).toHaveLength(1));
      h.connections[0]!.close();
      await vi.waitFor(() =>
        expect(connectionOutcome.value).toBeInstanceOf(Error),
      );
      expect(sessionOutcome.value).toBeUndefined();
      reply(h.sessions.get('s-1')!, h.requests[0]!.id, {
        stopReason: 'end_turn',
      });
      expect(await (await session).json()).toEqual({ stopReason: 'end_turn' });
    } finally {
      h.transport.dispose();
    }
  });
});
