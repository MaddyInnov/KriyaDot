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

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
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

export function ChatView({ api, bot, palette, sessionId, messages, setMessages, onCommand, onTheme }: Props): React.ReactElement {
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [assistantBuffer, setAssistantBuffer] = useState('');
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
        case 'tool_call':
          flushAssistantBuffer();
          append('tool', `⚙ ${ev.call.name}${ev.approvalRequired ? ' (approval requested)' : ''} …`);
          break;
        case 'tool_result':
          append('tool', ev.denied ? `✕ ${ev.call.name} denied` : `✓ ${ev.call.name} done`, ev.denied);
          break;
        case 'approval_required': {
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
            },
            onError: (err) => {
              append('system', `⚠ Connection error: ${err.message}`);
              setStreaming(false);
              streamingRef.current = false;
              assistantMsgId.current = null;
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
    [api, append, bot.id, handleEvent, sessionId],
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
      }
    },
    [append, onCommand, onTheme],
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

  // Keyboard: y/n decide approvals; Ctrl+T cancels the running turn.
  useInput((inputKey, key) => {
    if (pendingApproval) {
      const k = inputKey.toLowerCase();
      if (k === 'y') decideApproval('approved');
      else if (k === 'n') decideApproval('denied');
      return;
    }
    if (key.ctrl && inputKey === 't' && turnRef.current) {
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
              <Text>
                <Text color={palette.green} bold>{bot.name} › </Text>
                <Text color={palette.text}>{m.text}</Text>
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
      </Box>

      {pendingApproval && (
        <Box borderStyle="round" borderColor={palette.amber} paddingX={1} marginX={1} marginBottom={1} flexDirection="column">
          <Text color={palette.amber} bold>⚠ Approval needed: {pendingApproval.toolName}</Text>
          {pendingApproval.argSummary ? <Text color={palette.dim}>{pendingApproval.argSummary}</Text> : null}
          <Text color={palette.text}>
            Press <Text color={palette.green} bold>y</Text> to approve · <Text color={palette.red} bold>n</Text> to deny
          </Text>
        </Box>
      )}

      <Box borderStyle="single" borderColor={palette.border} paddingX={1}>
        <Text color={palette.dim}>{streaming ? '…' : '› '}</Text>
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
          {streaming ? 'streaming — Ctrl+T cancels turn' : pendingApproval ? '' : '/bots switch · /quit exit'}
        </Text>
      </Box>
    </Box>
  );
}
