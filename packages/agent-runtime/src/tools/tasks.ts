// SPDX-License-Identifier: Apache-2.0
/**
 * Free-standing agent todo toolset (closure CA-12).
 *
 * The supervisor plan tools (get_plan / update_plan_step in runtime.ts)
 * only exist when a supervisor plan already exists. These tools are the
 * model-owned counterpart (Claude Code TaskCreate/List/Update,
 * OpenCode TodoWrite): the agent can start and maintain its OWN task
 * list on any task, in any session, with no plan prerequisite.
 *
 * Storage: a per-session in-memory store (AgentTodoStore), deliberately
 * SEPARATE from the supervisor's plan store — the supervisor owns its
 * plan; the model owns these todos. Rendering seam: `store.list(sessionId)`
 * (and the `getSessionTodos` helper on the default store) is the getter
 * the chat / Activity surfaces read; each session record the host keeps
 * can attach `todos: todoStore.list(sessionId)` without further wiring.
 * See the Wave-3 WIRING note.
 */

import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolDefinition } from '../types.js';

export type AgentTodoStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export interface AgentTodo {
  id: string;
  title: string;
  status: AgentTodoStatus;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

const TODO_STATUSES: readonly AgentTodoStatus[] = ['pending', 'in_progress', 'done', 'blocked'];

export function isAgentTodoStatus(v: unknown): v is AgentTodoStatus {
  return typeof v === 'string' && (TODO_STATUSES as readonly string[]).includes(v);
}

/** Per-session, model-owned todo store. */
export class AgentTodoStore {
  private readonly bySession = new Map<string, Map<string, AgentTodo>>();

  private sessionMap(sessionId: string): Map<string, AgentTodo> {
    let m = this.bySession.get(sessionId);
    if (!m) {
      m = new Map();
      this.bySession.set(sessionId, m);
    }
    return m;
  }

  create(sessionId: string, title: string, note?: string): AgentTodo {
    const now = Date.now();
    const todo: AgentTodo = {
      id: `task-${randomUUID().slice(0, 8)}`,
      title: title.slice(0, 300),
      status: 'pending',
      ...(note ? { note: note.slice(0, 1000) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.sessionMap(sessionId).set(todo.id, todo);
    return { ...todo };
  }

  list(sessionId: string): AgentTodo[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => ({ ...t }));
  }

  get(sessionId: string, id: string): AgentTodo | undefined {
    const t = this.bySession.get(sessionId)?.get(id);
    return t ? { ...t } : undefined;
  }

  update(
    sessionId: string,
    id: string,
    patch: { status?: AgentTodoStatus; title?: string; note?: string },
  ): AgentTodo | undefined {
    const t = this.bySession.get(sessionId)?.get(id);
    if (!t) return undefined;
    if (patch.status !== undefined) t.status = patch.status;
    if (typeof patch.title === 'string' && patch.title) t.title = patch.title.slice(0, 300);
    if (typeof patch.note === 'string') t.note = patch.note.slice(0, 1000);
    t.updatedAt = Date.now();
    return { ...t };
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

/** Default store used when a host doesn't supply its own. */
export const defaultTodoStore = new AgentTodoStore();

/** Chat/Activity render seam: the todos a surface should show for a session. */
export function getSessionTodos(sessionId: string, store: AgentTodoStore = defaultTodoStore): AgentTodo[] {
  return store.list(sessionId);
}

export interface TaskToolsOptions {
  store?: AgentTodoStore;
}

export function createTaskTools(opts: TaskToolsOptions = {}): ToolDefinition[] {
  const store = opts.store ?? defaultTodoStore;
  return [
    {
      name: 'task_create',
      description:
        'Add an item to YOUR OWN task list for this session (works on any task — no supervisor plan ' +
        'needed). Use it to plan multi-step work and track progress visibly. Returns the task id.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative task title' },
          note: { type: 'string', description: 'Optional detail / context for the task' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        if (!title) return { error: 'task_create: "title" must not be empty' };
        const todo = store.create(
          ctx.sessionId,
          title,
          typeof args.note === 'string' ? args.note : undefined,
        );
        return { task: todo, tasks: store.list(ctx.sessionId) };
      },
    },
    {
      name: 'task_list',
      description: 'List your task list for this session (id, title, status, note).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (_args: Record<string, unknown>, ctx: ToolContext) => ({
        tasks: store.list(ctx.sessionId),
      }),
    },
    {
      name: 'task_update',
      mutating: false,
      description:
        'Update one of your tasks: status (pending | in_progress | done | blocked), title, or note. ' +
        'Mark a task in_progress when you start it and done when it is actually complete.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from task_create / task_list' },
          status: { type: 'string', description: 'pending | in_progress | done | blocked' },
          title: { type: 'string', description: 'Replacement title' },
          note: { type: 'string', description: 'Replacement note' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>, ctx: ToolContext) => {
        const id = typeof args.id === 'string' ? args.id : '';
        if (!id) return { error: 'task_update: "id" is required' };
        if (args.status !== undefined && !isAgentTodoStatus(args.status)) {
          return { error: 'task_update: "status" must be pending | in_progress | done | blocked' };
        }
        const updated = store.update(ctx.sessionId, id, {
          status: isAgentTodoStatus(args.status) ? args.status : undefined,
          title: typeof args.title === 'string' ? args.title : undefined,
          note: typeof args.note === 'string' ? args.note : undefined,
        });
        return updated
          ? { task: updated, tasks: store.list(ctx.sessionId) }
          : { error: `task_update: no task "${id}" in this session` };
      },
    },
  ];
}
