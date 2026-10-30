// SPDX-License-Identifier: Apache-2.0
// Chat view: streaming messages, inline approval prompts, slash commands.
// The transcript is owned by App (so switching views doesn't lose it).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { BotSummary, ChatEvent, KriyaDotApi } from '../api.js';
import { isKnownCommand, parseSlashCommand } from '../commands.js';
import type { TuiPalette, ThemeName } from '../themes.js';
import { isThemeName, THEME_NAMES } from '../themes.js';
import { MarkdownText } from './MarkdownText.js';
import { Spinner } from './Spinner.js';
import type { JobManager } from '../jobs.js';
import { emitTerminalSignal, resolveNotifyMode, type NotifyMode } from '../terminal-signals.js';
import { actionForEvent, DEFAULT_KEYBINDINGS, type KeyBindings } from '../keybindings.js';

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking';
  text: string;
  denied?: boolean;
}

export interface PendingApproval {
  approvalId: string;
  toolName: string;
  argSummary: string;
}

export interface ChatCommand {
  kind:
    | 'bots'
    | 'workflows'
    | 'activity'
    | 'memory'
    | 'clear'
    | 'quit'
    | 'help'
    | 'model-list'
    | 'model-set'
    | 'theme'
    | 'jobs'
    | 'unknown';
  args?: string;
  raw?: string;
}

interface Props {
  api: KriyaDotApi;
  bot: BotSummary;
  palette: TuiPalette;
  sessionId: string;
  messages: ChatMessage[];
  setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  onCommand: (cmd: ChatCommand) => void;
  onTheme: (name: ThemeName) => void;
  /** Shared background-job registry (#187): each chat turn registers here so the Jobs panel can list/cancel it. */
  jobs?: JobManager;
  /** CA-28: terminal completion-signal mode. */
  notifyMode?: NotifyMode;
  /** CA-19: keybinding overrides (defaults when omitted). */
  keybindings?: KeyBindings;
}

let nextId = 1;
export const nextMessageId = (): number => nextId++;

function summarizeArgs(args: unknown): string {
  if (args == null) return '';
  try {
    const s = JSON.stringify(args);
    return s.length > 220 ? `${s.slice(0, 220)}…` : s;
  } catch {
    return String(args).slice(0, 220);
  }
}

