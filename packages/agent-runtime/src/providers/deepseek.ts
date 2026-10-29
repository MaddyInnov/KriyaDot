// SPDX-License-Identifier: Apache-2.0
/**
 * DeepSeek harness depth (ENGINES pack): per-bot thinking/reasoning
 * selection for BOTH DeepSeek surfaces, as pure request shaping.
 *
 * API surface (catalog preset `deepseek`, OpenAI-compatible):
 * - `deepseek-chat` is the fast chat model; `deepseek-reasoner` is the
 *   reasoning model. A bot picks thinking per-bot via
 *   `modelOptions.deepseekMode` ('chat' | 'reasoner') without changing
 *   its pinned model string, and `modelOptions.reasoningEffort` passes
 *   through as the wire `reasoning_effort` for the reasoner.
 * - An explicit model on the turn always wins over the mode default:
 *   the mode only resolves WHICH DeepSeek model serves when the caller
 *   did not already name one (or named the sibling).
 *
 * Harness surface (`dsh --profile acp`, preset `deepseek-harness`):
 * - Picker ids are `<provider>/<model>`; the ACP `model` config option
 *   takes the wire pair `["<provider>","<model>"]` (JSON).
 * - The `reasoning_effort` config option accepts off | low | high | max;
 *   KriyaDot's low/medium/high map onto low/high/max.
 *
 * Everything here is pure — no I/O, no keys, no network.
 */

import type { ModelOptions } from '../types.js';

export const DEEPSEEK_CHAT_MODEL = 'deepseek-chat';
export const DEEPSEEK_REASONER_MODEL = 'deepseek-reasoner';

export type DeepSeekMode = 'chat' | 'reasoner';

/** The DeepSeek API model that serves a thinking mode. */
export function deepSeekModelForMode(mode: DeepSeekMode): string {
  return mode === 'reasoner' ? DEEPSEEK_REASONER_MODEL : DEEPSEEK_CHAT_MODEL;
}

export interface DeepSeekRequestShape {
  /** Model to put on the wire. */
  model: string;
  /** Wire reasoning_effort, present only for the reasoner model. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** True when the shape engages thinking (reasoner model selected). */
  thinking: boolean;
}

/**
 * Resolve the wire shape for one DeepSeek API turn from the requested
 * model + the bot's model options.
 *
 * Rules:
 * - deepseekMode 'reasoner' selects the reasoner model UNLESS the caller
 *   explicitly pinned deepseek-chat for this turn (explicit pin wins —
 *   `requestedModel` counts as explicit when it is a DeepSeek model id
 *   different from the mode's model AND `opts` carries no mode… see
 *   below). In practice: an explicit DeepSeek model id in
 *   `requestedModel` always wins; the mode only applies when the
 *   requested model is empty or the provider default.
 * - reasoningEffort passes through only for the reasoner (the chat model
 *   rejects/ignores effort knobs); default effort for the reasoner when
 *   the mode selected it is 'high' unless the bot set one.
 */
export function shapeDeepSeekRequest(
  requestedModel: string | undefined,
  modelOptions: ModelOptions | undefined,
): DeepSeekRequestShape {
  const requested = (requestedModel ?? '').trim();
  const isDeepSeekModel = requested === DEEPSEEK_CHAT_MODEL || requested === DEEPSEEK_REASONER_MODEL;
  const mode = modelOptions?.deepseekMode;
  let model: string;
  if (isDeepSeekModel) {
    model = requested;
  } else if (mode) {
    model = deepSeekModelForMode(mode);
  } else if (requested) {
    model = requested;
  } else {
    model = DEEPSEEK_CHAT_MODEL;
  }
  const thinking = model === DEEPSEEK_REASONER_MODEL;
  if (!thinking) return { model, thinking: false };
  const effort = modelOptions?.reasoningEffort ?? (mode === 'reasoner' ? 'high' : undefined);
  return { model, thinking: true, ...(effort ? { reasoningEffort: effort } : {}) };
}

/**
 * Shape the JSON body fields for a DeepSeek chat-completions request:
 * applies shapeDeepSeekRequest on top of a base body (model +
 * reasoning_effort). Returns a new object; the input is not mutated.
 */
export function applyDeepSeekShaping<T extends Record<string, unknown>>(
  body: T,
  modelOptions: ModelOptions | undefined,
): T {
  const shape = shapeDeepSeekRequest(typeof body.model === 'string' ? body.model : undefined, modelOptions);
  const out: Record<string, unknown> = { ...body, model: shape.model };
  if (shape.reasoningEffort) out.reasoning_effort = shape.reasoningEffort;
  else if (!shape.thinking) delete out.reasoning_effort;
  return out as T;
}

// ---------------------------------------------------------------------------
// dsh ACP harness wire shaping.
// ---------------------------------------------------------------------------

/** `<provider>/<model>` picker id → the harness wire pair `["provider","model"]`. */
export function deepseekWireValue(pickerId: string): string {
  const slash = pickerId.indexOf('/');
  if (slash <= 0 || slash === pickerId.length - 1) return pickerId;
  return JSON.stringify([pickerId.slice(0, slash), pickerId.slice(slash + 1)]);
}

/** Inverse of deepseekWireValue; null for anything but a two-string pair. */
export function deepseekPickerId(wireValue: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wireValue) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [provider, model] = parsed as [unknown, unknown];
  if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) return null;
  return `${provider}/${model}`;
}

export type DshReasoningEffort = 'off' | 'low' | 'high' | 'max';

/**
 * Map KriyaDot model options onto the harness `reasoning_effort` config
 * value: thinking off for chat mode, otherwise low→low, medium→high,
 * high→max (the harness has no 'medium').
 */
export function dshReasoningEffort(modelOptions: ModelOptions | undefined): DshReasoningEffort {
  if (modelOptions?.deepseekMode === 'chat') return 'off';
  switch (modelOptions?.reasoningEffort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'high';
    case 'high':
      return 'max';
    default:
      return modelOptions?.deepseekMode === 'reasoner' ? 'high' : 'off';
  }
}

/**
 * The ACP session config options for one dsh turn: the `model` wire pair
 * plus `reasoning_effort`, shaped from the picker model + bot options.
 * Hosts apply these via session/set_config_option after session/new.
 */
export function dshSessionConfig(
  pickerModel: string,
  modelOptions: ModelOptions | undefined,
): Array<{ configId: string; value: string }> {
  return [
    { configId: 'model', value: deepseekWireValue(pickerModel) },
    { configId: 'reasoning_effort', value: dshReasoningEffort(modelOptions) },
  ];
}
