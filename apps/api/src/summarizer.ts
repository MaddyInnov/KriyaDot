// SPDX-License-Identifier: Apache-2.0
// Default summarizer for the session store's auto-compaction hook.
//
// Strategy: try a cheap model first (Groq's free tier is the platform's
// default free substrate), capped input so summarization itself stays cheap.
// If no provider/key is available — or the call fails — fall back to an
// honest extractive summary (first/last messages + counts) so compaction
// NEVER breaks a session for lack of a key. The fallback is clearly labeled.

import { createProviderWithKeylessFallback } from '@mvp/agent-runtime';
import type { ChatMessage } from '@mvp/agent-runtime';
import { PromptOverrideStore } from '@mvp/agent-runtime';
import { resolvePurposeProfile } from '@mvp/agent-runtime';
import type { ModelProfiles } from '@mvp/agent-runtime';

const MAX_INPUT_CHARS = 24_000;

/**
 * Stage-prompt overrides (`~/.kriyadot/prompts/summarizer.md`, hot-reloaded).
 * The store is module-level so the override file is re-read by mtime on
 * every summarization — no restart, no watcher needed.
 */
const promptOverrides = new PromptOverrideStore();

/** Built-in summarizer stage prompt (loses to ~/.kriyadot/prompts/summarizer.md). */
const BUILTIN_SUMMARIZER_PROMPT =
  'Summarize this agent conversation into a compact briefing for continuing the work. ' +
  'Capture: the user goal, key decisions made, files touched, tool results that matter, ' +
  'and open threads. Be dense and factual. Under 800 tokens.';

function renderMessage(m: ChatMessage): string {
  const content = typeof m.content === 'string' ? m.content : '[non-text content]';
  const toolNote =
    m.role === 'tool' ? ` [tool:${(m as { toolName?: string }).toolName ?? '?'}]` : '';
  return `### ${m.role}${toolNote}\n${content.slice(0, 2000)}`;
}

function extractiveFallback(messages: ChatMessage[]): string {
  const head = messages.slice(0, 3).map(renderMessage).join('\n\n');
  const tail = messages.slice(-5).map(renderMessage).join('\n\n');
  return [
    `[extractive summary — no summarization model available; ${messages.length} earlier messages compacted]`,
    'Earliest messages:',
    head,
    '…',
    'Most recent of the compacted range:',
    tail,
  ].join('\n\n');
}

/**
 * Build the default SessionSummarizer. Safe to use without any API key
 * (falls back to extractive). Uses only free-tier-friendly models.
 *
 * `promptStore` (tests): stage-prompt override store; defaults to the
 * module-level store against ~/.kriyadot/prompts.
 *
 * `profiles` (Octomind parity — purpose-based model profiles): the
 * 'compression' purpose profile picks the provider/model; unset keeps
 * the historical default (Groq llama-3.1-8b-instant).
 */
export function createSummarizer(
  promptStore?: PromptOverrideStore,
  profiles?: ModelProfiles,
): (messages: ChatMessage[]) => Promise<string> {
  return async (messages: ChatMessage[]): Promise<string> => {
    if (messages.length === 0) return '[empty range]';
    const input = messages.map(renderMessage).join('\n\n').slice(0, MAX_INPUT_CHARS);
    // Stage-prompt override: a user-authored ~/.kriyadot/prompts/summarizer.md
    // wins; otherwise the built-in prompt below. Resolved per call so edits
    // hot-reload without a restart.
    const store = promptStore ?? promptOverrides;
    const systemPrompt = store.resolve('summarizer', BUILTIN_SUMMARIZER_PROMPT).text;
    // Closure #8/#11: the 'summarizer' purpose profile wins; 'compression'
    // remains the fallback (session compaction shares this driver).
    const profile =
      resolvePurposeProfile('summarizer', { profiles }) ??
      resolvePurposeProfile('compression', { profiles });
    try {
      // Zero-setup installs: fall back to a keyless lane when the
      // profile's provider has no key configured (fresh install), so
      // compaction still summarizes instead of failing outright.
      const resolved = createProviderWithKeylessFallback(profile?.providerId ?? 'groq');
      const provider = resolved.provider;
      const turn = await provider.chat(
        [
          {
            role: 'system',
            content: systemPrompt,
          },
          { role: 'user', content: input },
        ],
        [],
        {
          model: resolved.fellBack && resolved.model ? resolved.model : (profile?.modelId ?? 'llama-3.1-8b-instant'),
          // Full knob set forwarded (#8), incl. retry/timeout (#11).
          ...(profile?.temperature !== undefined ? { temperature: profile.temperature } : {}),
          ...(profile?.topP !== undefined ? { topP: profile.topP } : {}),
          ...(profile?.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {}),
          ...(profile?.reasoningEffort !== undefined ? { reasoningEffort: profile.reasoningEffort } : {}),
          ...(profile?.maxRetries !== undefined ? { maxRetries: profile.maxRetries } : {}),
          ...(profile?.timeoutMs !== undefined ? { timeoutMs: profile.timeoutMs } : {}),
        },
      );
      const summary = turn.content?.trim();
      if (summary) return summary;
    } catch {
      // No key / provider down / model unavailable → extractive fallback.
    }
    return extractiveFallback(messages);
  };
}
