// SPDX-License-Identifier: Apache-2.0
/**
 * Script-hook host wiring (Octomind parity #67 / #101).
 *
 * `createScriptHookHandler` in @mvp/agent-runtime existed as an
 * embedder-only API with zero host call sites. This module is the host
 * side:
 *
 *  - Bot/workspace config may declare script hooks:
 *      hooks: [{ kind: 'script', command: ['node','check.mjs'],
 *                events: ['tool.after','turn.ending'] }, ...]
 *    (`command` is an argv array — never a shell string.)
 *  - `parseScriptHookConfig` validates that shape (fail-closed: bad
 *    entries are reported and skipped, never half-registered).
 *  - `registerScriptHooks(bus, entries)` installs one handler per
 *    (entry, event) on the host HookBus and returns unsubscribers.
 *  - `installBotScriptHooks(bus, botLike)` is the bot-setup call site:
 *    read `hooks` off a bot config object and register them.
 *  - `runScriptHookOnce(entry, payload)` fires ONE configured script
 *    hook directly — the webhook path (#101): a webhook route maps an
 *    external HTTP event onto a configured script entry and runs it
 *    with the webhook payload as the hook payload. Its failure-stdout
 *    injection text is returned to the caller (and surfaced in the
 *    webhook response) instead of being swallowed.
 */

import { createScriptHookHandler, type HookBus, type HookEventName } from '@mvp/agent-runtime';

export const SCRIPT_HOOK_EVENTS: readonly HookEventName[] = [
  'session.created',
  'tool.before',
  'tool.after',
  'turn.ending',
  'input.transform',
];

export interface ScriptHookEntry {
  kind: 'script';
  /** argv array, no shell. First element is the executable. */
  command: string[];
  /** Events to register on; defaults to ['tool.after']. */
  events: HookEventName[];
  timeoutMs?: number;
  /** Optional human label (webhook routes address entries by name). */
  name?: string;
}

export interface ScriptHookConfigReport {
  entries: ScriptHookEntry[];
  errors: string[];
}

/** Validate untrusted config into script-hook entries. Never throws. */
export function parseScriptHookConfig(raw: unknown): ScriptHookConfigReport {
  const entries: ScriptHookEntry[] = [];
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { entries, errors };
  if (!Array.isArray(raw)) {
    return { entries, errors: ['hooks must be an array'] };
  }
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`hooks[${i}] is not an object`);
      return;
    }
    const o = item as Record<string, unknown>;
    if (o.kind !== 'script') return; // other kinds are other systems' business
    const command = o.command;
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      !command.every((c) => typeof c === 'string' && c.length > 0)
    ) {
      errors.push(`hooks[${i}]: script hook needs a non-empty string argv "command"`);
      return;
    }
    let events: HookEventName[] = ['tool.after'];
    if (o.events !== undefined) {
      if (!Array.isArray(o.events) || !o.events.every((e) => SCRIPT_HOOK_EVENTS.includes(e as HookEventName))) {
        errors.push(`hooks[${i}]: events must be a subset of ${SCRIPT_HOOK_EVENTS.join(', ')}`);
        return;
      }
      events = [...new Set(o.events as HookEventName[])];
      if (events.length === 0) events = ['tool.after'];
    }
    entries.push({
      kind: 'script',
      command: [...(command as string[])],
      events,
      ...(typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? { timeoutMs: o.timeoutMs } : {}),
      ...(typeof o.name === 'string' && o.name ? { name: o.name } : {}),
    });
  });
  return { entries, errors };
}

/** Read the `hooks` field off a bot/workspace config object. */
export function scriptHooksFromConfig(config: { hooks?: unknown } | null | undefined): ScriptHookConfigReport {
  return parseScriptHookConfig(config?.hooks);
}

/**
 * Register every entry on the bus. Returns unsubscribe functions (one
 * per entry×event). A script hook that fails injects its stdout as a
 * correction — that behaviour lives in createScriptHookHandler.
 */
export function registerScriptHooks(
  bus: HookBus,
  entries: ScriptHookEntry[],
  opts: { createHandler?: typeof createScriptHookHandler } = {},
): Array<() => void> {
  const create = opts.createHandler ?? createScriptHookHandler;
  const unsubs: Array<() => void> = [];
  for (const entry of entries) {
    const handler = create(entry.command, entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {});
    for (const event of entry.events) unsubs.push(bus.on(event, handler));
  }
  return unsubs;
}

/**
 * Bot-setup call site: parse + register a bot config's script hooks.
 * Returns the unsubscribers plus any config errors (for the setup log).
 */
export function installBotScriptHooks(
  bus: HookBus,
  botLike: { id?: string; hooks?: unknown },
  opts: { createHandler?: typeof createScriptHookHandler } = {},
): { unsubs: Array<() => void>; errors: string[]; registered: number } {
  const { entries, errors } = scriptHooksFromConfig(botLike);
  const unsubs = registerScriptHooks(bus, entries, opts);
  return { unsubs, errors, registered: entries.reduce((n, e) => n + e.events.length, 0) };
}

/**
 * Fire one script-hook entry directly with a payload (webhook path,
 * #101). Uses a throwaway HookBus so the exact production handler —
 * including stdout-on-failure injection — is what runs. Returns the
 * injection texts the script produced (empty when it passed quietly).
 */
export async function runScriptHookOnce(
  entry: ScriptHookEntry,
  payload: unknown,
  opts: { createHandler?: typeof createScriptHookHandler } = {},
): Promise<{ injections: string[]; errors: string[] }> {
  const { HookBus } = await import('@mvp/agent-runtime');
  const bus = new HookBus();
  const create = opts.createHandler ?? createScriptHookHandler;
  bus.on('tool.after', create(entry.command, entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}));
  const result = await bus.emit('tool.after', payload);
  return { injections: result.injections, errors: result.errors.map((e) => e.message) };
}

/** Find a named script-hook entry (webhook routes address hooks by name). */
export function findScriptHook(entries: ScriptHookEntry[], name: string): ScriptHookEntry | undefined {
  return entries.find((e) => e.name === name);
}
