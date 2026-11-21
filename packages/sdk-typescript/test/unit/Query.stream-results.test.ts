/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Query } from '../../src/query/Query.js';
import type { Transport } from '../../src/transport/Transport.js';
import type { SDKUserMessage } from '../../src/types/protocol.js';
import { Stream } from '../../src/utils/Stream.js';

class ProtocolTransport implements Transport {
  readonly messages = new Stream<unknown>();
  readonly written: Record<string, unknown>[] = [];
  isReady = true;
  exitError = null;
  inputEnded = false;

  write(line: string): void {
    if (this.inputEnded) throw new Error('stdin already ended');
    const message = JSON.parse(line);
    this.written.push(message);
    if (message.type === 'control_request') {
      this.messages.enqueue({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: {},
        },
      });
    }
  }

  async *readMessages() {
    yield* this.messages;
  }

  async close() {
    this.messages.done();
  }

  async waitForExit() {}

  endInput() {
    this.inputEnded = true;
  }

  result() {
    this.messages.enqueue({
      type: 'result',
      subtype: 'success',
      uuid: 'result',
      session_id: 'session',
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: 'done',
      usage: { input_tokens: 1, output_tokens: 1 },
      permission_denials: [],
    });
  }
}

function prompt(content: string): SDKUserMessage {
  return {
    type: 'user',
    session_id: 'session',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  };
}

const flush = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe('streamed-turn input lifetime', () => {
  const queries: Query[] = [];
  afterEach(async () => {
    await Promise.all(queries.splice(0).map((query) => query.close()));
    vi.useRealTimers();
  });

  it.each([false, true])(
    'keeps later-turn permission replies writable (early first result: %s)',
    async (earlyFirstResult) => {
      const transport = new ProtocolTransport();
      const query = new Query(transport, {
        canUseTool: async (_tool, input) => ({
          behavior: 'allow',
          updatedInput: input,
        }),
        timeout: { streamClose: 1_000 },
      });
      queries.push(query);
      await query.initialized;
      async function* prompts() {
        yield prompt('first');
        if (earlyFirstResult) {
          transport.result();
          await flush();
        }
        yield prompt('second');
      }
      const input = query.streamInput(prompts());
      await flush();
      if (!earlyFirstResult) transport.result();
      await flush();
      const endedAfterFirst = transport.inputEnded;
      transport.messages.enqueue({
        type: 'control_request',
        request_id: 'second-turn-permission',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'read_file',
          input: { path: 'README.md' },
          permission_suggestions: null,
          blocked_path: null,
        },
      });
      await flush();
      transport.result();
      await input;
      expect(endedAfterFirst).toBe(false);
      expect(transport.inputEnded).toBe(true);
      expect(transport.written).toContainEqual({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'second-turn-permission',
          response: {
            behavior: 'allow',
            updatedInput: { path: 'README.md' },
          },
        },
      });
    },
  );

  it('retains the configured timeout when a later result never arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = new ProtocolTransport();
    const query = new Query(transport, { timeout: { streamClose: 50 } });
    queries.push(query);
    await query.initialized;
    const input = query.streamInput(
      (async function* () {
        yield prompt('first');
        yield prompt('second');
      })(),
    );
    await flush();
    transport.result();
    await flush();
    const endedBeforeTimeout = transport.inputEnded;
    await vi.advanceTimersByTimeAsync(50);
    await input;
    expect(endedBeforeTimeout).toBe(false);
    expect(transport.inputEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the result wait and timer on explicit close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const transport = new ProtocolTransport();
    const query = new Query(transport, { timeout: { streamClose: 50 } });
    queries.push(query);
    await query.initialized;
    let finished = false;
    const input = query
      .streamInput(
        (async function* () {
          yield prompt('first');
        })(),
      )
      .then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
    await flush();
    await query.close();
    await flush();
    const completedOnClose = finished;
    const timersAfterClose = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(50);
    await input;
    expect(completedOnClose).toBe(true);
    expect(timersAfterClose).toBe(0);
  });
});
