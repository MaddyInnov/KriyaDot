// SPDX-License-Identifier: Apache-2.0
// Summarizer stage-prompt overrides: the system prompt sent to the
// summarization model comes from the PromptOverrideStore — a user-authored
// override file wins over the built-in prompt, and edits hot-reload on the
// next summarization. The provider is mocked (no network, no paid APIs).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockChat, mockCreateProvider, mockCreateProviderWithKeylessFallback } = vi.hoisted(() => {
  const mockChat = vi.fn();
  const mockCreateProvider = vi.fn(() => ({ chat: mockChat }));
  // The summarizer now resolves its provider through the keyless-
  // fallback seam (zero-setup installs fall back to a keyless lane
  // instead of failing compaction). Mock that seam too: it returns the
  // same fake provider, marked as not-fallen-back.
  const mockCreateProviderWithKeylessFallback = vi.fn((providerId: string) => ({
    provider: { chat: mockChat },
    providerId,
    fellBack: false,
  }));
  return { mockChat, mockCreateProvider, mockCreateProviderWithKeylessFallback };
});

vi.mock('@mvp/agent-runtime', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mvp/agent-runtime')>();
  return {
    ...orig,
    createProvider: mockCreateProvider,
    createProviderWithKeylessFallback: mockCreateProviderWithKeylessFallback,
  };
});

import { PromptOverrideStore } from '@mvp/agent-runtime';
import { createSummarizer } from '../src/summarizer.js';
import type { ChatMessage } from '@mvp/agent-runtime';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.clearAllMocks();
});

function freshStore(): { store: PromptOverrideStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'summarizer-prompts-'));
  dirs.push(dir);
  return { store: new PromptOverrideStore({ dir }), dir };
}

const messages: ChatMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there' },
];

describe('createSummarizer prompt overrides', () => {
  it('uses the built-in summarizer prompt when no override exists', async () => {
    const { store } = freshStore();
    mockChat.mockResolvedValue({ content: 'summary' });
    await createSummarizer(store)(messages);

    expect(mockCreateProviderWithKeylessFallback).toHaveBeenCalledWith('groq');
    const systemPrompt = mockChat.mock.calls[0][0][0].content as string;
    expect(systemPrompt).toContain('compact briefing');
  });

  it('prefers the override file over the built-in prompt', async () => {
    const { store, dir } = freshStore();
    writeFileSync(join(dir, 'summarizer.md'), 'OVERRIDE: summarize in pirate speak.');
    mockChat.mockResolvedValue({ content: 'summary' });
    await createSummarizer(store)(messages);

    const systemPrompt = mockChat.mock.calls[0][0][0].content as string;
    expect(systemPrompt).toBe('OVERRIDE: summarize in pirate speak.');
  });

  it('hot-reloads an edited override on the next summarization', async () => {
    const { store, dir } = freshStore();
    const file = join(dir, 'summarizer.md');
    writeFileSync(file, 'v1');
    mockChat.mockResolvedValue({ content: 'summary' });
    const summarize = createSummarizer(store);
    await summarize(messages);
    expect(mockChat.mock.calls[0][0][0].content).toBe('v1');

    writeFileSync(file, 'v2');
    await summarize(messages);
    expect(mockChat.mock.calls[1][0][0].content).toBe('v2');
  });

  it('falls back to the extractive summary when the provider is unavailable', async () => {
    const { store } = freshStore();
    mockChat.mockRejectedValue(new Error('no key'));
    const summary = await createSummarizer(store)(messages);
    expect(summary).toContain('[extractive summary');
  });
});
