/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useReverseSearchCompletion } from './useReverseSearchCompletion.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';

describe('useReverseSearchCompletion', () => {
  function useTextBufferForTest(text: string) {
    return useTextBuffer({
      initialText: text,
      initialCursorOffset: text.length,
      viewport: { width: 80, height: 20 },
      isValidPath: () => false,
      onChange: () => {},
    });
  }

  describe('Core Hook Behavior', () => {
    describe('State Management', () => {
      it('should initialize with default state', () => {
        const mockShellHistory = ['echo hello'];

        const { result } = renderHook(() =>
          useReverseSearchCompletion(
            useTextBufferForTest(''),
            mockShellHistory,
            false,
          ),
        );

        expect(result.current.suggestions).toEqual([]);
        expect(result.current.activeSuggestionIndex).toBe(-1);
        expect(result.current.visibleStartIndex).toBe(0);
        expect(result.current.showSuggestions).toBe(false);
        expect(result.current.isLoadingSuggestions).toBe(false);
      });

      it('should reset state when reverseSearchActive becomes false', () => {
        const mockShellHistory = ['echo hello'];
        const { result, rerender } = renderHook(
          ({ text, active }) => {
            const textBuffer = useTextBufferForTest(text);
            return useReverseSearchCompletion(
              textBuffer,
              mockShellHistory,
              active,
            );
          },
          { initialProps: { text: 'echo', active: true } },
        );

        // Simulate reverseSearchActive becoming false
        rerender({ text: 'echo', active: false });

        expect(result.current.suggestions).toEqual([]);
        expect(result.current.activeSuggestionIndex).toBe(-1);
        expect(result.current.visibleStartIndex).toBe(0);
        expect(result.current.showSuggestions).toBe(false);
      });

      describe('Navigation', () => {
        it('should handle navigateUp with no suggestions', () => {
          const mockShellHistory = ['echo hello'];

          const { result } = renderHook(() =>
            useReverseSearchCompletion(
              useTextBufferForTest('grep'),
              mockShellHistory,
              true,
            ),
          );

          act(() => {
            result.current.navigateUp();
          });

          expect(result.current.activeSuggestionIndex).toBe(-1);
        });

        it('should handle navigateDown with no suggestions', () => {
          const mockShellHistory = ['echo hello'];
          const { result } = renderHook(() =>
            useReverseSearchCompletion(
              useTextBufferForTest('grep'),
              mockShellHistory,
              true,
            ),
          );

          act(() => {
            result.current.navigateDown();
          });

          expect(result.current.activeSuggestionIndex).toBe(-1);
        });

        it('should navigate up through suggestions with wrap-around', () => {
          const mockShellHistory = [
            'ls -l',
            'ls -la',
            'cd /some/path',
            'git status',
            'echo "Hello, World!"',
            'echo Hi',
          ];

          const { result } = renderHook(() =>
            useReverseSearchCompletion(
              useTextBufferForTest('echo'),
              mockShellHistory,
              true,
            ),
          );

          expect(result.current.suggestions.length).toBe(2);
          expect(result.current.activeSuggestionIndex).toBe(0);

          act(() => {
            result.current.navigateUp();
          });

          expect(result.current.activeSuggestionIndex).toBe(1);
        });

        it('should navigate down through suggestions with wrap-around', () => {
          const mockShellHistory = [
            'ls -l',
            'ls -la',
            'cd /some/path',
            'git status',
            'echo "Hello, World!"',
            'echo Hi',
          ];
          const { result } = renderHook(() =>
            useReverseSearchCompletion(
              useTextBufferForTest('ls'),
              mockShellHistory,
              true,
            ),
          );

          expect(result.current.suggestions.length).toBe(2);
          expect(result.current.activeSuggestionIndex).toBe(0);

          act(() => {
            result.current.navigateDown();
          });

          expect(result.current.activeSuggestionIndex).toBe(1);
        });

        it('should handle navigation with multiple suggestions', () => {
          const mockShellHistory = [
            'ls -l',
            'ls -la',
            'cd /some/path/l',
            'git status',
            'echo "Hello, World!"',
            'echo "Hi all"',
          ];

          const { result } = renderHook(() =>
            useReverseSearchCompletion(
              useTextBufferForTest('l'),
              mockShellHistory,
              true,
            ),
          );

          expect(result.current.suggestions.length).toBe(5);
          expect(result.current.activeSuggestionIndex).toBe(0);

          act(() => {
            result.current.navigateDown();
          });
          expect(result.current.activeSuggestionIndex).toBe(1);

          act(() => {
            result.current.navigateDown();
          });
          expect(result.current.activeSuggestionIndex).toBe(2);

          act(() => {
            result.current.navigateUp();
          });
          expect(result.current.activeSuggestionIndex).toBe(1);

          act(() => {
            result.current.navigateUp();
          });
          expect(result.current.activeSuggestionIndex).toBe(0);

          act(() => {
            result.current.navigateUp();
          });
          expect(result.current.activeSuggestionIndex).toBe(4);
        });

        it('should handle navigation with large suggestion lists and scrolling', () => {
          const largeMockCommands = Array.from(
            { length: 15 },
            (_, i) => `echo ${i}`,
          );

          const { result } = renderHook(() =>
            useReverseSearchCompletion(
              useTextBufferForTest('echo'),
              largeMockCommands,
              true,
            ),
          );

          expect(result.current.suggestions.length).toBe(15);
          expect(result.current.activeSuggestionIndex).toBe(0);
          expect(result.current.visibleStartIndex).toBe(0);

          act(() => {
            result.current.navigateUp();
          });

          expect(result.current.activeSuggestionIndex).toBe(14);
          expect(result.current.visibleStartIndex).toBe(Math.max(0, 15 - 8));
        });
      });
    });
  });

  describe('Filtering', () => {
    it.each([
      {
        change: 'adds matches',
        before: ['echo old'],
        after: ['echo new', 'pwd', 'echo old'],
        expected: ['echo new', 'echo old'],
      },
      {
        change: 'removes matches',
        before: ['echo removed', 'echo kept'],
        after: ['echo kept'],
        expected: ['echo kept'],
      },
      {
        change: 'reorders matches',
        before: ['echo first', 'echo second'],
        after: ['echo second', 'echo first'],
        expected: ['echo second', 'echo first'],
      },
      {
        change: 'removes every match',
        before: ['echo removed'],
        after: ['pwd'],
        expected: [],
      },
    ])(
      'updates cached results when history $change',
      ({ before, after, expected }) => {
        const { result, rerender } = renderHook(
          ({ history }) =>
            useReverseSearchCompletion(
              { text: 'echo', setText: () => {} },
              history,
              true,
            ),
          { initialProps: { history: before } },
        );
        expect(
          result.current.suggestions.map((suggestion) => suggestion.value),
        ).toEqual(before);

        rerender({ history: after });

        expect(
          result.current.suggestions.map((suggestion) => suggestion.value),
        ).toEqual(expected);
        expect(result.current.showSuggestions).toBe(expected.length > 0);
        expect(result.current.activeSuggestionIndex).toBe(
          expected.length > 0 ? 0 : -1,
        );
      },
    );

    it('continues narrowing and widening a query after history changes', async () => {
      const { result, rerender } = renderHook(
        ({ text, history }) =>
          useReverseSearchCompletion(
            { text, setText: () => {} },
            history,
            true,
          ),
        { initialProps: { text: 'echo', history: ['echo old'] } },
      );
      const history = ['echo newest', 'echo new', 'echo old'];
      rerender({ text: 'echo', history });
      expect(
        result.current.suggestions.map((suggestion) => suggestion.value),
      ).toEqual(history);

      rerender({ text: 'echo new', history });
      await waitFor(() => {
        expect(
          result.current.suggestions.map((suggestion) => suggestion.value),
        ).toEqual(['echo newest', 'echo new']);
      });

      rerender({ text: 'echo', history });
      await waitFor(() => {
        expect(
          result.current.suggestions.map((suggestion) => suggestion.value),
        ).toEqual(history);
      });
    });

    it('filters history by buffer.text and sets showSuggestions', () => {
      const history = ['foo', 'barfoo', 'baz'];
      const { result } = renderHook(() =>
        useReverseSearchCompletion(useTextBufferForTest('foo'), history, true),
      );

      // should only return the two entries containing "foo"
      expect(result.current.suggestions.map((s) => s.value)).toEqual([
        'foo',
        'barfoo',
      ]);
      expect(result.current.showSuggestions).toBe(true);
    });

    it('hides suggestions when there are no matches', () => {
      const history = ['alpha', 'beta'];
      const { result } = renderHook(() =>
        useReverseSearchCompletion(useTextBufferForTest('γ'), history, true),
      );

      expect(result.current.suggestions).toEqual([]);
      expect(result.current.showSuggestions).toBe(false);
    });
  });
});
