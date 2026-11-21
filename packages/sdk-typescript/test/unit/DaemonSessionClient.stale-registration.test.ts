/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonSessionClient } from '../../src/daemon/DaemonSessionClient.js';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('late invalid-client responses', () => {
  it('reuses a completed recovery when another old request fails later', async () => {
    const waiting: Array<(response: Response) => void> = [];
    const retryIds: string[] = [];
    let registrations = 0;
    const client = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/resume')) {
          registrations++;
          return response(200, {
            sessionId: 'session',
            workspaceCwd: '/work',
            attached: true,
            clientId: `fresh-${registrations}`,
            state: {},
          });
        }
        if (url.endsWith('/prompt')) {
          const id = new Headers(init?.headers).get('X-Qwen-Client-Id');
          if (id === 'stale') {
            return await new Promise<Response>((resolve) =>
              waiting.push(resolve),
            );
          }
          retryIds.push(id!);
          return response(200, { stopReason: 'end_turn' });
        }
        return response(200, { features: [] });
      },
    });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 'session',
        workspaceCwd: '/work',
        attached: true,
        clientId: 'stale',
      },
    });
    const first = session.prompt({ prompt: [{ type: 'text', text: 'first' }] });
    const second = session.prompt({
      prompt: [{ type: 'text', text: 'second' }],
    });
    expect(waiting).toHaveLength(2);
    waiting[0]!(response(400, { code: 'invalid_client_id' }));
    await first;
    waiting[1]!(response(400, { code: 'invalid_client_id' }));
    await second;
    expect(registrations).toBe(1);
    expect(retryIds).toEqual(['fresh-1', 'fresh-1']);
    expect(session.clientId).toBe('fresh-1');
  });
});
