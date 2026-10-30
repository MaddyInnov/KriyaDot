// SPDX-License-Identifier: Apache-2.0
// MCP elicitation — terminal route (#51, CLI side).
//
// The runtime side lives in packages/agent-runtime/src/mcp.ts: an
// ElicitationRouter routes each server-initiated elicitation/create
// request to the handler registered for the client's surface
// ('cli' — ELICITATION_SURFACES.cli). This module is that surface's
// handler, shaped exactly like the runtime's ElicitationHandler:
//
//   (req: { message, requestedSchema }) => Promise<{ action, content? }>
//
// A host that runs MCP clients in-process registers it once:
//   import { defaultElicitationRouter, ELICITATION_SURFACES } from '@mvp/agent-runtime';
//   defaultElicitationRouter.register(ELICITATION_SURFACES.cli,
//     createTerminalElicitationHandler({ ask, isInteractive: () => process.stdin.isTTY }));
//
// Behaviour: interactive terminals are prompted per requested property
// (enum → numbered choices, boolean → y/n, number → numeric parse,
// string → free text). An empty answer at the first prompt, or an
// explicit "cancel", cancels. NON-interactive runs decline with a clear
// log line — headless turns never hang waiting for input that cannot
// come. The CLI binary itself talks to the API server (MCP runs there),
// so inside this package the handler is also used to answer the
// 'elicitation' notice path in repl.ts should a surface deliver one.

export interface ElicitationRequestLike {
  message: string;
  requestedSchema: Record<string, unknown>;
}

export interface ElicitationResultLike {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

export interface TerminalElicitationDeps {
  /** Ask one question; resolves with the raw answer, or null on EOF. */
  ask: (question: string) => Promise<string | null>;
  /** True when a human can actually answer (TTY stdin). */
  isInteractive: () => boolean;
  /** Diagnostic sink (stderr in the real CLI). */
  log: (msg: string) => void;
}

interface SchemaProp {
  type?: string;
  enum?: unknown[];
  description?: string;
}

function propsOf(schema: Record<string, unknown>): Array<[string, SchemaProp]> {
  const props = schema.properties;
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return [];
  return Object.entries(props as Record<string, SchemaProp>);
}

function requiredOf(schema: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).filter((x): x is string => typeof x === 'string') : []);
}

/** Coerce one raw terminal answer to the property's declared type; { ok:false } = unusable answer. */
export function coerceElicitationAnswer(
  raw: string,
  prop: SchemaProp,
): { ok: true; value: unknown } | { ok: false } {
  const v = raw.trim();
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const options = prop.enum.map((e) => String(e));
    const asIndex = Number(v);
    if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= options.length) {
      const chosen = options[asIndex - 1]!;
      const typed = prop.enum.find((e) => String(e) === chosen);
      return { ok: true, value: typed ?? chosen };
    }
    const exact = prop.enum.find((e) => String(e) === v);
    return exact !== undefined ? { ok: true, value: exact } : { ok: false };
  }
  switch (prop.type) {
    case 'boolean': {
      const low = v.toLowerCase();
      if (['y', 'yes', 'true', '1'].includes(low)) return { ok: true, value: true };
      if (['n', 'no', 'false', '0'].includes(low)) return { ok: true, value: false };
      return { ok: false };
    }
    case 'number':
    case 'integer': {
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false };
      if (prop.type === 'integer' && !Number.isInteger(n)) return { ok: false };
      return { ok: true, value: n };
    }
    default:
      return { ok: true, value: v };
  }
}

export function createTerminalElicitationHandler(
  deps: TerminalElicitationDeps,
): (req: ElicitationRequestLike) => Promise<ElicitationResultLike> {
  return async (req) => {
    if (!deps.isInteractive()) {
      deps.log(
        `[elicitation] declined (non-interactive terminal): an MCP server asked "${req.message}" — re-run interactively to answer, or configure the server so it does not elicit.`,
      );
      return { action: 'decline' };
    }
    const props = propsOf(req.requestedSchema);
    deps.log(`[elicitation] ${req.message}`);
    if (props.length === 0) {
      const answer = await deps.ask('[elicitation] answer (empty = cancel): ');
      if (answer === null || !answer.trim()) return { action: 'cancel' };
      return { action: 'accept', content: { value: answer.trim() } };
    }
    const required = requiredOf(req.requestedSchema);
    const content: Record<string, unknown> = {};
    for (const [name, prop] of props) {
      const hint = prop.description ? ` — ${prop.description}` : '';
      let question = `[elicitation] ${name}${hint}: `;
      if (Array.isArray(prop.enum) && prop.enum.length > 0) {
        const opts = prop.enum.map((e, i) => `${i + 1}) ${String(e)}`).join('  ');
        question = `[elicitation] ${name}${hint}\n  ${opts}\n  choose a number or value: `;
      } else if (prop.type === 'boolean') {
        question = `[elicitation] ${name}${hint} [y/n]: `;
      }
      const answer = await deps.ask(question);
      if (answer === null) return { action: 'cancel' };
      if (!answer.trim()) {
        if (required.has(name)) {
          deps.log(`[elicitation] cancelled — "${name}" is required and was left empty.`);
          return { action: 'cancel' };
        }
        continue; // optional + empty = omitted
      }
      const coerced = coerceElicitationAnswer(answer, prop);
      if (!coerced.ok) {
        deps.log(`[elicitation] declined — answer "${answer.trim()}" is not valid for "${name}".`);
        return { action: 'decline' };
      }
      content[name] = coerced.value;
    }
    return { action: 'accept', content };
  };
}

/** Duck-typed registration against the runtime's ElicitationRouter (avoids a package dependency on @mvp/agent-runtime). */
export function registerCliElicitation(
  router: { register: (surface: string, handler: (req: ElicitationRequestLike) => Promise<ElicitationResultLike>) => unknown },
  handler: (req: ElicitationRequestLike) => Promise<ElicitationResultLike>,
): void {
  router.register('cli', handler);
}
