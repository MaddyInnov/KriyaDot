// SPDX-License-Identifier: Apache-2.0
// Jupyter notebook tools (CA-14): cell-level read/edit of `.ipynb` files.
//
// Notebooks are JSON documents; naive text edits corrupt them easily, so
// these tools operate on the parsed structure: read lists cells with
// their index/id/type/source, edit replaces, inserts or deletes one cell
// by index or id. The nbformat structure (nbformat, nbformat_minor,
// metadata, and untouched cells verbatim) is preserved on write, and the
// output is written back as JSON with Jupyter's conventional 1-space
// indent. Both tools are confined to the workspace like the other
// coding tools (the caller passes an already-confined absolute path
// resolver).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ToolDefinition } from '../types.js';
import { resolveWorkspaceDir, type WorkspaceSource } from '../workspaces.js';
import { confineRealpath } from '../confine.js';

interface NotebookCell {
  cell_type: string;
  id?: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
  [key: string]: unknown;
}

interface NotebookDoc {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
  [key: string]: unknown;
}

function cellSourceText(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
}

/** Source strings are stored by Jupyter as arrays of lines; mirror that. */
function toSourceLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  return parts.map((p, i) => (i < parts.length - 1 ? p + '\n' : p)).filter((p) => p !== '' || parts.length === 1);
}

