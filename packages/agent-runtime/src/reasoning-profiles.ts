// SPDX-License-Identifier: Apache-2.0
/**
 * Reasoning-effort profiles: map a bot's reasoning setting
 * (low|medium|high) onto provider-family parameters.
 *  - OpenAI-style: { reasoning_effort }
 *  - Anthropic: extended-thinking budget tokens
 *  - DeepSeek: reasoner model selection (deepseek-reasoner) for
 *    medium/high; chat model for low.
 * Unsupported families return an empty shaping (ignored gracefully).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';
export type ProviderFamily = 'openai' | 'anthropic' | 'deepseek' | 'other';
export function providerFamily(providerId: string): ProviderFamily {
  const id = providerId.toLowerCase();
  if (id.includes('deepseek')) return 'deepseek';
  if (id.includes('anthropic') || id.includes('claude')) return 'anthropic';
  if (id.includes('openai') || id.includes('groq') || id.includes('openrouter') || id.includes('custom')) return 'openai';
  return 'other';
}
export const ANTHROPIC_THINKING_BUDGET: Record<ReasoningEffort, number> = { low: 1024, medium: 4096, high: 16000 };
export interface ReasoningShaping { body: Record<string, unknown>; model?: string; family: ProviderFamily; applied: boolean; }
export function shapeReasoning(providerId: string, model: string, effort?: ReasoningEffort): ReasoningShaping {
  const family = providerFamily(providerId);
  if (!effort) return { body: {}, family, applied: false };
  switch (family) {
    case 'openai': return { body: { reasoning_effort: effort }, family, applied: true };
    case 'anthropic': return { body: { thinking: { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET[effort] } }, family, applied: true };
    case 'deepseek': {
      const useReasoner = effort !== 'low';
      return { body: {}, model: useReasoner ? 'deepseek-reasoner' : 'deepseek-chat', family, applied: true };
    }
    default: return { body: {}, family, applied: false };
  }
}
/** Build the Anthropic request fragment (thinking + max_tokens headroom). */
export function anthropicThinkingFields(effort?: ReasoningEffort, maxTokens?: number): Record<string, unknown> {
  if (!effort) return {};
  const budget = ANTHROPIC_THINKING_BUDGET[effort];
  return { thinking: { type: 'enabled', budget_tokens: budget }, max_tokens: Math.max(maxTokens ?? 4096, budget + 1024) };
}
