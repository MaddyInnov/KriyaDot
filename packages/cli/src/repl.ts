// SPDX-License-Identifier: Apache-2.0
// Interactive REPL for `kriyadot chat <bot>` (no message, TTY stdin):
// streaming output, slash commands, and inline tool-approval prompts.
// The line source is injectable so the session loop is unit-testable
// without a real terminal.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Interface as ReadlineInterface } from 'node:readline/promises';
import { createInterface } from 'node:readline/promises';
import type { ChatEvent, KriyaDotApi, TokenUsage } from './api.js';
import { REPL_HELP } from './help.js';
import { looksLikeMarkdown, renderMarkdown } from './markdown.js';
import { createTerminalElicitationHandler } from './elicitation.js';
import type { ElicitationRequestLike, ElicitationResultLike } from './elicitation.js';
import type { StructuredOutputSpec } from './json-schema.js';

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
  providerId?: string;
  autoApprove: boolean;
  /** Observe every raw chat event (e.g. for --format jsonl streaming). */
  onEvent?: (ev: ChatEvent) => void;
  /** Structured-output spec (#108) forwarded as the chat request's responseFormat. */
  responseFormat?: StructuredOutputSpec;
  /** Dotted `-c` overrides (#110) forwarded per-run. */
  configOverrides?: Record<string, unknown>;
  /**
   * MCP elicitation handler (#51): answers 'elicitation' events delivered
   * on the turn stream. Without one, elicitations are declined with a
   * clear log line (headless default).
   */
  elicitationHandler?: (req: ElicitationRequestLike) => Promise<ElicitationResultLike>;
}

export interface TurnResult {
  content: string;
  usage?: TokenUsage;
  failed: boolean;
  error?: string;
  /**
   * True when the turn stopped on a resumable condition (spend cap /
   * usage limit) rather than a hard failure — exit code 75 (exits.ts).
   */
  resumable?: boolean;
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
  let resumable = false;
  let streamDone = false;

