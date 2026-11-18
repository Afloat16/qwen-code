/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import {
  countMarkdownSourceBlocks,
  MarkdownDisplay,
} from './MarkdownDisplay.js';
import { copyCommand } from '../commands/copyCommand.js';
import { copyToClipboard } from './commandUtils.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { renderWithProviders } from '../../test-utils/render.js';
import * as latexRenderer from './latexRenderer.js';
import * as mermaidRenderer from './mermaidVisualRenderer.js';

vi.mock('./commandUtils.js', () => ({ copyToClipboard: vi.fn() }));

const baseProps = { isPending: false, contentWidth: 80 };

function sourceHints(frame: string): string[] {
  return Array.from(
    frame.matchAll(/source: (\/copy (?:latex|mermaid) \d+)/g),
    (match) => match[1]!,
  );
}

async function executeHint(markdown: string, hint: string) {
  const context = createMockCommandContext({
    services: {
      config: {
        getLlmClient: () => ({
          getChat: vi.fn().mockReturnValue({
            getHistoryShallow: () => [
              { role: 'model', parts: [{ text: markdown }] },
            ],
          }),
        }),
      },
    },
  });
  if (!copyCommand.action) throw new Error('Command has no action');
  return copyCommand.action(context, hint.slice('/copy '.length));
}

const latexSource = 'visible';
const mermaidSource = 'graph LR\nV[visible] --> T[target]';
const literalExample = [
  '~~~text',
  '~~~not-a-close',
  '$$',
  'hidden',
  '$$',
  '```mermaid',
  'graph LR',
  'H[hidden] --> X[wrong]',
  '```',
  '~~~',
].join('\n');

describe('Markdown source copy hints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe.each([
    {
      name: 'LaTeX after a fence with an info string',
      kind: 'latex',
      source: latexSource,
      hidden: 'hidden',
      text: [
        '```text',
        '```not-a-close',
        '$$',
        'hidden',
        '$$',
        '```',
        '$$',
        latexSource,
        '$$',
      ].join('\n'),
    },
    {
      name: 'LaTeX after a fence with non-breaking whitespace',
      kind: 'latex',
      source: latexSource,
      hidden: 'hidden',
      text: [
        '```text',
        '```\u00a0',
        '$$',
        'hidden',
        '$$',
        '```',
        '$$',
        latexSource,
        '$$',
      ].join('\n'),
    },
    {
      name: 'Mermaid after a fence with an info string',
      kind: 'mermaid',
      source: mermaidSource,
      hidden: 'graph LR\nH[hidden] --> X[wrong]',
      text: literalExample + '\n```mermaid\n' + mermaidSource + '\n```',
    },
  ])('$name', ({ kind, source, hidden, text }) => {
    it.each([false, true])(
      'copies the source actually rendered (original-source lookup: %s)',
      async (useOriginalSource) => {
        const renderSource =
          kind === 'latex'
            ? vi.spyOn(latexRenderer, 'renderInlineLatex')
            : vi.spyOn(mermaidRenderer, 'renderMermaidVisual');
        const { lastFrame } = renderWithProviders(
          <MarkdownDisplay
            {...baseProps}
            text={text}
            sourceCopyText={useOriginalSource ? text : undefined}
          />,
        );
        const hints = sourceHints(stripAnsi(lastFrame() ?? ''));
        expect(hints).toEqual(['/copy ' + kind + ' 1']);
        const sources = renderSource.mock.calls.map(([value]) => value);
        expect(sources).toContain(source);
        expect(sources).not.toContain(hidden);

        await executeHint(text, hints[0]!);
        expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(source);
      },
    );
  });

  it.each([
    {
      kind: 'latex',
      source: latexSource,
      block: '$$\n' + latexSource + '\n$$',
    },
    {
      kind: 'mermaid',
      source: mermaidSource,
      block: '```mermaid\n' + mermaidSource + '\n```',
    },
  ])(
    'keeps $kind hints aligned across continuation chunks',
    async ({ kind, source, block }) => {
      const prefix =
        block.replace('visible', 'previous') + '\n' + literalExample + '\n';
      const { lastFrame } = renderWithProviders(
        <MarkdownDisplay
          {...baseProps}
          text={block}
          sourceCopyIndexOffsets={countMarkdownSourceBlocks(prefix)}
        />,
      );
      const hints = sourceHints(stripAnsi(lastFrame() ?? ''));
      expect(hints).toEqual(['/copy ' + kind + ' 2']);

      await executeHint(prefix + block, hints[0]!);
      expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(source);
    },
  );

  it('accepts a longer closing fence followed by ASCII spaces and tabs', async () => {
    const text = [
      '```text',
      '$$',
      'hidden',
      '$$',
      '````\t ',
      '$$',
      latexSource,
      '$$',
    ].join('\n');
    const { lastFrame } = renderWithProviders(
      <MarkdownDisplay {...baseProps} text={text} sourceCopyText={text} />,
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(sourceHints(frame)).toEqual(['/copy latex 1']);
    expect(frame).toMatch(/LaTeX block · source: \/copy latex 1\s+visible/);

    await executeHint(text, sourceHints(frame)[0]!);
    expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(latexSource);
  });

  it('does not print a copy command for an unfinished Mermaid block', async () => {
    const text = '```mermaid\n' + mermaidSource + '\n```not-a-close';
    const { lastFrame } = renderWithProviders(
      <MarkdownDisplay {...baseProps} text={text} />,
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('visible');
    expect(sourceHints(frame)).toEqual([]);

    const result = await executeHint(text, '/copy mermaid 1');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: 'No matching code block found in the last AI output.',
    });
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it('keeps an unfinished preview copyable when the original source is complete', async () => {
    const text = '```mermaid\n' + mermaidSource;
    const original = text + '\n```';
    const { lastFrame } = renderWithProviders(
      <MarkdownDisplay
        {...baseProps}
        text={text}
        sourceCopyText={original}
      />,
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('visible');
    const hints = sourceHints(frame);
    expect(hints).toEqual(['/copy mermaid 1']);

    await executeHint(original, hints[0]!);
    expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(mermaidSource);
  });

  it('keeps pipe-prefixed code at the streaming frontier after a fence-like line', () => {
    const text = [
      '```text',
      '```not-a-close',
      '| Keep | this |',
    ].join('\n');
    const { lastFrame } = renderWithProviders(
      <MarkdownDisplay {...baseProps} text={text} isPending={true} />,
    );

    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('```not-a-close');
    expect(frame).toContain('| Keep | this |');
    expect(sourceHints(frame)).toEqual([]);
  });
});
