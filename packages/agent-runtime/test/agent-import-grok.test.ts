// SPDX-License-Identifier: Apache-2.0
// Grok bot export import (§1.7): fixture-based — maps name/instructions/
// model prefs onto a BotProposal and reports skipped fields honestly.

import { describe, expect, it } from 'vitest';
import { grokBotPreviewItem, parseGrokBotExport } from '../src/agent-import.js';

const FIXTURE = {
  name: 'Research Buddy',
  description: 'Digests papers',
  instructions: 'You are a meticulous research assistant.',
  model: 'grok-4',
  temperature: 0.4,
  tools: [{ name: 'web_search' }],
  knowledge_files: ['papers.pdf'],
  avatar_url: 'https://example.com/a.png',
};

describe('parseGrokBotExport', () => {
  it('maps the core fields from an object fixture', () => {
    const out = parseGrokBotExport(FIXTURE);
    expect(out.botProposal.name).toBe('Research Buddy');
    expect(out.botProposal.description).toBe('Digests papers');
    expect(out.botProposal.systemPrompt).toBe('You are a meticulous research assistant.');
    expect(out.botProposal.model).toBe('grok-4');
    expect(out.botProposal.provider).toBe('xai');
  });

  it('reports unmapped fields as skipped and sampling prefs as noted', () => {
    const out = parseGrokBotExport(FIXTURE);
    expect(out.skippedFields).toEqual(['avatar_url', 'knowledge_files', 'tools']);
    expect(out.notedFields).toEqual(['temperature']);
  });

  it('accepts JSON text and persona/system_prompt aliases', () => {
    const out = parseGrokBotExport(
      JSON.stringify({ name: 'P', persona: 'Be terse.', system_prompt: undefined }),
    );
    expect(out.botProposal.systemPrompt).toBe('Be terse.');
    expect(out.botProposal.model).toBe('grok-4'); // default
  });

  it('reads nested model preferences', () => {
    const out = parseGrokBotExport({
      name: 'Nested',
      instructions: 'hi',
      model_preferences: { model: 'grok-3-mini', temperature: 0.2, max_tokens: 500 },
    });
    expect(out.botProposal.model).toBe('grok-3-mini');
    expect(out.notedFields).toEqual(['model_preferences.max_tokens', 'model_preferences.temperature']);
    expect(out.skippedFields).toEqual([]);
  });

  it('redacts secrets embedded in instructions', () => {
    const out = parseGrokBotExport({
      name: 'Leaky',
      instructions: 'Use api_key = sk-1234567890abcdef for calls.',
    });
    expect(out.botProposal.systemPrompt).not.toContain('sk-1234567890abcdef');
  });

  it('throws on invalid JSON, non-objects, and missing names', () => {
    expect(() => parseGrokBotExport('{nope')).toThrow(/not valid JSON/);
    expect(() => parseGrokBotExport('[]')).toThrow(/must be a JSON object/);
    expect(() => parseGrokBotExport({ instructions: 'x' })).toThrow(/no "name"/);
  });

  it('preview item surfaces skipped fields', () => {
    const item = grokBotPreviewItem(parseGrokBotExport(FIXTURE));
    expect(item.kind).toBe('bot');
    expect(item.detail).toContain('tools');
    expect(item.lossy).toContain('knowledge_files');
  });
});
