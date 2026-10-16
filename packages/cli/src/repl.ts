// SPDX-License-Identifier: Apache-2.0
// Interactive REPL for `kriyadot chat <bot>` (no message, TTY stdin):
// streaming output, slash commands, and inline tool-approval prompts.
// The line source is injectable so the session loop is unit-testable
// without a real terminal.
import { randomUUID } from 'node:crypto';
import type { Interface as ReadlineInterface } from 'node:readline/promises';
import { createInterface } from 'node:readline/promises';
import type { ChatEvent, KriyaDotApi, TokenUsage } from './api.js';
import { REPL_HELP } from './help.js';

export interface ParsedSlashCommand {
  name: string;
  args: string;
}

/** Parse a REPL input line; null when it is a plain chat message. */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const line = input.trim();
  if (!line.startsWith('/')) return null;
  const body = line.slice(1).trim();
  if (!body) return { name: '', args: '' };
  const space = body.search(/\s/);
  if (space === -1) return { name: body.toLowerCase(), args: '' };
  return { name: body.slice(0, space).toLowerCase(), args: body.slice(space).trim() };
}

export interface ReplLineSource {
  /** Ask for one line; null on EOF (Ctrl+D). */
  question(prompt: string): Promise<string | null>;
  /** Register a Ctrl+C handler; the handler runs while a turn streams. */
  onInterrupt(cb: () => void): void;
  close(): void;
}

export function createReadlineSource(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): ReplLineSource {
  const rl = createInterface({ input, output, terminal: true }) as ReadlineInterface;
  const handlers = new Set<() => void>();
  rl.on('SIGINT', () => {
    for (const h of handlers) h();
  });
  return {
    question: async (prompt: string) => {
      try {
        return await rl.question(prompt);
      } catch {
        return null;
      }
    },
    onInterrupt: (cb: () => void) => {
      handlers.add(cb);
    },
    close: () => rl.close(),
  };
}

export interface TurnIO {
  api: KriyaDotApi;
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface TurnOpts {
  botId: string;
  message: string;
  sessionId: string;
  model?: string;
  autoApprove: boolean;
}

export interface TurnResult {
  content: string;
  usage?: TokenUsage;
  failed: boolean;
  error?: string;
}

/**
 * Run one chat turn against the API, streaming tokens through `onToken`.
 * `askApproval` is called for each approval_required event (the server holds
 * the turn while we ask). `onController` receives the AbortController so the
 * caller can cancel the in-flight turn (Ctrl+C).
 */
export async function runStreamingTurn(
  io: TurnIO,
  opts: TurnOpts,
  askApproval: (toolName: string) => Promise<boolean>,
  onToken: (t: string) => void,
  onController?: (c: AbortController) => void,
): Promise<TurnResult> {
  let content = '';
  let usage: TokenUsage | undefined;
  let failed = false;
  let error: string | undefined;
  let streamDone = false;

  const controller = await io.api.sendChat(
    {
      botId: opts.botId,
      message: opts.message,
      sessionId: opts.sessionId,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.autoApprove ? { autoApprove: true } : {}),
    },
    {
      onEvent: (ev: ChatEvent) => {
        switch (ev.type) {
          case 'token':
            content += ev.content;
            onToken(ev.content);
            break;
          case 'tool_call':
            io.err(`\n[tool] ${ev.name}${ev.approvalRequired ? ' (needs approval)' : ''}\n`);
            break;
          case 'tool_result':
            io.err(`[tool] ${ev.name} ${ev.denied ? 'denied' : 'done'}\n`);
            break;
          case 'approval_required': {
            void (async () => {
              const ok = await askApproval(ev.name);
              try {
                await io.api.decideApproval(ev.approvalId, ok ? 'approved' : 'denied');
              } catch (e) {
                io.err(`[approval] failed to record decision: ${e instanceof Error ? e.message : String(e)}\n`);
              }
            })();
            break;
          }
          case 'notice':
            io.err(`[notice] ${ev.message}\n`);
            break;
          case 'done':
            usage = ev.usage;
            streamDone = true;
            break;
          case 'interrupted':
            failed = true;
            error = ev.reason || 'interrupted';
            streamDone = true;
            break;
          case 'error':
            failed = true;
            error = ev.message;
            streamDone = true;
            break;
          default:
            break;
        }
      },
    },
  );
  onController?.(controller);
  // sendChat resolves the controller immediately; the terminal event
  // (done/error/interrupted) signals stream completion.
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (streamDone) {
        clearInterval(t);
        resolve();
      }
    }, 25);
  });
  return { content, usage, failed, error };
}