function loadNotebook(abs: string, label: string): NotebookDoc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`notebook: "${label}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as NotebookDoc).cells)) {
    throw new Error(`notebook: "${label}" is not a Jupyter notebook (no cells array)`);
  }
  const nb = parsed as NotebookDoc;
  if (typeof nb.nbformat !== 'number') nb.nbformat = 4;
  if (typeof nb.nbformat_minor !== 'number') nb.nbformat_minor = 5;
  if (typeof nb.metadata !== 'object' || nb.metadata === null) nb.metadata = {};
  return nb;
}

function saveNotebook(abs: string, nb: NotebookDoc): void {
  writeFileSync(abs, JSON.stringify(nb, null, 1) + '\n', 'utf8');
}

function findCellIndex(nb: NotebookDoc, args: Record<string, unknown>): number {
  if (typeof args.cellId === 'string' && args.cellId) {
    const idx = nb.cells.findIndex((c) => c.id === args.cellId);
    if (idx === -1) throw new Error(`notebook_edit: no cell with id "${args.cellId}"`);
    return idx;
  }
  const idx = Number(args.cellIndex);
  if (!Number.isInteger(idx)) {
    throw new Error('notebook_edit: provide cellIndex (0-based) or cellId');
  }
  return idx;
}

export function notebookReadTool(workspaceDir: WorkspaceSource, confineFn: (ws: string, p: string) => string): ToolDefinition {
  return {
    name: 'notebook_read',
    description:
      'Read a Jupyter notebook (.ipynb) in the workspace as a cell list: index, id, ' +
      'type (code/markdown/raw), source text, and output summaries for code cells. ' +
      'Use notebook_edit for cell-level changes instead of editing the raw JSON.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative .ipynb path' },
        includeOutputs: { type: 'boolean', description: 'Include code-cell output text summaries (default false)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      const abs = confineFn(ws, String(args.path));
      if (!existsSync(abs)) throw new Error(`notebook_read: file does not exist: "${args.path}"`);
      const nb = loadNotebook(abs, String(args.path));
      const cells = nb.cells.map((cell, index) => ({
        index,
        ...(cell.id ? { id: cell.id } : {}),
        type: cell.cell_type,
        source: cellSourceText(cell),
        ...(cell.cell_type === 'code'
          ? {
              executionCount: cell.execution_count ?? null,
              outputCount: Array.isArray(cell.outputs) ? cell.outputs.length : 0,
              ...(args.includeOutputs === true && Array.isArray(cell.outputs)
                ? {
                    outputs: cell.outputs.map((o) => {
                      const out = o as Record<string, unknown>;
                      const text = out.text ?? (out.data as Record<string, unknown> | undefined)?.['text/plain'];
                      return {
                        outputType: out.output_type,
                        ...(text !== undefined
                          ? { text: (Array.isArray(text) ? text.join('') : String(text)).slice(0, 500) }
                          : {}),
                      };
                    }),
                  }
                : {}),
            }
          : {}),
      }));
      return {
        path: String(args.path),
        nbformat: nb.nbformat,
        nbformatMinor: nb.nbformat_minor,
        cellCount: cells.length,
        cells,
      };
    },
  };
}

export function notebookEditTool(workspaceDir: WorkspaceSource, confineFn: (ws: string, p: string) => string): ToolDefinition {
  return {
    name: 'notebook_edit',
    mutating: true,
    description:
      'Edit one cell of a Jupyter notebook (.ipynb) in the workspace. Actions: ' +
      '"replace" (set a cell\'s source, by cellIndex or cellId), "insert" (add a new ' +
      'cell after cellIndex, or at the end when cellIndex is omitted; cellType ' +
      'code|markdown|raw), "delete" (remove a cell by cellIndex or cellId). ' +
      'The nbformat structure and all other cells are preserved.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative .ipynb path' },
        action: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Edit action' },
        cellIndex: { type: 'number', description: '0-based cell index (replace/delete: target; insert: insert after this index)' },
        cellId: { type: 'string', description: 'Cell id (alternative to cellIndex for replace/delete)' },
        cellType: { type: 'string', enum: ['code', 'markdown', 'raw'], description: 'Cell type for insert (default code)' },
        source: { type: 'string', description: 'New cell source text (replace/insert)' },
      },
      required: ['path', 'action'],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const ws = resolveWorkspaceDir(workspaceDir, ctx);
      const abs = confineFn(ws, String(args.path));
      if (!existsSync(abs)) throw new Error(`notebook_edit: file does not exist: "${args.path}"`);
      const nb = loadNotebook(abs, String(args.path));
      const action = String(args.action);

      if (action === 'insert') {
        const cellType = typeof args.cellType === 'string' ? args.cellType : 'code';
        if (!['code', 'markdown', 'raw'].includes(cellType)) {
          throw new Error(`notebook_edit: invalid cellType "${cellType}"`);
        }
        const after = args.cellIndex === undefined ? nb.cells.length - 1 : Number(args.cellIndex);
        if (!Number.isInteger(after) || after < -1 || after >= nb.cells.length) {
          throw new Error(`notebook_edit: insert cellIndex ${String(args.cellIndex)} out of range (-1..${nb.cells.length - 1})`);
        }
        const cell: NotebookCell = {
          cell_type: cellType,
          metadata: {},
          source: toSourceLines(String(args.source ?? '')),
          ...(cellType === 'code' ? { outputs: [], execution_count: null } : {}),
        };
        nb.cells.splice(after + 1, 0, cell);
        saveNotebook(abs, nb);
        return { path: String(args.path), action, insertedAt: after + 1, cellCount: nb.cells.length };
      }

      const idx = findCellIndex(nb, args);
      if (idx < 0 || idx >= nb.cells.length) {
        throw new Error(`notebook_edit: cellIndex ${idx} out of range (0..${nb.cells.length - 1})`);
      }
      if (action === 'replace') {
        const cell = nb.cells[idx]!;
        cell.source = toSourceLines(String(args.source ?? ''));
        if (typeof args.cellType === 'string' && ['code', 'markdown', 'raw'].includes(args.cellType)) {
          cell.cell_type = args.cellType;
        }
        saveNotebook(abs, nb);
        return { path: String(args.path), action, cellIndex: idx, ...(cell.id ? { cellId: cell.id } : {}), cellCount: nb.cells.length };
      }
      if (action === 'delete') {
        const [removed] = nb.cells.splice(idx, 1);
        saveNotebook(abs, nb);
        return {
          path: String(args.path),
          action,
          cellIndex: idx,
          ...(removed?.id ? { cellId: removed.id } : {}),
          cellCount: nb.cells.length,
        };
      }
      throw new Error(`notebook_edit: unknown action "${action}" (use replace|insert|delete)`);
    },
  };
}

/** Standalone confine used when the tools are built outside coding.ts. */
export function confineNotebookPath(ws: string, p: string): string {
  return confineRealpath(ws, p);
}
