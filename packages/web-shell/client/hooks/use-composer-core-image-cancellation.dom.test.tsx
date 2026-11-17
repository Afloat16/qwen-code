/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { useComposerCore, type UseComposerCoreReturn } from './useComposerCore';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let composer: UseComposerCoreReturn;

function Harness() {
  composer = useComposerCore({
    onSubmit: () => {},
    commands: [],
    editorTheme: {},
  });
  return <div ref={composer.containerRef} />;
}

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <Harness />
      </I18nProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  localStorage.clear();
  vi.restoreAllMocks();
});

function observeReads() {
  const finished: Promise<void>[] = [];
  const read = FileReader.prototype.readAsDataURL;
  const started = vi
    .spyOn(FileReader.prototype, 'readAsDataURL')
    .mockImplementation(function (this: FileReader, blob: Blob) {
      finished.push(
        new Promise<void>((resolve) => {
          this.addEventListener('loadend', () => resolve(), { once: true });
        }),
      );
      read.call(this, blob);
    });
  const drain = async () => {
    let completed = 0;
    while (completed < finished.length) {
      const batch = finished.slice(completed);
      completed = finished.length;
      await Promise.all(batch);
    }
  };
  return { started, drain };
}

function images() {
  return Array.from(
    { length: 10 },
    (_, i) => new File([`image-${i}`], `${i}.png`, { type: 'image/png' }),
  );
}

describe('composer image ingestion cancellation', () => {
  it.each(['clear', 'unmount'] as const)(
    'does not start queued image reads after %s',
    async (cancel) => {
      await mount();
      const { started, drain } = observeReads();
      const abort = vi.spyOn(FileReader.prototype, 'abort');

      await act(async () => {
        composer.ingestFiles(images());
        await Promise.resolve();
        expect(started).toHaveBeenCalledTimes(4);
        if (cancel === 'clear') composer.clearText();
        else {
          root!.unmount();
          root = undefined;
        }
        expect(abort).toHaveBeenCalledTimes(4);
        await drain();
      });

      expect(started).toHaveBeenCalledTimes(4);
      if (cancel === 'clear') {
        expect(composer.pastedImages).toEqual([]);
        expect(composer.pendingImageBatchCount).toBe(0);
      }
    },
  );

  it('accepts a new image batch after cancelling the previous batch', async () => {
    await mount();
    const { started, drain } = observeReads();

    await act(async () => {
      composer.ingestFiles(images());
      await Promise.resolve();
      expect(started).toHaveBeenCalledTimes(4);
      composer.clearText();
      composer.ingestFiles([
        new File(['replacement'], 'new.png', { type: 'image/png' }),
      ]);
      await Promise.resolve();
      await drain();
    });

    expect(started).toHaveBeenCalledTimes(5);
    expect(composer.pastedImages.map((image) => atob(image.data))).toEqual([
      'replacement',
    ]);
    expect(composer.pendingImageBatchCount).toBe(0);
  });
});
