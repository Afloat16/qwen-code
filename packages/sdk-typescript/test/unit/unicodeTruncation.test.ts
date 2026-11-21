/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  daemonBlockToHtml,
  daemonBlockToMarkdown,
  daemonBlockToPlainText,
} from '../../src/daemon/ui/render.js';
import {
  appendLocalUserTranscriptMessage,
  createDaemonTranscriptState,
} from '../../src/daemon/ui/transcript.js';
import { capDetails } from '../../src/daemon/ui/utils.js';

describe('Unicode at transcript text limits', () => {
  it.each([
    ['markdown', daemonBlockToMarkdown],
    ['plain text', daemonBlockToPlainText],
    ['HTML', daemonBlockToHtml],
  ] as const)('does not split an astral character in %s', (_name, render) => {
    const state = appendLocalUserTranscriptMessage(
      createDaemonTranscriptState(),
      'a😀b',
    );
    const output = render(state.blocks[0]!, { maxFieldLength: 2 });
    expect(output).toContain('a… [truncated]');
    expect(output).not.toContain('\ud83d');
  });

  it('does not create replacement characters in capped tool details', () => {
    const prefix = 'a'.repeat(4095);
    expect(capDetails(`${prefix}😀tail`).slice(-25)).toBe(
      `${prefix}... [truncated]`.slice(-25),
    );
  });

  it('keeps retained transcript text on a complete code-point boundary', () => {
    const suffix = '\n[truncated]\n';
    const prefix = 'a'.repeat(100_000 - suffix.length - 1);
    const state = appendLocalUserTranscriptMessage(
      createDaemonTranscriptState(),
      `${prefix}😀${'x'.repeat(50)}`,
    );
    const block = state.blocks[0]!;
    expect('text' in block && block.text.slice(-25)).toBe(
      `${prefix}${suffix}`.slice(-25),
    );
  });
});
