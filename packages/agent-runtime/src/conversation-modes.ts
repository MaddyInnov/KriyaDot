// SPDX-License-Identifier: Apache-2.0
/**
 * Conversation modes per thread (Octop #39) + Chief host restriction.
 *
 * mode:
 *  - 'ask'   — no tools at all (pure Q&A)
 *  - 'plan'  — read-only tools only, plus the plan gate handled by the
 *              caller (runtime planMode). Mutating + mcp: tools filtered.
 *  - 'craft' — normal (no filtering)
 *
 * Distinct from approval modes: approval modes decide HOW a permitted
 * tool is approved; conversation mode decides WHETHER tools exist for
 * the turn at all. They compose by intersection: a tool must pass the
 * conversation-mode filter first, then normal governance/approval runs.
 *
 * Chief host restriction reuses the same filter: when enabled for the
 * Chief bot, only scheduling/delegation tools survive (an allow-list),
 * regardless of conversation mode (intersection of both filters).
 */
import type { ToolDefinition } from './types.js';
export type ConversationMode = 'ask' | 'plan' | 'craft';
export const CONVERSATION_MODES: readonly ConversationMode[] = ['ask','plan','craft'];
export function isConversationMode(v: unknown): v is ConversationMode { return v==='ask'||v==='plan'||v==='craft'; }
export const CHIEF_HOST_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'delegate','delegate_background','list_background_runs','stop_background_run',
  'schedule_task','list_schedules','cancel_schedule','create_monitor',
  'create_trigger','list_triggers','delete_trigger',
  'coordinate_bots','propose_team_setup','create_bot','propose_bot_deletion','raise_escalation','retry_thread',
  'ask_bot','message_bot',
]);
export function isReadOnlyTool(def: ToolDefinition): boolean {
  return def.mutating !== true && !def.name.startsWith('mcp:');
}
export function filterToolsForMode(tools: ToolDefinition[], opts: { mode?: ConversationMode; chiefHostRestricted?: boolean } = {}): ToolDefinition[] {
  let out = tools;
  const mode = opts.mode ?? 'craft';
  if (mode === 'ask') out = [];
  else if (mode === 'plan') out = out.filter(isReadOnlyTool);
  if (opts.chiefHostRestricted) out = out.filter(t => CHIEF_HOST_ALLOWED_TOOLS.has(t.name));
  return out;
}