function formatUsage(usage?: TokenUsage): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (typeof usage.inputTokens === 'number') parts.push(`${usage.inputTokens} in`);
  if (typeof usage.outputTokens === 'number') parts.push(`${usage.outputTokens} out`);
  return parts.length ? `(${parts.join(' / ')} tokens)` : '';
}

export interface ReplDeps extends TurnIO {
  botName: string;
  lines: ReplLineSource;
  clearScreen: () => void;
}

export interface ReplOpts {
  botId: string;
  model?: string;
  sessionId?: string;
}

/** Run the interactive session. Returns the process exit code. */
export async function runRepl(deps: ReplDeps, opts: ReplOpts): Promise<number> {
  const sessionId = opts.sessionId ?? randomUUID();
  let model = opts.model;
  let autoApprove = false;
  let currentController: AbortController | null = null;
  deps.lines.onInterrupt(() => {
    if (currentController) {
      currentController.abort();
      currentController = null;
      deps.err('\n[interrupted]\n');
    }
  });

  deps.err(`Chatting with ${deps.botName} (${opts.botId}) — session ${sessionId}\n`);
  deps.err('Type /help for commands, /quit to exit.\n');

  for (;;) {
    const line = await deps.lines.question(`${deps.botName}> `);
    if (line === null) break; // EOF
    const trimmed = line.trim();
    if (!trimmed) continue;

    const cmd = parseSlashCommand(trimmed);
    if (cmd) {
      switch (cmd.name) {
        case 'help':
          deps.err(`${REPL_HELP}\n`);
          break;
        case 'quit':
        case 'exit':
          deps.lines.close();
          return 0;
        case 'clear':
          deps.clearScreen();
          break;
        case 'session':
          deps.err(`session ${sessionId}\n`);
          break;
        case 'model': {
          if (!cmd.args) {
            try {
              const models = await deps.api.listModels();
              const seen = new Set<string>();
              for (const m of models.slice(0, 30)) {
                const key = `${m.providerId}/${m.id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                deps.err(`  ${key}${m.free ? ' (free)' : ''}\n`);
              }
              if (models.length > 30) deps.err(`  …and ${models.length - 30} more\n`);
            } catch (e) {
              deps.err(`[error] ${e instanceof Error ? e.message : String(e)}\n`);
            }
          } else {
            model = cmd.args;
            deps.err(`model → ${model} (applies to new turns in this session)\n`);
          }
          break;
        }
        case 'approve':
          if (cmd.args.toLowerCase() === 'always') {
            autoApprove = true;
            deps.err('auto-approve ON for this session\n');
          } else {
            deps.err('usage: /approve always\n');
          }
          break;
        default:
          deps.err(`unknown command /${cmd.name} — /help lists commands\n`);
          break;
      }
      continue;
    }

    // Plain message → one turn with streaming + interactive approvals.
    const askApproval = async (toolName: string): Promise<boolean> => {
      if (autoApprove) return true;
      const ans = await deps.lines.question(`[approval] allow "${toolName}"? [y/N/always] `);
      const v = (ans ?? '').trim().toLowerCase();
      if (v === 'always') {
        autoApprove = true;
        return true;
      }
      return v === 'y' || v === 'yes';
    };

    const result = await runStreamingTurn(
      deps,
      { botId: opts.botId, message: trimmed, sessionId, ...(model ? { model } : {}), autoApprove },
      askApproval,
      (t) => deps.out(t),
      (c) => {
        currentController = c;
      },
    );
    currentController = null;
    deps.out('\n');
    if (result.failed) {
      deps.err(`[error] ${result.error ?? 'turn failed'} ${formatUsage(result.usage)}\n`);
    } else {
      const u = formatUsage(result.usage);
      if (u) deps.err(`  ${u}\n`);
    }
  }
  deps.lines.close();
  return 0;
}
