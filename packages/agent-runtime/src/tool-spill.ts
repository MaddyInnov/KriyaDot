// SPDX-License-Identifier: Apache-2.0
/**
 * Tool-result spill: oversized tool results are written to the bot
 * workspace spill dir; the model receives a truncated preview plus a
 * spill reference it can page through with read_spilled_result.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from './types.js';
export const DEFAULT_SPILL_THRESHOLD_BYTES = 32 * 1024;
export interface SpillRef { id: string; path: string; bytes: number; preview: string; }
let seq = 0;
export class ToolSpillStore {
  constructor(private readonly dir: string, readonly thresholdBytes = DEFAULT_SPILL_THRESHOLD_BYTES) {}
  get spillDir(): string { return this.dir; }
  maybeSpill(toolName: string, content: string): SpillRef | null {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes <= this.thresholdBytes) return null;
    mkdirSync(this.dir, { recursive: true });
    const id = `spill_${Date.now().toString(36)}_${++seq}`;
    const path = join(this.dir, `${id}.txt`);
    writeFileSync(path, content, 'utf8');
    return { id, path, bytes, preview: content.slice(0, 2000) };
  }
  read(id: string, offset = 0, length = 8000): { content: string; totalBytes: number; offset: number; nextOffset: number | null } | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    const path = join(this.dir, `${id}.txt`);
    if (!existsSync(path)) return null;
    const full = readFileSync(path, 'utf8');
    const slice = full.slice(Math.max(0,offset), Math.max(0,offset)+Math.max(1,length));
    const next = offset + slice.length < full.length ? offset + slice.length : null;
    return { content: slice, totalBytes: Buffer.byteLength(full,'utf8'), offset, nextOffset: next };
  }
  formatForModel(toolName: string, ref: SpillRef): string {
    return `[tool result too large (${ref.bytes} bytes) — spilled to workspace]\nSpill reference: ${ref.id} (tool: ${toolName})\nPreview:\n${ref.preview}\n[use read_spilled_result with id="${ref.id}" to read more in chunks]`;
  }
}
export function createSpillTools(store: ToolSpillStore): ToolDefinition[] {
  return [{
    name: 'read_spilled_result', description: 'Read a chunk of a spilled (oversized) tool result by its spill reference id.',
    parameters: { type:'object', properties:{ id:{type:'string'}, offset:{type:'number'}, length:{type:'number'} }, required:['id'] },
    handler: async (args) => {
      const r = store.read(typeof args.id==='string'?args.id:'', typeof args.offset==='number'?args.offset:0, typeof args.length==='number'?args.length:8000);
      return r ?? { error: 'spilled result not found' };
    },
  }];
}
