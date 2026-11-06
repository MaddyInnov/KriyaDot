// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
// Playback signal: multi-source store + React hook.

import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  activePlaybackSources,
  isAssistantSpeaking,
  reportPlayback,
  useAssistantSpeaking,
} from './playback-signal';

afterEach(() => {
  // The store is module-global; leave it clean for the next test.
  reportPlayback('chat-tts-queue', false);
  reportPlayback('voice-controls', false);
  reportPlayback('test-source', false);
});

describe('playback-signal store', () => {
  it('is silent until a source reports active', () => {
    expect(isAssistantSpeaking()).toBe(false);
    reportPlayback('chat-tts-queue', true);
    expect(isAssistantSpeaking()).toBe(true);
    expect(activePlaybackSources()).toEqual(['chat-tts-queue']);
  });

  it('stays speaking while ANY source is active (multi-source overlap)', () => {
    reportPlayback('chat-tts-queue', true);
    reportPlayback('voice-controls', true);
    reportPlayback('chat-tts-queue', false);
    expect(isAssistantSpeaking()).toBe(true);
    expect(activePlaybackSources()).toEqual(['voice-controls']);
    reportPlayback('voice-controls', false);
    expect(isAssistantSpeaking()).toBe(false);
  });

  it('treats repeat reports of the same state as no-ops', () => {
    reportPlayback('test-source', true);
    reportPlayback('test-source', true);
    expect(activePlaybackSources()).toEqual(['test-source']);
    reportPlayback('test-source', false);
    reportPlayback('test-source', false);
    expect(isAssistantSpeaking()).toBe(false);
  });
});

describe('useAssistantSpeaking', () => {
  it('re-renders when playback starts and stops', () => {
    const { result } = renderHook(() => useAssistantSpeaking());
    expect(result.current).toBe(false);
    act(() => reportPlayback('voice-controls', true));
    expect(result.current).toBe(true);
    act(() => reportPlayback('voice-controls', false));
    expect(result.current).toBe(false);
  });
});