  const controller = await io.api.sendChat(
    {
      botId: opts.botId,
      message: opts.message,
      sessionId: opts.sessionId,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.providerId ? { providerId: opts.providerId } : {}),
      ...(opts.autoApprove ? { autoApprove: true } : {}),
      ...(opts.responseFormat ? { responseFormat: opts.responseFormat } : {}),
      ...(opts.configOverrides ? { configOverrides: opts.configOverrides } : {}),
    },
    {
      onEvent: (ev: ChatEvent) => {
        opts.onEvent?.(ev);
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
          case 'elicitation': {
            // #51: route to the terminal handler when one is wired; the
            // answer is logged (the API's WS/widget surfaces own their
            // own answer channels). No handler → decline, clearly logged.
            if (opts.elicitationHandler) {
              const handler = opts.elicitationHandler;
              void (async () => {
                const res = await handler({ message: ev.message, requestedSchema: ev.requestedSchema });
                io.err(`[elicitation] terminal answer: ${res.action}${res.content ? ` ${JSON.stringify(res.content)}` : ''}\n`);
              })();
            } else {
              io.err(`[elicitation] declined (no terminal elicitation handler in this surface): "${ev.message}"\n`);
            }
            break;
          }
          case 'done':
            usage = ev.usage;
            streamDone = true;
            break;
          case 'spend_cap_reached':
            // Resumable stop: the session survives; the API follows this
            // with a terminal 'error' event, but treat this as terminal
            // too so a stream that ends here cannot hang the caller.
            resumable = true;
            failed = true;
            error = ev.message || 'spend cap reached';
            streamDone = true;
            io.err(`[spend cap] ${error}\n`);
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
  return { content, usage, failed, error, ...(resumable ? { resumable: true } : {}) };
}

// ---------------------------------------------------------------------------
// /reply quoting (#35) — mirrors apps/api/src/session-craft.ts exactly:
// the same ref rules (#<id> = message id, <n> = 1-based position) and the
// same wire format, so a reply composed in the REPL reads identically to
// one the API expands server-side.
// ---------------------------------------------------------------------------

export interface ReplHistoryMessage {
  id: number;
  role: string;
  content: string;
}

export interface ReplyCommand {
  ref: string;
  text: string;
}

/** Parse `/reply <ref> <text>`; null when the input is not a /reply. */
export function parseReplyCommand(input: string): ReplyCommand | null {
  const m = /^\/reply(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/.exec(input.trim());
  if (!m) return null;
  return { ref: m[1] ?? '', text: (m[2] ?? '').trim() };
}

/** Resolve a /reply ref against history: `#<id>` = message id, `<n>` = 1-based position. */
export function resolveQuotedMessage(
  messages: ReplHistoryMessage[],
  ref: string,
): ReplHistoryMessage | undefined {
  if (ref.startsWith('#')) {
    const id = Number(ref.slice(1));
    return Number.isInteger(id) ? messages.find((msg) => msg.id === id) : undefined;
  }
  const pos = Number(ref);
  if (Number.isInteger(pos) && pos >= 1 && pos <= messages.length) return messages[pos - 1];
  return messages.find((msg) => msg.id === pos);
}

const QUOTE_EXCERPT_CHARS = 600;

/** Wrap user text with the quoted message (API format); null when the ref doesn't resolve. */
export function buildQuotedReply(messages: ReplHistoryMessage[], command: ReplyCommand): string | null {
  const quoted = resolveQuotedMessage(messages, command.ref);
  if (!quoted) return null;
  const excerpt =
    quoted.content.length > QUOTE_EXCERPT_CHARS
      ? `${quoted.content.slice(0, QUOTE_EXCERPT_CHARS)}…`
      : quoted.content;
  const quoteBlock = excerpt
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `[Replying to message #${quoted.id} (${quoted.role})]\n${quoteBlock}\n\n${command.text}`;
}

// ---------------------------------------------------------------------------
// In-session commands (#114, CLI side): forwarded to the API's session
// command dispatch (POST /sessions/:id/commands, session-commands-routes)
// and printed. /role and /skill are forwarded too — the API owns the set;
// an unwired/unknown command comes back as an honest error, printed as-is.
// ---------------------------------------------------------------------------

export const SESSION_COMMANDS = new Set([
  'share',
  'analyze',
  'copy',
  'done',
  'info',
  'report',
  'usage',
  'status',
  'learning',
  'schedule',
  'compact',
  'role',
  'skill',
  'context',
  'new',
]);

export interface SessionCommandResultLike {
  handled?: boolean;
  reply: string;
  data?: unknown;
}

/** Copy text via pbcopy / xclip / xsel when one is present. Guarded: false on any failure. */
export function tryCopyToClipboard(text: string): boolean {
  const candidates: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : [
          ['xclip', ['-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--input']],
        ];
  for (const [bin, args] of candidates) {
    try {
      const r = spawnSync(bin, args, { input: text });
      if (r.status === 0) return true;
    } catch {
      // not installed — try the next candidate
    }
  }
  return false;
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
  /** Forward an in-session slash command (#114). Default: POST via deps.api.request. Injectable for tests. */
  sessionCommand?: (sessionId: string, botId: string, text: string) => Promise<SessionCommandResultLike>;
  /** Clipboard sink for /copy (#114). Default: tryCopyToClipboard. Injectable for tests. */
  copyToClipboard?: (text: string) => boolean;
}

export interface ReplOpts {
  botId: string;
  model?: string;
  sessionId?: string;
}

/** Run the interactive session. Returns the process exit code. */
export async function runRepl(deps: ReplDeps, opts: ReplOpts): Promise<number> {
  let sessionId = opts.sessionId ?? randomUUID();
  let model = opts.model;
  let autoApprove = false;
  // Local transcript for /reply quoting (#35): ids are sequential from 1,
  // matching the position semantics of the API's session-craft refs.
  const history: ReplHistoryMessage[] = [];
  const forwardSessionCommand =
    deps.sessionCommand ??
    (async (sid: string, botId: string, text: string): Promise<SessionCommandResultLike> => {
      const api = deps.api as unknown as {
        request?: <T>(path: string, init?: RequestInit) => Promise<T>;
      };
      if (typeof api.request !== 'function') throw new Error('session commands need an API client with request()');
      return api.request<SessionCommandResultLike>(`/sessions/${encodeURIComponent(sid)}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: text, botId }),
      });
    });
  const elicitationHandler = createTerminalElicitationHandler({
    ask: (q) => deps.lines.question(q),
    // The REPL only runs on a TTY line source in production; tests inject
    // a scripted source, which counts as interactive.
    isInteractive: () => true,
    log: (m) => deps.err(`${m}\n`),
  });
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

  // One chat turn: records history (for /reply), wires interactive
  // approvals + the terminal elicitation handler, and renders the
  // completed assistant message as markdown (#31) — rendering at turn
  // end, because half-arrived markdown (open fences/spans) renders worse
  // than the raw stream.
  const runTurn = async (messageText: string): Promise<void> => {
    history.push({ id: history.length + 1, role: 'user', content: messageText });
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
      {
        botId: opts.botId,
        message: messageText,
        sessionId,
        ...(model ? { model } : {}),
        autoApprove,
        elicitationHandler,
      },
      askApproval,
      () => undefined, // tokens are buffered; the rendered message prints at turn end
      (c) => {
        currentController = c;
      },
    );
    currentController = null;
    if (result.content) {
      history.push({ id: history.length + 1, role: 'assistant', content: result.content });
      deps.out(`${looksLikeMarkdown(result.content) ? renderMarkdown(result.content) : result.content}\n`);
    } else {
      deps.out('\n');
    }
    if (result.failed) {
      deps.err(`[error] ${result.error ?? 'turn failed'} ${formatUsage(result.usage)}\n`);
    } else {
      const u = formatUsage(result.usage);
      if (u) deps.err(`  ${u}\n`);
    }
  };

  for (;;) {
    const line = await deps.lines.question(`${deps.botName}> `);
    if (line === null) break; // EOF
    const trimmed = line.trim();
    if (!trimmed) continue;

    const cmd = parseSlashCommand(trimmed);
    if (cmd) {
      // /reply (#35): compose the quoted message locally (same format the
      // API builds server-side) and send it as a normal turn.
      if (cmd.name === 'reply') {
        const replyCmd = parseReplyCommand(trimmed);
        if (!replyCmd || !replyCmd.ref || !replyCmd.text) {
          deps.err('usage: /reply <#id|position> <text> — quote an earlier message in this session\n');
          continue;
        }
        const quoted = buildQuotedReply(history, replyCmd);
        if (!quoted) {
          deps.err(`[error] /reply: no message matches "${replyCmd.ref}" in this session yet\n`);
          continue;
        }
        await runTurn(quoted);
        continue;
      }
      // In-session commands (#114): forward to the API dispatch, print.
      if (SESSION_COMMANDS.has(cmd.name)) {
        try {
          const res = await forwardSessionCommand(sessionId, opts.botId, trimmed);
          if (res.reply) deps.out(`${res.reply}\n`);
          if (res.data !== undefined && cmd.name !== 'copy') {
            deps.err(`${JSON.stringify(res.data, null, 2)}\n`);
          }
          if (cmd.name === 'copy') {
            const text =
              res.data && typeof res.data === 'object' && typeof (res.data as { text?: unknown }).text === 'string'
                ? (res.data as { text: string }).text
                : res.reply;
            const copied = (deps.copyToClipboard ?? tryCopyToClipboard)(text);
            deps.err(copied ? '[copy] copied to clipboard\n' : '[copy] printed above (no clipboard tool found)\n');
          }
          if (cmd.name === 'new' && res.data && typeof res.data === 'object') {
            const nid = (res.data as { sessionId?: unknown }).sessionId;
            if (typeof nid === 'string' && nid) {
              sessionId = nid;
              deps.err(`[session] now on ${sessionId}\n`);
            }
          }
        } catch (e) {
          deps.err(`[error] /${cmd.name}: ${e instanceof Error ? e.message : String(e)}\n`);
        }
        continue;
      }
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

    // Plain message → one turn (see runTurn above).
    await runTurn(trimmed);
  }
  deps.lines.close();
  return 0;
}
