// SPDX-License-Identifier: Apache-2.0
/**
 * Recall tool (Octomind parity — adaptive compression): compaction is
 * LOSSLESS. Every folded range is archived verbatim before it is
 * summarized, the compaction header names the archive ids, and this
 * tool dereferences one archive back into the original messages so the
 * model can re-read exactly what was folded away. Archives are scoped
 * to the session that produced them.
 */

import type { SessionStore } from '../sessions.js';
import type { ToolDefinition } from '../types.js';

const MAX_MESSAGE_CHARS = 1_000;
const MAX_TOTAL_CHARS = 12_000;

export function createRecallTools(store: SessionStore): ToolDefinition[] {
  return [
    {
      name: 'recall_compacted_context',
      description:
        'Recall the ORIGINAL messages that were folded into a compaction summary. ' +
        'Use an archive id from the "[lossless archive: ...]" note in the compacted ' +
        'summary header when the summary lacks a detail you need.',
      parameters: {
        type: 'object',
        properties: {
          archiveId: {
            type: 'string',
            description: 'Archive id from the compaction header, e.g. "arc-<session>-<from>-<to>".',
          },
        },
        required: ['archiveId'],
      },
      mutating: false,
      handler: async (args, ctx) => {
        const archiveId = typeof args.archiveId === 'string' ? args.archiveId : '';
        if (!archiveId) return { error: 'archiveId is required' };
        const found = store.readArchive(archiveId);
        if (!found) {
          return {
            error: `No compaction archive "${archiveId}" exists. Archive ids appear in the compacted summary header of this session.`,
          };
        }
        if (found.entry.sessionId !== ctx.sessionId) {
          return { error: 'That archive belongs to a different session and cannot be recalled here.' };
        }
        const lines: string[] = [
          `Archive ${found.entry.id}: ${found.messages.length} original message(s), folded with summary: ${found.entry.summary.slice(0, 300)}`,
        ];
        let used = lines[0]!.length;
        for (const m of found.messages) {
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          const line = `${m.role}${m.toolName ? ` (${m.toolName})` : ''}: ${content.slice(0, MAX_MESSAGE_CHARS)}`;
          if (used + line.length > MAX_TOTAL_CHARS) {
            lines.push('…[recall output truncated — the archive holds more messages]');
            break;
          }
          lines.push(line);
          used += line.length;
        }
        return { archiveId, messages: lines.join('\n\n') };
      },
    },
  ];
}