export function ChatView({ api, bot, palette, sessionId, messages, setMessages, onCommand, onTheme, jobs, notifyMode, keybindings }: Props): React.ReactElement {
  const notify = resolveNotifyMode(notifyMode);
  const bindings = keybindings ?? DEFAULT_KEYBINDINGS;
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [assistantBuffer, setAssistantBuffer] = useState('');
  const [runningTools, setRunningTools] = useState(0);
  const jobIdRef = useRef<string | null>(null);
  const turnRef = useRef<AbortController | null>(null);
  const assistantMsgId = useRef<number | null>(null);
  const streamingRef = useRef(false);

  const append = useCallback(
    (role: ChatMessage['role'], text: string, denied = false) => {
      setMessages((m) => [...m, { id: nextMessageId(), role, text, denied }]);
    },
    [setMessages],
  );

  const flushAssistantBuffer = useCallback(() => {
    setAssistantBuffer((buf) => {
      if (buf && assistantMsgId.current != null) {
        const id = assistantMsgId.current;
        setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, text: msg.text + buf } : msg)));
      }
      return '';
    });
  }, [setMessages]);

  const startAssistantMessage = useCallback(() => {
    const id = nextMessageId();
    assistantMsgId.current = id;
    setMessages((m) => [...m, { id, role: 'assistant', text: '' }]);
  }, [setMessages]);

  const handleEvent = useCallback(
    (ev: ChatEvent) => {
      switch (ev.type) {
        case 'token':
          if (assistantMsgId.current == null) startAssistantMessage();
          setAssistantBuffer((b) => b + ev.content);
          break;
        case 'thinking':
          // Reasoning stream (#186): accumulated into one collapsed
          // 'thinking' message per burst, rendered italic + truncated.
          if (ev.content) {
            setMessages((m) => {
              const last = m[m.length - 1];
              if (last && last.role === 'thinking') {
                return [...m.slice(0, -1), { ...last, text: last.text + ev.content }];
              }
              return [...m, { id: nextMessageId(), role: 'thinking' as const, text: ev.content }];
            });
          }
          break;
        case 'tool_call':
          flushAssistantBuffer();
          setRunningTools((n) => n + 1);
          append('tool', `⚙ ${ev.call.name}${ev.approvalRequired ? ' (approval requested)' : ''} …`);
          break;
        case 'tool_result':
          setRunningTools((n) => Math.max(0, n - 1));
          append('tool', ev.denied ? `✕ ${ev.call.name} denied` : `✓ ${ev.call.name} done`, ev.denied);
          break;
        case 'approval_required': {
          emitTerminalSignal(notify, 'approval-needed');
          flushAssistantBuffer();
          setPendingApproval({
            approvalId: ev.approvalId,
            toolName: ev.call.name,
            argSummary: summarizeArgs(ev.call.arguments),
          });
          break;
        }
        case 'notice':
          append('system', `ℹ ${ev.message}`);
          break;
        case 'queued_turn_start':
          append('system', '⏳ Queued — will run when the current turn finishes.');
          break;
        case 'done': {
          emitTerminalSignal(notify, 'turn-complete');
          flushAssistantBuffer();
          const u = ev.usage;
          if (u && (u.inputTokens || u.outputTokens)) {
            append('system', `done · ${(u.inputTokens ?? 0).toLocaleString()} in / ${(u.outputTokens ?? 0).toLocaleString()} out tokens`);
          }
          break;
        }
        case 'error':
          flushAssistantBuffer();
          append('system', `⚠ Error: ${ev.message}`);
          break;
        case 'interrupted':
          flushAssistantBuffer();
          append('system', `⏹ Interrupted: ${ev.reason}`);
          break;
        case 'unknown':
          break;
      }
    },
    [append, flushAssistantBuffer, startAssistantMessage],
  );

  const sendMessage = useCallback(
    (text: string) => {
      if (streamingRef.current) {
        append('system', 'A turn is already running — wait for it to finish (Ctrl+T cancels).');
        return;
      }
      append('user', text);
      setStreaming(true);
      streamingRef.current = true;
      assistantMsgId.current = null;
      setAssistantBuffer('');
      // Register the turn as a background job (#187): the Jobs panel can
      // cancel it, which aborts this turn's controller.
      if (jobs) {
        jobIdRef.current = jobs.start(`Chat: ${text.slice(0, 48)}`, () => turnRef.current?.abort());
      }
      void api
        .sendChat(
          { botId: bot.id, message: text, sessionId },
          {
            onEvent: handleEvent,
            onDone: () => {
              setStreaming(false);
              streamingRef.current = false;
              setPendingApproval(null);
              assistantMsgId.current = null;
              if (jobs && jobIdRef.current) jobs.finish(jobIdRef.current, 'done');
              jobIdRef.current = null;
            },
            onError: (err) => {
              append('system', `⚠ Connection error: ${err.message}`);
              setStreaming(false);
              streamingRef.current = false;
              assistantMsgId.current = null;
              if (jobs && jobIdRef.current) jobs.finish(jobIdRef.current, 'failed', err.message);
              jobIdRef.current = null;
            },
          },
        )
        .then((controller) => {
          turnRef.current = controller;
        })
        .catch((err: Error) => {
          append('system', `⚠ Failed to start turn: ${err.message}`);
          setStreaming(false);
          streamingRef.current = false;
        });
    },
    [api, append, bot.id, handleEvent, sessionId, jobs],
  );

  const decideApproval = useCallback(
    (decision: 'approved' | 'denied') => {
      const pa = pendingApproval;
      if (!pa) return;
      setPendingApproval(null);
      append('system', decision === 'approved' ? `✓ Approved ${pa.toolName}` : `✕ Denied ${pa.toolName}`);
      void api.decideApproval(pa.approvalId, decision).catch((err: Error) => {
        append('system', `⚠ Approval decision failed: ${err.message}`);
      });
    },
    [api, append, pendingApproval],
  );

  const runCommand = useCallback(
    (name: string, args: string, raw: string) => {
      if (!isKnownCommand(name)) {
        append('system', `Unknown command "${raw}". Type /help for the list.`);
        return;
      }
      switch (name) {
        case 'bots':
        case 'workflows':
        case 'activity':
        case 'memory':
        case 'clear':
        case 'quit':
        case 'help':
        case 'jobs':
        case 'model':
          if (name === 'model') {
            if (!args) onCommand({ kind: 'model-list' });
            else onCommand({ kind: 'model-set', args });
          } else {
            onCommand({ kind: name, args, raw });
          }
          break;
        case 'theme':
          if (isThemeName(args)) onTheme(args);
          else append('system', `Unknown theme "${args}". Choose one of: ${THEME_NAMES.join(', ')}`);
          break;
        case 'rewind': {
          // CA-4: list checkpoints, or restore #n [code|conversation|both].
          void (async () => {
            try {
              const checkpoints = await api.listCheckpoints(sessionId);
              if (!args) {
                if (checkpoints.length === 0) append('system', 'No checkpoints for this session yet.');
                else {
                  append(
                    'system',
                    checkpoints
                      .map((cp, i) => `${i + 1}. ${new Date(cp.createdAt).toLocaleTimeString()} · ${cp.label} · ${Object.keys(cp.files).length} file(s)`)
                      .join('\n'),
                  );
                }
                return;
              }
              const [target, modeArg] = args.split(/\s+/);
              const cp = /^\d+$/.test(target ?? '') ? checkpoints[Number(target) - 1] : checkpoints.find((c) => c.id.startsWith(target ?? ''));
              if (!cp) {
                append('system', `No checkpoint matches "${target}".`);
                return;
              }
              const mode = modeArg === 'code' || modeArg === 'conversation' ? modeArg : 'both';
              const r = await api.restoreCheckpoint(cp.id, mode);
              append('system', `↩ Restored ${cp.label} (${mode}): ${r.restoredFiles.length} file(s), ${r.messagesRemoved} message(s) removed.`);
            } catch (err) {
              append('system', `⚠ /rewind failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
          break;
        }
        case 'diff': {
          // CA-30: session-changes review from the server aggregate.
          void (async () => {
            try {
              const r = await api.sessionDiff(sessionId);
              if (r.files.length === 0) append('system', 'No file changes recorded for this session.');
              else {
                append(
                  'system',
                  [
                    `Session changes — ${r.files.length} file(s), +${r.totals.added} -${r.totals.removed}`,
                    ...r.files.map((f) => `  ${f.path}  +${f.added} -${f.removed}  (${f.status})`),
                  ].join('\n'),
                );
              }
            } catch (err) {
              append('system', `⚠ /diff failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          })();
          break;
        }
      }
    },
    [append, onCommand, onTheme, api, sessionId],
  );

  const onSubmit = useCallback(
    (value: string) => {
      const text = value.trim();
      setInput('');
      if (!text) return;
      const cmd = parseSlashCommand(text);
      if (cmd) runCommand(cmd.name, cmd.args, text);
      else sendMessage(text);
    },
    [runCommand, sendMessage],
  );

  // Keyboard (CA-19 bindings): approve/deny decide approvals; the cancel
  // chord (default Ctrl+T) cancels the running turn.
  useInput((inputKey, key) => {
    const action = actionForEvent(bindings, inputKey, key);
    if (pendingApproval) {
      if (action === 'approve') decideApproval('approved');
      else if (action === 'deny') decideApproval('denied');
      return;
    }
    if (action === 'cancel' && turnRef.current) {
      turnRef.current.abort();
      append('system', '⏹ Turn cancelled.');
    }
  });

  useEffect(
    () => () => {
      turnRef.current?.abort();
    },
    [],
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {messages.map((m) => (
          <Box key={m.id} marginBottom={m.role === 'assistant' ? 1 : 0}>
            {m.role === 'user' && (
              <Text>
                <Text color={palette.accent} bold>you › </Text>
                <Text color={palette.text}>{m.text}</Text>
              </Text>
            )}
            {m.role === 'assistant' && (
              <Box>
                <Text color={palette.green} bold>{bot.name} › </Text>
                <MarkdownText text={m.text} palette={palette} />
              </Box>
            )}
            {m.role === 'thinking' && (
              // Collapsed thinking display (#186): italic dim summary —
              // first line + size — never the full reasoning dump.
              <Text color={palette.dim} italic>
                💭 thinking · {m.text.length} chars · {m.text.split('\n')[0]!.slice(0, 100)}
                {m.text.length > 100 ? '…' : ''}
              </Text>
            )}
            {m.role === 'tool' && <Text color={m.denied ? palette.red : palette.dim}>{m.text}</Text>}
            {m.role === 'system' && <Text color={palette.dim} italic>{m.text}</Text>}
          </Box>
        ))}
        {streaming && assistantBuffer.length > 0 && (
          <Text>
            <Text color={palette.green} bold>{bot.name} › </Text>
            <Text color={palette.text}>{assistantBuffer}</Text>
            <Text color={palette.dim}> ▍</Text>
          </Text>
        )}
        {streaming && runningTools > 0 && (
          <Box marginTop={1}>
            <Spinner color={palette.amber} label={`running ${runningTools} tool${runningTools > 1 ? 's' : ''}…`} />
          </Box>
        )}
      </Box>

      {pendingApproval && (
        <Box borderStyle="round" borderColor={palette.amber} paddingX={1} marginX={1} marginBottom={1} flexDirection="column">
          <Text color={palette.amber} bold>⚠ Approval needed: {pendingApproval.toolName}</Text>
          {pendingApproval.argSummary ? <Text color={palette.dim}>{pendingApproval.argSummary}</Text> : null}
          <Text color={palette.text}>
            Press <Text color={palette.green} bold>{bindings.approve}</Text> to approve · <Text color={palette.red} bold>{bindings.deny}</Text> to deny
          </Text>
        </Box>
      )}

      <Box borderStyle="single" borderColor={palette.border} paddingX={1}>
        {streaming ? <Spinner color={palette.dim} /> : <Text color={palette.dim}>{'› '}</Text>}
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={onSubmit}
          placeholder={pendingApproval ? 'decide with y/n…' : `Message ${bot.name}… (/help)`}
          focus={!pendingApproval}
        />
      </Box>
      <Box paddingX={1}>
        <Text color={palette.dim}>
          {streaming ? `streaming — ${bindings.cancel} cancels turn` : pendingApproval ? '' : '/bots switch · /quit exit'}
        </Text>
      </Box>
    </Box>
  );
}
