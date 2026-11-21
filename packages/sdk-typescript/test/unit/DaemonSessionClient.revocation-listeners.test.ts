/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonSessionClient } from '../../src/daemon/DaemonSessionClient.js';

function session(disabled = false) {
  const client = new DaemonClient({
    baseUrl: 'http://daemon',
    fetch: async () =>
      new Response(
        JSON.stringify({
          v: 1,
          sessionId: 'session',
          workspaceCwd: '/work',
          state: {
            _meta: { generatedUi: { version: 1, enabled: false } },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  return new DaemonSessionClient({
    client,
    session: {
      sessionId: 'session',
      workspaceCwd: '/work',
      attached: true,
      generatedUi: { version: 1, enabled: !disabled },
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Generated UI revocation observers', () => {
  it.each([false, true])(
    'retains a confirmed denial and notifies other observers (reporter throws: %s)',
    async (reporterThrows) => {
      const failed = new Error('observer failed');
      const report = vi.fn(() => {
        if (reporterThrows) throw new Error('reporter failed');
      });
      vi.stubGlobal('reportError', report);
      const target = session();
      target.subscribeGeneratedUiRevocation(() => {
        throw failed;
      });
      const observed = vi.fn();
      target.subscribeGeneratedUiRevocation(observed);
      const result = await target.context().catch((error: unknown) => error);
      expect(result).toMatchObject({ v: 1, sessionId: 'session' });
      expect(target.session.generatedUi).toEqual({
        version: 1,
        enabled: false,
      });
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed).toHaveBeenLastCalledWith(1);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenLastCalledWith(failed);
    },
  );

  it('returns an unsubscribe handle when immediate replay throws', async () => {
    vi.stubGlobal('reportError', vi.fn());
    const target = session(true);
    const observed = vi.fn(() => {
      throw new Error('late observer failed');
    });
    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = target.subscribeGeneratedUiRevocation(observed);
    }).not.toThrow();
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenLastCalledWith(1);
    unsubscribe!();
    await target.context();
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it('delivers a revision once when an observer subscribes during notification', async () => {
    const target = session();
    const late = vi.fn();
    target.subscribeGeneratedUiRevocation(() => {
      target.subscribeGeneratedUiRevocation(late);
    });
    await target.context();
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenLastCalledWith(1);
  });
});
