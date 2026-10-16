// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  allowTool,
  branchChatThread,
  createMessageThread,
  decideApproval,
  deleteSlashCommand,
  getApiBase,
  getBots,
  getChatThreadMessages,
  getMessageReactions,
  getMessageThread,
  getMessageThreads,
  getModels,
  getProviders,
  getSlashCommands,
  markMessageThreadRead,
  replyInMessageThread,
  saveSlashCommand,
  streamChat,
  startFusionRun,
  streamFusionRun,
  uploadFile,
  deleteUploadedFile,
  fileTypeIcon,
  type FusionStreamEvent,
  type MessageReaction,
} from '../lib/api';
import {
  FusionProgressView,
  applyFusionEvent,
  emptyFusionState,
  type FusionLiveState,
} from '../components/fusion/fusion-progress';
import type {
  BotConfig,
  MessageThreadSummary,
  ModelPriceInfo,
  ProviderInfo,
  SlashCommand,
  StreamEvent,
  TokenUsage,
  ToolCall,
  UploadedFile,
} from '../lib/api';
import { COST_ESTIMATE_TOOLTIP, contextMeter, costOfUsage, formatTokens, formatUsd } from '../lib/usage';
import { WidgetRenderer, validateWidget } from '../components/widgets';
import type { Widget, WidgetAction } from '../components/widgets';
import { CodeBlock, LineDiffView, UnifiedDiffView } from '../components/code/CodeBlock';
import LazyClayScene from '../components/three';
import { Pet } from '../components/pet/Pet';
import { usePet, type PetMood } from '../lib/pet';
import { I18nProvider, LanguageSwitcher, useI18n } from '../lib/i18n';
import { getWebSTTProvider } from '../lib/voice-http';
import { VOICE_NOTE_PERSIST_LIMIT, type VoiceNote } from '../lib/voice-notes';
import { CallPanel, VoiceNoteBubble, VoiceNoteRecorder } from '../components/voice';
import { NoteAttachButton } from '../components/chat/note-attach-button';
import { BotConversationSheet, BotNoticeRow, type BotNoticeData } from '../components/chat/bot-notice';
import { MessageReactions } from '../components/chat/message-reactions';
import { useCodeSession } from '../components/code/useCodeSession';
import { CodeSessionView } from '../components/code/CodeSessionView';
import { CodingSessionStrip } from '../components/code/CodingSessionStrip';

type ChatBlock =
  | { kind: 'user'; id: string; text: string; ts: number }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; usage?: TokenUsage; costUsd?: number; ts: number; botName?: string }
  | { kind: 'tool'; id: string; call: ToolCall; result?: unknown; denied?: boolean }
  | {
      kind: 'approval';
      id: string;
      approvalId: string;
      call: ToolCall;
      status: 'pending' | 'approved' | 'denied';
      remembering?: boolean;
    }
  | { kind: 'widget'; id: string; widget: Widget }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'interrupted'; id: string; text: string }
  | { kind: 'fusion'; id: string; runId: string; state: FusionLiveState; ts: number }
  | {
      kind: 'voice-note';
      id: string;
      /** data: URL of the recorded audio ('' when dropped for quota on reload). */
      audioDataUrl: string;
      mimeType: string;
      durationMs: number;
      transcript: string;
      ts: number;
    };

/** A saved conversation (one chat session) belonging to a bot. */
interface Conversation {
  id: string;
  title: string;
  createdAt: number;
}

function loadConvos(): Record<string, Conversation[]> {
  try {
    const raw = localStorage.getItem('mvp:convos:v1');
    return raw ? (JSON.parse(raw) as Record<string, Conversation[]>) : {};
  } catch {
    return {};
  }
}

function saveConvos(c: Record<string, Conversation[]>): void {
  try {
    localStorage.setItem('mvp:convos:v1', JSON.stringify(c));
  } catch {
    // ignore (quota)
  }
}

function loadActiveConvo(): Record<string, string> {
  try {
    const raw = localStorage.getItem('mvp:activeConvo:v1');
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const MAX_STORED_BLOCKS = 300;

function loadBlocks(convoId: string): ChatBlock[] {
  try {
    const raw = localStorage.getItem(`mvp:blocks:${convoId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatBlock[];
    // Never restore a block stuck in streaming state.
    return parsed.map((b) => (b.kind === 'assistant' ? { ...b, streaming: false } : b));
  } catch {
    return [];
  }
}

function saveBlocks(convoId: string, blocks: ChatBlock[]): void {
  try {
    const trimmed = blocks.slice(-MAX_STORED_BLOCKS).map((b) =>
      // Voice-note audio is local-first: keep it only when it fits the
      // quota comfortably. The transcript is always persisted.
      b.kind === 'voice-note' && b.audioDataUrl.length > VOICE_NOTE_PERSIST_LIMIT
        ? { ...b, audioDataUrl: '' }
        : b,
    );
    localStorage.setItem(`mvp:blocks:${convoId}`, JSON.stringify(trimmed));
  } catch {
    // ignore (quota)
  }
}

function convoTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 42 ? `${t.slice(0, 42)}…` : t || 'New chat';
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Rough token estimate for the composer (≈4 chars per token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

let blockSeq = 0;
const nextId = () => `b${Date.now()}_${blockSeq++}`;

interface ProviderOverride {
  provider: string;
  model: string;
}

function loadOverride(botId: string): ProviderOverride | null {
  try {
    const raw = localStorage.getItem(`mvp:provider:${botId}`);
    return raw ? (JSON.parse(raw) as ProviderOverride) : null;
  } catch {
    return null;
  }
}

function saveOverride(botId: string, o: ProviderOverride): void {
  try {
    localStorage.setItem(`mvp:provider:${botId}`, JSON.stringify(o));
  } catch {
    // ignore
  }
}

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/**
 * Renders a tool call's arguments as code: write_file shows the new file
 * with syntax highlighting, edit shows a line diff, patch shows the
 * unified diff. Other tools fall back to raw JSON.
 */
function ToolCallBody({ call }: { call: ToolCall }) {
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (call.name === 'write_file' && typeof args.path === 'string' && typeof args.content === 'string') {
    return <CodeBlock code={args.content} path={args.path} maxHeight={420} />;
  }
  if (
    (call.name === 'edit' || call.name === 'edit_file') &&
    typeof args.path === 'string' &&
    typeof args.oldText === 'string' &&
    typeof args.newText === 'string'
  ) {
    return <LineDiffView oldText={args.oldText} newText={args.newText} path={args.path} />;
  }
  if (call.name === 'patch' && typeof args.diff === 'string') {
    return <UnifiedDiffView diff={args.diff} />;
  }
  return (
    <>
      <div className="label">Arguments</div>
      <pre className="mono small">{prettyJson(call.args)}</pre>
    </>
  );
}

/** Subtle per-turn footer under an assistant message: tokens + $ cost + context meter. */
function UsageFooter({
  usage,
  contextLength,
  costUsd,
}: {
  usage: TokenUsage;
  contextLength?: number;
  costUsd?: number;
}) {
  const meter = contextMeter(usage.totalTokens, contextLength);
  return (
    <div className="small muted mono usage-line">
      ↑ {formatTokens(usage.promptTokens)} in · ↓ {formatTokens(usage.completionTokens)} out · Σ{' '}
      {formatTokens(usage.totalTokens)}
      {costUsd !== undefined && (
        <span title={COST_ESTIMATE_TOOLTIP}> · ≈{formatUsd(costUsd)}</span>
      )}
      {meter && (
        <span className={meter.warn ? 'amber' : undefined}>
          {' '}· ctx {formatTokens(meter.used)}/{formatTokens(meter.limit)} ({Math.round(meter.pct)}%)
        </span>
      )}
    </div>
  );
}

/** Find a /api/models price entry: exact providerId/modelId, then bare modelId fallback. */
function lookupPrice(
  models: ModelPriceInfo[],
  providerId: string,
  modelId: string,
): ModelPriceInfo | undefined {
  return (
    models.find((m) => m.providerId === providerId && m.id === modelId) ??
    models.find((m) => m.id === modelId)
  );
}

/** Clay toggle switch. */
function ClayToggle({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="clay-toggle"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      title={title}
    >
      <span className="track" aria-hidden="true">
        <span className="knob" aria-hidden="true" />
      </span>
      <span className="tlabel">{label}</span>
    </button>
  );
}

/** Copy-to-clipboard button for a message. */
function CopyBtn({ text, title }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      title={title ?? 'Copy message'}
      aria-label={title ?? 'Copy message'}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Clipboard API unavailable (non-secure context) — fallback.
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand('copy');
          } catch {
            // ignore
          }
          ta.remove();
        }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? '✓ Copied' : '⧉ Copy'}
    </button>
  );
}

/** "Branch from here" action: fork the thread at this message into a new conversation. */
function BranchBtn({ onBranch, disabled }: { onBranch: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="copy-btn"
      title="Branch from here — start a new conversation with history up to this message"
      aria-label="Branch from here"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onBranch();
      }}
    >
      ⑂ Branch
    </button>
  );
}

/** "Reply in thread" action: open the Slack-style reply thread on this message. */
function ThreadBtn({
  onThread,
  disabled,
  replyCount,
  unread,
}: {
  onThread: () => void;
  disabled?: boolean;
  replyCount?: number;
  unread?: boolean;
}) {
  const label = replyCount ? `💬 ${replyCount}` : '💬 Thread';
  return (
    <button
      type="button"
      className={`copy-btn${unread ? ' thread-unread' : ''}`}
      title="Reply in thread — discuss this message in a side thread"
      aria-label="Reply in thread"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onThread();
      }}
    >
      {label}
      {unread ? ' •' : ''}
    </button>
  );
}

/** Suggestion chips for the empty state. */
const SUGGESTIONS = [
  'Explain a concept simply',
  'Write a Python function',
  'Plan a task step by step',
  'Review this code for bugs',
];

function ChatPageInner() {
  const { t, locale } = useI18n();
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string>('');
  const [providerId, setProviderId] = useState<string>('');
  const [modelId, setModelId] = useState<string>('');
  type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>('workspace-write');
  type QueueMode = 'interrupt' | 'queue';
  const [queueMode, setQueueMode] = useState<QueueMode>('interrupt');
  const queueModeRef = useRef(queueMode);
  type ReasoningEffort = 'low' | 'medium' | 'high';
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');
  const reasoningEffortRef = useRef(reasoningEffort);
  queueModeRef.current = queueMode;
  reasoningEffortRef.current = reasoningEffort;
  // Queued messages waiting for the turn boundary (queue-at-boundary mode).
  const [queuedCount, setQueuedCount] = useState(0);
  const [blocks, setBlocks] = useState<ChatBlock[]>([]);
  const [convSheetPeer, setConvSheetPeer] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // Fusion mode (Atomic Agent parity): when on, the composer sends the
  // message as a fusion run (planner + parallel workers + fused synthesis).
  const [fusionMode, setFusionMode] = useState(false);
  const fusionModeRef = useRef(false);
  useEffect(() => {
    fusionModeRef.current = fusionMode;
  }, [fusionMode]);
  // Active fusion SSE subscriptions, keyed by block id (cleaned up on stop).
  const fusionStreamsRef = useRef(new Map<string, () => void>());
  const [loadError, setLoadError] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sessionUsage, setSessionUsage] = useState<Record<string, TokenUsage>>({});
  const [sessionCost, setSessionCost] = useState<Record<string, number>>({});
  const [modelPrices, setModelPrices] = useState<ModelPriceInfo[]>([]);
  // New run controls.
  const [autoApprove, setAutoApprove] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [maxBudget, setMaxBudget] = useState('');
  const [slashCommands, setSlashCommands] = useState<Record<string, SlashCommand>>({});
  const [slashHl, setSlashHl] = useState(0);
  const [slashMgrOpen, setSlashMgrOpen] = useState(false);
  const [slashDraft, setSlashDraft] = useState({ name: '', description: '', prompt: '' });
  const [slashError, setSlashError] = useState('');
  // Conversations (chat sessions) per bot, persisted locally.
  const [convos, setConvos] = useState<Record<string, Conversation[]>>({});
  const [activeConvo, setActiveConvo] = useState<Record<string, string>>({});
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // Branching a thread at a message (server round-trip in progress).
  const [branching, setBranching] = useState(false);
  // Message reactions (Codync parity): per-message emoji reactions,
  // keyed by client message id.
  const [messageReactions, setMessageReactions] = useState<Record<string, MessageReaction[]>>({});
  // Slack-style reply threads: the open thread panel, its messages, and
  // per-root summaries (reply counts + unread flags) for the active convo.
  const [openThread, setOpenThread] = useState<{
    id: string;
    sessionId: string;
    threadSessionId: string;
    rootClientId: string;
    rootText: string;
  } | null>(null);
  const [threadBlocks, setThreadBlocks] = useState<ChatBlock[]>([]);
  const [threadSummaries, setThreadSummaries] = useState<Record<string, MessageThreadSummary>>({});
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadInput, setThreadInput] = useState('');
  const [threadSending, setThreadSending] = useState(false);
  const openThreadRef = useRef(openThread);
  openThreadRef.current = openThread;
  // Sidebar (mobile drawer) + settings popover.
  const [sideOpen, setSideOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Chat vs live voice-call mode (the call panel lives inside the Chat
  // destination — the top-level nav stays exactly six destinations).
  const [chatMode, setChatMode] = useState<'chat' | 'call'>('chat');
  // Live code session (Amoeba-style): file tabs + animated diffs while the
  // agent writes code. Lives inside Chat — never a 7th destination.
  const codeSession = useCodeSession();
  const codeSessionRef = useRef(codeSession);
  codeSessionRef.current = codeSession;
  const [codeViewOpen, setCodeViewOpen] = useState(false);
  const [codeLayout, setCodeLayout] = useState<'inline' | 'side'>('inline');
  const dismissedThisTurn = useRef(false);
  /** Pending approval cards, for the inline session strip. */
  const pendingApprovals = useMemo(
    () =>
      blocks
        .filter((b): b is Extract<ChatBlock, { kind: 'approval' }> => b.kind === 'approval' && b.status === 'pending')
        .map((b) => ({ approvalId: b.approvalId, blockId: b.id, call: b.call })),
    [blocks],
  );
  const messagesRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnSeq = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const botIdRef = useRef(selectedBotId);
  botIdRef.current = selectedBotId;
  const providerIdRef = useRef(providerId);
  providerIdRef.current = providerId;
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  const sandboxModeRef = useRef(sandboxMode);
  sandboxModeRef.current = sandboxMode;
  const modelPricesRef = useRef(modelPrices);
  modelPricesRef.current = modelPrices;
  const autoApproveRef = useRef(autoApprove);
  autoApproveRef.current = autoApprove;
  const planModeRef = useRef(planMode);
  planModeRef.current = planMode;
  const maxBudgetRef = useRef(maxBudget);
  maxBudgetRef.current = maxBudget;

  const selectedBot = bots.find((b) => b.id === selectedBotId);
  const selectedProvider = providers.find((p) => p.id === providerId);
  const selectedBotRef = useRef(selectedBot);
  selectedBotRef.current = selectedBot;

  // Companion pet: reacts to run state (idle → thinking/working → happy on completion).
  const { choice: petChoice, name: petName } = usePet();
  const [celebrate, setCelebrate] = useState(false);
  const runActiveRef = useRef(false);
  const anyStreaming = sending || blocks.some((b) => b.kind === 'assistant' && b.streaming);
  const waitingForFirstToken =
    anyStreaming && !blocks.some((b) => b.kind === 'assistant' && b.streaming && b.text.length > 0);
  useEffect(() => {
    if (runActiveRef.current && !anyStreaming) {
      // A run just finished — celebrate briefly (only when it produced output).
      setCelebrate(true);
      const t = setTimeout(() => setCelebrate(false), 3200);
      runActiveRef.current = false;
      return () => clearTimeout(t);
    }
    runActiveRef.current = anyStreaming;
  }, [anyStreaming]);
  const petMood: PetMood = celebrate ? 'happy' : waitingForFirstToken ? 'thinking' : anyStreaming ? 'working' : 'idle';

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [b, p, m, sc] = await Promise.all([getBots(), getProviders(), getModels(), getSlashCommands()]);
        if (cancelled) return;
        setBots(b);
        setProviders(p);
        setModelPrices(m);
        setSlashCommands(sc.commands ?? {});
        if (b.length > 0) setSelectedBotId(b[0].id);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore run-control prefs.
  useEffect(() => {
    setAutoApprove(loadFlag('mvp:autoApprove'));
    setPlanMode(loadFlag('mvp:planMode'));
    try {
      setMaxBudget(localStorage.getItem('mvp:maxBudget') ?? '');
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('mvp:autoApprove', autoApprove ? '1' : '0');
    } catch { /* ignore */ }
  }, [autoApprove]);
  useEffect(() => {
    try {
      localStorage.setItem('mvp:planMode', planMode ? '1' : '0');
    } catch { /* ignore */ }
  }, [planMode]);
  useEffect(() => {
    try {
      localStorage.setItem('mvp:maxBudget', maxBudget);
    } catch { /* ignore */ }
  }, [maxBudget]);

  // When the bot changes, restore its provider/model override (or defaults)
  // and the active conversation's message history.
  useEffect(() => {
    if (!selectedBot) return;
    const override = loadOverride(selectedBot.id);
    const prov = override?.provider || selectedBot.provider;
    setProviderId(prov);
    setModelId(override?.model || selectedBot.model || '');
    const cid = activeConvoRef.current[selectedBot.id];
    const list = convosRef.current[selectedBot.id] ?? [];
    if (cid && list.some((c) => c.id === cid)) {
      setBlocks(loadBlocks(cid));
      void loadThreadSummaries(cid); void loadMessageReactions(cid);
    } else if (list.length > 0 && list[0]) {
      // Fall back to the most recent conversation.
      persistActiveConvo({ ...activeConvoRef.current, [selectedBot.id]: list[0].id });
      setBlocks(loadBlocks(list[0].id));
      void loadThreadSummaries(list[0].id); void loadMessageReactions(list[0].id);
    } else {
      setBlocks([]);
      setThreadSummaries({});
    }
    closeThread();
  }, [selectedBotId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist overrides.
  useEffect(() => {
    if (!selectedBotId || !providerId) return;
    saveOverride(selectedBotId, { provider: providerId, model: modelId });
  }, [selectedBotId, providerId, modelId]);

  // Auto-scroll on new blocks.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  // Auto-grow the composer textarea (cap ~200px, then scroll).
  useEffect(() => {
    const ta = inputRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    }
  }, [input]);

  const newId = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `s${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  const convosRef = useRef(convos);
  convosRef.current = convos;
  const activeConvoRef = useRef(activeConvo);
  activeConvoRef.current = activeConvo;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  const persistConvos = (next: Record<string, Conversation[]>) => {
    setConvos(next);
    saveConvos(next);
  };

  const persistActiveConvo = (next: Record<string, string>) => {
    setActiveConvo(next);
    try {
      localStorage.setItem('mvp:activeConvo:v1', JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  // Restore saved conversations on mount.
  useEffect(() => {
    setConvos(loadConvos());
    setActiveConvo(loadActiveConvo());
  }, []);

  // Persist blocks for the active conversation whenever a turn settles.
  useEffect(() => {
    if (sending) return;
    const cid = activeConvoRef.current[selectedBotId];
    if (cid && blocksRef.current.length > 0) saveBlocks(cid, blocksRef.current);
  }, [blocks, sending, selectedBotId]);

  /** Switch to another conversation of the same bot. */
  const switchConvo = (botId: string, convoId: string) => {
    if (sending) stopTurn();
    turnSeq.current++;
    persistActiveConvo({ ...activeConvoRef.current, [botId]: convoId });
    setBlocks(loadBlocks(convoId));
    setSideOpen(false);
    closeThread();
    void loadThreadSummaries(convoId); void loadMessageReactions(convoId);
  };

  /**
   * Branch the active thread at a message: the server forks the chat
   * session (history up to & including that message) into a new thread,
   * and the UI mirrors it as a new local conversation with the same
   * blocks, then navigates to it.
   */
  const branchFromBlock = async (blockId: string) => {
    if (branching || sending) return;
    const botId = botIdRef.current;
    const cid = activeConvoRef.current[botId];
    const current = blocksRef.current;
    const idx = current.findIndex((b) => b.id === blockId);
    if (idx < 0 || !cid) return;
    const block = current[idx];
    if (block.kind !== 'user' && block.kind !== 'assistant' && block.kind !== 'voice-note') return;

    setBranching(true);
    try {
      // Map the UI block to a server message id: the n-th user/assistant
      // block (voice notes count as user turns) pairs with the n-th
      // user/assistant message in the thread's verbatim log.
      const ordinal = current.slice(0, idx + 1).filter((b) => b.kind === 'user' || b.kind === 'assistant' || b.kind === 'voice-note').length - 1;
      const log = await getChatThreadMessages(cid);
      const candidates = log.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
      if (candidates.length === 0) throw new Error('Thread has no messages to branch from.');
      const target = candidates[Math.min(ordinal, candidates.length - 1)];

      const convo = (convosRef.current[botId] ?? []).find((c) => c.id === cid);
      const title = `Branch of ${convo?.title ?? 'chat'}`.slice(0, 120);
      const res = await branchChatThread(cid, target.id, { title, botId });
      const thread = res.thread;

      const branchedBlocks = current.slice(0, idx + 1);
      const newConvo: Conversation = { id: thread.id, title: thread.title, createdAt: Date.now() };
      const list = convosRef.current[botId] ?? [];
      persistConvos({ ...convosRef.current, [botId]: [newConvo, ...list] });
      persistActiveConvo({ ...activeConvoRef.current, [botId]: newConvo.id });
      saveBlocks(newConvo.id, branchedBlocks);
      setBlocks(branchedBlocks);
      setSideOpen(false);
    } catch (err) {
      setBlocks((prev) => [
        ...prev,
        { kind: 'error', id: newId(), text: `Branch failed: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setBranching(false);
    }
  };

  /**
   * Map a UI block id to the server-side message id, using the same ordinal
   * approach as branching: the n-th user/assistant block pairs with the
   * n-th user/assistant message in the thread's verbatim log.
   */
  const mapBlockToServerMessage = async (
    blockId: string,
    cid: string,
  ): Promise<{ serverId: number; block: Extract<ChatBlock, { kind: 'user' | 'assistant' }> } | null> => {
    const current = blocksRef.current;
    const idx = current.findIndex((b) => b.id === blockId);
    if (idx < 0) return null;
    const block = current[idx];
    if (block.kind !== 'user' && block.kind !== 'assistant') return null;
    const ordinal =
      current.slice(0, idx + 1).filter((b) => b.kind === 'user' || b.kind === 'assistant').length - 1;
    const log = await getChatThreadMessages(cid);
    const candidates = log.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    if (candidates.length === 0) return null;
    const target = candidates[Math.min(ordinal, candidates.length - 1)];
    return { serverId: target.id, block: block as Extract<ChatBlock, { kind: 'user' | 'assistant' }> };
  };

  /** Load thread summaries (reply counts + unread) for the active conversation. */
  const loadThreadSummaries = useCallback(async (cid: string) => {
    try {
      const res = await getMessageThreads(cid);
      const byRoot: Record<string, MessageThreadSummary> = {};
      for (const t of res.threads ?? []) {
        if (t.rootClientId) byRoot[t.rootClientId] = t;
      }
      setThreadSummaries(byRoot);
    } catch {
      // Threads are additive; a failure here must not break the chat.
    }
  }, []);

  /**
   * Load message reactions for the active conversation (Codync parity).
   * Maps client block ids to server message ids, then batch-fetches.
   * Reacted messages are exempt from auto-mark-as-unread.
   */
  const loadMessageReactions = useCallback(async (cid: string) => {
    try {
      const log = await getChatThreadMessages(cid);
      const serverMessages = log.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
      if (serverMessages.length === 0) {
        setMessageReactions({});
        return;
      }
      const serverIds = serverMessages.map((m) => String(m.id));
      const res = await getMessageReactions(cid, serverIds);
      // Map server message id -> client block id via ordinal position.
      const blocks = blocksRef.current.filter((b) => b.kind === 'user' || b.kind === 'assistant');
      const byBlockId: Record<string, MessageReaction[]> = {};
      serverMessages.forEach((sm, idx) => {
        const block = blocks[idx];
        const reactions = res.byMessageId[String(sm.id)];
        if (block && reactions && reactions.length > 0) {
          byBlockId[block.id] = reactions;
        }
      });
      setMessageReactions(byBlockId);
    } catch {
      // Reactions are additive; a failure here must not break the chat.
    }
  }, []);

  /**
   * Toggle a reaction on a message block (Codync parity). Resolves the
   * client block id to the server message id, then toggles.
   */
  const toggleReactionForBlock = async (blockId: string, emoji: string) => {
    const botId = botIdRef.current;
    const cid = activeConvoRef.current[botId];
    if (!cid) return;
    try {
      const mapped = await mapBlockToServerMessage(blockId, cid);
      if (!mapped) return;
      const { toggleMessageReaction } = await import('../lib/api');
      const res = await toggleMessageReaction(cid, mapped.serverId, emoji);
      if (res.ok) {
        setMessageReactions((prev) => ({ ...prev, [blockId]: res.reactions }));
      }
    } catch {
      // Reactions are additive; failures must not break the chat.
    }
  };

  /**
   * Open the reply thread anchored to a message block: create the thread
   * (forking the session) if needed, then load its messages into the panel.
   */
  const openThreadFromBlock = async (blockId: string) => {
    if (threadLoading || threadSending) return;
    const botId = botIdRef.current;
    const cid = activeConvoRef.current[botId];
    if (!cid) return;
    setThreadLoading(true);
    try {
      const mapped = await mapBlockToServerMessage(blockId, cid);
      if (!mapped) throw new Error('Could not find that message on the server.');
      const res = await createMessageThread(cid, mapped.serverId, {
        rootClientId: blockId,
        botId,
      });
      const thread = res.thread;
      const detail = await getMessageThread(cid, thread.id);
      const blocks: ChatBlock[] = [];
      for (const m of detail.messages ?? []) {
        if (m.role === 'user') {
          blocks.push({ kind: 'user', id: newId(), text: m.content, ts: Date.parse(m.ts) || Date.now() });
        } else if (m.role === 'assistant') {
          blocks.push({
            kind: 'assistant',
            id: newId(),
            text: m.content,
            streaming: false,
            ts: Date.parse(m.ts) || Date.now(),
          });
        }
      }
      setOpenThread({
        id: thread.id,
        sessionId: cid,
        threadSessionId: thread.threadSessionId,
        rootClientId: blockId,
        rootText: mapped.block.kind === 'user' ? mapped.block.text : mapped.block.text.slice(0, 140),
      });
      setThreadBlocks(blocks);
      // Opening reads the thread; refresh summaries to clear the unread dot.
      await loadThreadSummaries(cid);
    } catch (err) {
      setThreadBlocks([
        { kind: 'error', id: newId(), text: `Could not open thread: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    } finally {
      setThreadLoading(false);
    }
  };

  const closeThread = useCallback(() => {
    setOpenThread(null);
    setThreadBlocks([]);
    setThreadInput('');
  }, []);

  /**
   * Send a reply in the open thread. The reply endpoint returns the
   * thread's forked session id; the turn runs through the normal chat
   * stream so approvals/queueing/telemetry all apply.
   */
  const sendThreadReply = async () => {
    const text = threadInput.trim();
    const thread = openThreadRef.current;
    if (!text || !thread || threadSending) return;
    const bot = selectedBotRef.current;
    if (!bot) return;
    setThreadSending(true);
    const userBlock: ChatBlock = { kind: 'user', id: newId(), text, ts: Date.now() };
    const assistantBlock: ChatBlock = {
      kind: 'assistant',
      id: newId(),
      text: '',
      streaming: true,
      ts: Date.now(),
      botName: bot.name,
    };
    setThreadBlocks((prev) => [...prev, userBlock, assistantBlock]);
    setThreadInput('');
    try {
      const rep = await replyInMessageThread(thread.sessionId, thread.id, text);
      const controller = new AbortController();
      for await (const event of streamChat({
        botId: bot.id,
        message: text,
        sessionId: rep.threadSessionId,
        provider: providerIdRef.current || undefined,
        model: modelIdRef.current || undefined,
        signal: controller.signal,
      })) {
        if ((event as { type?: string }).type === 'queued') continue;
        // Thread blocks share the ChatBlock shape; apply deltas to
        // threadBlocks instead of the main blocks.
        applyThreadEvent(event as StreamEvent, assistantBlock.id);
      }
    } catch (err) {
      setThreadBlocks((prev) => [
        ...prev.filter((b) => b.id !== assistantBlock.id),
        { kind: 'error', id: newId(), text: err instanceof Error ? err.message : String(err) },
      ]);
    } finally {
      setThreadBlocks((prev) =>
        prev.map((b) => (b.kind === 'assistant' ? { ...b, streaming: false } : b)),
      );
      setThreadSending(false);
      // Refresh the summary counts.
      loadThreadSummaries(thread.sessionId);
    }
  };

  /**
   * Minimal stream-event application for thread replies. Handles text
   * deltas and completion; tool/approval events in threads are rare and
   * surface as text fallbacks.
   */
  const applyThreadEvent = (event: StreamEvent, assistantId: string) => {
    const t = (event as { type?: string }).type ?? '';
    if (t === 'text' || t === 'delta' || t === 'content') {
      const chunk =
        (event as { text?: string; delta?: string; content?: string }).text ??
        (event as { delta?: string }).delta ??
        (event as { content?: string }).content ??
        '';
      if (chunk) {
        setThreadBlocks((prev) =>
          prev.map((b) => (b.id === assistantId && b.kind === 'assistant' ? { ...b, text: b.text + chunk } : b)),
        );
      }
      return;
    }
    if (t === 'done' || t === 'end' || t === 'complete') return;
    // Unknown event kinds: ignore (no crash on future event shapes).
  };

  const applyEvent = useCallback((event: StreamEvent) => {
    // Live code session: feed every event; auto-open the session view when
    // the agent starts writing code (unless the user dismissed it this turn).
    codeSessionRef.current.handleEvent(event);
    if (event.type === 'code_write' && !dismissedThisTurn.current) {
      setCodeViewOpen(true);
    }
    if (event.type === 'done') {
      const bid = botIdRef.current;
      const usage = event.usage;
      let costUsd: number | undefined;
      if (usage && bid) {
        const turnModel = modelIdRef.current || selectedBotRef.current?.model || '';
        const price = lookupPrice(modelPricesRef.current, providerIdRef.current, turnModel);
        costUsd = costOfUsage(price, usage).total;
        setSessionUsage((prev) => {
          const cur = prev[bid] ?? emptyUsage();
          return {
            ...prev,
            [bid]: {
              promptTokens: cur.promptTokens + usage.promptTokens,
              completionTokens: cur.completionTokens + usage.completionTokens,
              totalTokens: cur.totalTokens + usage.totalTokens,
            },
          };
        });
        setSessionCost((prev) => ({ ...prev, [bid]: (prev[bid] ?? 0) + (costUsd ?? 0) }));
      }
      setBlocks((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const b = next[i];
          if (b && b.kind === 'assistant') {
            next[i] = { ...b, streaming: false, usage: event.usage ?? undefined, costUsd };
            break;
          }
        }
        return next;
      });
      return;
    }
    setBlocks((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      switch (event.type) {
        case 'token': {
          if (last && last.kind === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, text: last.text + event.content };
          } else {
            next.push({ kind: 'assistant', id: nextId(), text: event.content, streaming: true, ts: Date.now(), botName: selectedBotRef.current?.name });
          }
          break;
        }
        case 'tool_call': {
          if (last && last.kind === 'assistant') {
            next[next.length - 1] = { ...last, streaming: false };
          }
          next.push({ kind: 'tool', id: nextId(), call: event.call });
          break;
        }
        case 'tool_result': {
          const idx = next.findIndex(
            (b) => b.kind === 'tool' && b.call.id === event.call.id,
          );
          if (idx >= 0) {
            const b = next[idx];
            if (b.kind === 'tool') next[idx] = { ...b, result: event.result, denied: event.denied };
          } else {
            next.push({ kind: 'tool', id: nextId(), call: event.call, result: event.result });
          }
          break;
        }
        case 'approval_required': {
          if (last && last.kind === 'assistant') {
            next[next.length - 1] = { ...last, streaming: false };
          }
          next.push({
            kind: 'approval',
            id: nextId(),
            approvalId: event.approvalId,
            call: event.call,
            status: 'pending',
          });
          break;
        }
        case 'interrupted': {
          next.push({ kind: 'interrupted', id: nextId(), text: event.reason || 'Turn interrupted.' });
          break;
        }
        case 'error': {
          next.push({ kind: 'error', id: nextId(), text: event.message });
          break;
        }
        case 'widget': {
          const validated = validateWidget(event.widget);
          if (validated.ok) {
            next.push({ kind: 'widget', id: nextId(), widget: validated.widget });
          } else {
            next.push({
              kind: 'error',
              id: nextId(),
              text: `Widget failed validation: ${validated.error}`,
            });
          }
          break;
        }
      }
      return next;
    });
  }, []);

  const stopTurn = useCallback(() => {
    const c = abortRef.current;
    if (c) {
      c.abort();
      abortRef.current = null;
    }
    // Also drop any live fusion SSE subscriptions.
    for (const unsub of fusionStreamsRef.current.values()) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    fusionStreamsRef.current.clear();
  }, []);

  /**
   * Run one chat turn. `leadBlock` replaces the plain user-text block —
   * used by voice notes, which render as an audio bubble while the
   * transcript drives the turn.
   */
  const sendImpl = async (rawText: string, leadBlock?: ChatBlock, fileIds?: string[]) => {
    const text = rawText.trim();
    const files = fileIds ?? attachedFiles.map((f) => f.id);
    if ((!text && files.length === 0) || !selectedBot) return;
    // A new message supersedes any in-flight turn on this session
    // (backend aborts the previous turn; we drop our old reader).
    stopTurn();
    // Fresh code session per turn — tabs show what THIS turn touches.
    codeSessionRef.current.reset();
    dismissedThisTurn.current = false;
    setCodeViewOpen(false);
    const seq = ++turnSeq.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);
    // Ensure an active conversation — its id doubles as the backend session id.
    let cid = activeConvoRef.current[selectedBot.id];
    const convoList = convosRef.current[selectedBot.id] ?? [];
    if (!cid || !convoList.some((c) => c.id === cid)) {
      const c: Conversation = { id: newId(), title: convoTitle(text), createdAt: Date.now() };
      persistConvos({ ...convosRef.current, [selectedBot.id]: [c, ...convoList] });
      persistActiveConvo({ ...activeConvoRef.current, [selectedBot.id]: c.id });
      cid = c.id;
    } else if (convoList.find((c) => c.id === cid)?.title === 'New chat') {
      // Retitle placeholder conversations from the first message.
      persistConvos({
        ...convosRef.current,
        [selectedBot.id]: convoList.map((c) => (c.id === cid ? { ...c, title: convoTitle(text) } : c)),
      });
    }
    const userBlock: ChatBlock = leadBlock ?? { kind: 'user', id: nextId(), text, ts: Date.now() };
    const assistantBlock: ChatBlock = { kind: 'assistant', id: nextId(), text: '', streaming: true, ts: Date.now(), botName: selectedBot.name };
    setBlocks((prev) => [...prev, userBlock, assistantBlock]);
    const budget = parseFloat(maxBudgetRef.current);
    try {
      for await (const event of streamChat({
        botId: selectedBot.id,
        message: text,
        sessionId: cid,
        provider: providerIdRef.current || undefined,
        model: modelIdRef.current || undefined,
        reasoningEffort: reasoningEffortRef.current,
        fileIds: files,
        sandboxMode: sandboxModeRef.current,
        queueMode: queueModeRef.current,
        autoApprove: autoApproveRef.current,
        planMode: planModeRef.current,
        maxBudgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : undefined,
        signal: controller.signal,
      })) {
        if (turnSeq.current !== seq) break; // superseded by a newer turn
        if (event.type === 'queued') {
          // Message queued for the turn boundary — show indicator, remove the
          // empty assistant block (the running turn's stream owns the UI).
          setQueuedCount(event.position);
          setBlocks((prev) => prev.filter((b) => b.id !== assistantBlock.id));
          setSending(false);
          break;
        }
        if (event.type === 'queued_turn_start') {
          // A queued message started on this stream — clear the indicator.
          setQueuedCount((n) => Math.max(0, n - 1));
        }
        applyEvent(event);
      }
    } catch (err) {
      if (turnSeq.current !== seq) return; // superseded; the new turn owns the UI
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      setBlocks((prev) => [
        ...prev,
        aborted
          ? { kind: 'interrupted', id: nextId(), text: 'Stopped. Send a new message to continue.' }
          : { kind: 'error', id: nextId(), text: err instanceof Error ? err.message : String(err) },
      ]);
    } finally {
      if (turnSeq.current === seq) {
        // Ensure no block is left in streaming state.
        setBlocks((prev) =>
          prev.map((b) => (b.kind === 'assistant' ? { ...b, streaming: false } : b)),
        );
        if (abortRef.current === controller) abortRef.current = null;
        setSending(false);
      }
    }
  };

  /** Text composer send. */
  const send = () => {
    const text = input.trim();
    if (!text && attachedFiles.length === 0) return;
    const fileIds = attachedFiles.map((f) => f.id);
    setInput('');
    setAttachedFiles([]);
    if (fusionModeRef.current && selectedBotRef.current) {
      void sendFusion(text);
      return;
    }
    void sendImpl(text, undefined, fileIds);
  };

  /**
   * Fusion-mode send: the message becomes a fusion run (planner + parallel
   * workers + fused synthesis). Progress streams in over SSE into a live
   * fusion block.
   */
  const sendFusion = async (text: string) => {
    const bot = selectedBotRef.current;
    if (!bot) return;
    stopTurn();
    const seq = ++turnSeq.current;
    setSending(true);
    const userBlock: ChatBlock = { kind: 'user', id: nextId(), text, ts: Date.now() };
    const blockId = nextId();
    const fusionBlock: ChatBlock = {
      kind: 'fusion',
      id: blockId,
      runId: '',
      state: emptyFusionState(),
      ts: Date.now(),
    };
    setBlocks((prev) => [...prev, userBlock, fusionBlock]);
    const patchState = (fn: (s: FusionLiveState) => FusionLiveState) => {
      if (turnSeq.current !== seq) return;
      setBlocks((prev) =>
        prev.map((b) => (b.kind === 'fusion' && b.id === blockId ? { ...b, state: fn(b.state) } : b)),
      );
    };
    try {
      const { runId } = await startFusionRun({ botId: bot.id, task: text });
      if (turnSeq.current !== seq) return;
      setBlocks((prev) =>
        prev.map((b) => (b.kind === 'fusion' && b.id === blockId ? { ...b, runId } : b)),
      );
      const unsubscribe = streamFusionRun(
        runId,
        (event: FusionStreamEvent) => {
          patchState((s) => applyFusionEvent(s, event));
          if (event.type === 'done' || event.type === 'error') {
            fusionStreamsRef.current.delete(blockId);
            if (turnSeq.current === seq) setSending(false);
          }
        },
        () => {
          patchState((s) => ({ ...s, status: 'failed', error: 'Lost connection to the fusion stream.' }));
          fusionStreamsRef.current.delete(blockId);
          if (turnSeq.current === seq) setSending(false);
        },
      );
      fusionStreamsRef.current.set(blockId, unsubscribe);
    } catch (err) {
      fusionStreamsRef.current.delete(blockId);
      if (turnSeq.current === seq) {
        setBlocks((prev) => [
          ...prev.filter((b) => b.id !== blockId),
          { kind: 'error', id: nextId(), text: err instanceof Error ? err.message : String(err) },
        ]);
        setSending(false);
      }
    }
  };

  /** Voice-note send: the audio bubble leads, its transcript drives the turn. */
  const sendVoiceNote = (note: VoiceNote) => {
    const voiceBlock: ChatBlock = {
      kind: 'voice-note',
      id: nextId(),
      audioDataUrl: note.audioDataUrl,
      mimeType: note.mimeType,
      durationMs: note.durationMs,
      transcript: note.transcript,
      ts: Date.now(),
    };
    void sendImpl(note.transcript.trim() || '(voice note)', voiceBlock);
  };

  const decide = async (blockId: string, approvalId: string, decision: 'approved' | 'denied') => {
    setBlocks((prev) =>
      prev.map((b) => (b.kind === 'approval' && b.id === blockId ? { ...b, status: decision } : b)),
    );
    try {
      await decideApproval(approvalId, decision);
    } catch (err) {
      setBlocks((prev) => [
        ...prev,
        { kind: 'error', id: nextId(), text: err instanceof Error ? err.message : String(err) },
      ]);
    }
  };

  /** "Always allow <tool>": persist an allow rule, then approve the pending card. */
  const alwaysAllow = async (blockId: string, approvalId: string, toolName: string) => {
    const botId = botIdRef.current;
    if (!botId) return;
    setBlocks((prev) =>
      prev.map((b) => (b.kind === 'approval' && b.id === blockId ? { ...b, remembering: true } : b)),
    );
    try {
      await allowTool(botId, toolName);
      await decideApproval(approvalId, 'approved', `User chose "always allow ${toolName}"`);
      setBlocks((prev) =>
        prev.map((b) =>
          b.kind === 'approval' && b.id === blockId
            ? { ...b, status: 'approved', remembering: false }
            : b,
        ),
      );
    } catch (err) {
      setBlocks((prev) => [
        ...prev,
        { kind: 'error', id: nextId(), text: err instanceof Error ? err.message : String(err) },
      ]);
      setBlocks((prev) =>
        prev.map((b) => (b.kind === 'approval' && b.id === blockId ? { ...b, remembering: false } : b)),
      );
    }
  };

  /** POST a widget action button back to the API, then note the outcome in chat. */
  const handleWidgetAction = async (action: WidgetAction, widget: Widget) => {
    const endpoint = action.endpoint ?? '/api/widget-action';
    try {
      const res = await fetch(`${getApiBase()}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionId: action.id,
          widgetKind: widget.kind,
          payload: action.payload ?? {},
        }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          detail = ((await res.json()) as { error?: string }).error ?? '';
        } catch {
          // ignore
        }
        throw new Error(`API ${res.status}: ${detail || res.statusText}`);
      }
      setBlocks((prev) => [
        ...prev,
        { kind: 'assistant', id: nextId(), text: `✓ ${action.label}`, streaming: false, ts: Date.now() },
      ]);
    } catch (err) {
      setBlocks((prev) => [
        ...prev,
        {
          kind: 'error',
          id: nextId(),
          text: `Action "${action.label}" failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    }
  };

  const newConversation = () => {
    if (!selectedBotId) return;
    stopTurn();
    turnSeq.current++;
    const c: Conversation = { id: newId(), title: 'New chat', createdAt: Date.now() };
    const list = convosRef.current[selectedBotId] ?? [];
    persistConvos({ ...convosRef.current, [selectedBotId]: [c, ...list] });
    persistActiveConvo({ ...activeConvoRef.current, [selectedBotId]: c.id });
    setSessionUsage((prev) => {
      const next = { ...prev };
      delete next[selectedBotId];
      return next;
    });
    setSessionCost((prev) => {
      const next = { ...prev };
      delete next[selectedBotId];
      return next;
    });
    setBlocks([]);
    setSideOpen(false);
  };

  const deleteConvo = (botId: string, convoId: string) => {
    if (sending) stopTurn();
    turnSeq.current++;
    const list = (convosRef.current[botId] ?? []).filter((c) => c.id !== convoId);
    persistConvos({ ...convosRef.current, [botId]: list });
    try {
      localStorage.removeItem(`mvp:blocks:${convoId}`);
    } catch {
      // ignore
    }
    if (activeConvoRef.current[botId] === convoId) {
      const nextId = list[0]?.id;
      const nextActive = { ...activeConvoRef.current };
      if (nextId) nextActive[botId] = nextId;
      else delete nextActive[botId];
      persistActiveConvo(nextActive);
      setBlocks(nextId ? loadBlocks(nextId) : []);
    }
  };

  const commitRename = (botId: string) => {
    const id = renamingId;
    setRenamingId(null);
    if (!id) return;
    const title = renameDraft.trim() || 'Untitled';
    persistConvos({
      ...convosRef.current,
      [botId]: (convosRef.current[botId] ?? []).map((c) => (c.id === id ? { ...c, title } : c)),
    });
  };

  // ---- slash commands ----
  const slashNames = Object.keys(slashCommands).sort();
  const slashQuery = input.startsWith('/') ? input.slice(1).split(/\s/)[0] ?? '' : null;
  const slashMatches =
    slashQuery !== null
      ? slashNames.filter((n) => n.startsWith(slashQuery.toLowerCase()))
      : [];
  const showSlashPop = slashQuery !== null && slashMatches.length > 0 && !sending;

  const pickSlash = (name: string) => {
    const qlen = slashQuery !== null ? slashQuery.length : 0;
    const rest = input.slice(1 + qlen);
    setInput(`/${name}${rest.startsWith(' ') ? '' : ' '}${rest.replace(/^\s+/, '')}`);
    setSlashHl(0);
    inputRef.current?.focus();
  };

  const refreshSlash = async () => {
    try {
      const sc = await getSlashCommands();
      setSlashCommands(sc.commands ?? {});
      setSlashError('');
    } catch (err) {
      setSlashError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveSlash = async () => {
    const name = slashDraft.name.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,32}$/.test(name)) {
      setSlashError('Name: 1–32 chars, lowercase letters, digits, hyphens.');
      return;
    }
    if (!slashDraft.prompt.trim()) {
      setSlashError('Prompt template is required. Use {args} for the typed arguments.');
      return;
    }
    try {
      const res = await saveSlashCommand(name, {
        description: slashDraft.description.trim(),
        prompt: slashDraft.prompt,
      });
      setSlashCommands(res.commands ?? {});
      setSlashDraft({ name: '', description: '', prompt: '' });
      setSlashError('');
    } catch (err) {
      setSlashError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeSlash = async (name: string) => {
    try {
      await deleteSlashCommand(name);
      await refreshSlash();
    } catch (err) {
      setSlashError(err instanceof Error ? err.message : String(err));
    }
  };

  const editSlash = (name: string) => {
    const c = slashCommands[name];
    if (!c) return;
    setSlashDraft({ name, description: c.description, prompt: c.prompt });
  };

  if (loadError) {
    return (
      <div>
        <h1 className="page-title">Chat</h1>
        <div className="error-box">
          Could not reach the API: {loadError}. Is it running? (see api: label in the top bar)
        </div>
      </div>
    );
  }

  const modelOptions = selectedProvider?.models ?? [];
  const activeModelId = modelId || selectedBot?.model || '';
  const contextLength = modelOptions.find((m) => m.id === activeModelId)?.contextLength;
  const botSessionUsage = selectedBotId ? sessionUsage[selectedBotId] : undefined;
  const botSessionCost = selectedBotId ? sessionCost[selectedBotId] : undefined;
  const sessionMeter = botSessionUsage ? contextMeter(botSessionUsage.totalTokens, contextLength) : null;

  return (
    <div className="chat-layout">
      <aside className={`bot-roster${sideOpen ? ' open' : ''}`} aria-label="Conversations and bots">
        <button className="btn btn-primary new-chat-btn" onClick={newConversation} disabled={!selectedBotId}>
          {t('chat.newChat')}
        </button>
        {selectedBotId && (
          <>
            <h3>Conversations</h3>
            <div className="convo-list">
              {(convos[selectedBotId] ?? []).map((c) => {
                const isActive = activeConvo[selectedBotId] === c.id;
                return (
                  <div key={c.id} className={`convo-item${isActive ? ' active' : ''}`}>
                    {renamingId === c.id ? (
                      <input
                        className="input convo-rename"
                        value={renameDraft}
                        autoFocus
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => commitRename(selectedBotId)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(selectedBotId);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        aria-label="Rename conversation"
                      />
                    ) : (
                      <button
                        className="convo-title"
                        onClick={() => switchConvo(selectedBotId, c.id)}
                        title={new Date(c.createdAt).toLocaleString()}
                      >
                        {c.title}
                      </button>
                    )}
                    <span className="convo-actions">
                      <button
                        className="icon-btn xs"
                        title="Rename"
                        aria-label={`Rename ${c.title}`}
                        onClick={() => {
                          setRenamingId(c.id);
                          setRenameDraft(c.title);
                        }}
                      >
                        ✏️
                      </button>
                      <button
                        className="icon-btn xs"
                        title="Delete"
                        aria-label={`Delete ${c.title}`}
                        onClick={() => deleteConvo(selectedBotId, c.id)}
                      >
                        🗑
                      </button>
                    </span>
                  </div>
                );
              })}
              {(convos[selectedBotId] ?? []).length === 0 && (
                <div className="small muted convo-empty">No conversations yet.</div>
              )}
            </div>
          </>
        )}
        <h3>Bots</h3>
        {bots.map((b) => (
          <button
            key={b.id}
            className={`bot-item${b.id === selectedBotId ? ' selected' : ''}`}
            onClick={() => {
              setSelectedBotId(b.id);
              setSideOpen(false);
            }}
          >
            <div className="bot-name">{b.name}</div>
            {b.description && <div className="bot-desc">{b.description}</div>}
            <div className="bot-ws small muted" title={b.workspace ? `Isolated workspace: ${b.workspace}` : 'Shared workspace'}>
              {b.workspace ? `📁 ${b.workspace}` : '📁 shared'}
            </div>
          </button>
        ))}
        {bots.length === 0 && <div className="small muted">Loading bots…</div>}
      </aside>
      {sideOpen && <div className="side-scrim" onClick={() => setSideOpen(false)} aria-hidden="true" />}

      <div className="chat-main">
        <div className="chat-header">
          <button
            className="icon-btn side-toggle"
            onClick={() => setSideOpen((v) => !v)}
            aria-label="Toggle conversations sidebar"
            title="Conversations"
          >
            ☰
          </button>
          <div
            className="model-picker"
            role="group"
            aria-label="Model picker"
            title="Provider · model · sandbox — switch mid-conversation, applies to the next message"
          >
            <span className="mp-icon" aria-hidden="true">◈</span>
            <select
              className="mp-select"
              value={providerId}
              onChange={(e) => {
                setProviderId(e.target.value);
                setModelId('');
              }}
              aria-label="Provider"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.configured ? '' : ' (no key)'}
                </option>
              ))}
            </select>
            <span className="mp-sep" aria-hidden="true">/</span>
            <select
              className="mp-select mp-model"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              aria-label="Model"
            >
              <option value="">(bot default)</option>
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span className="mp-sep" aria-hidden="true">·</span>
            <select
              className="mp-select mp-sandbox"
              value={sandboxMode}
              onChange={(e) => setSandboxMode(e.target.value as SandboxMode)}
              aria-label="Sandbox mode"
              title="Sandbox: read-only blocks writes/exec · workspace-write is the default · danger-full-access lifts the cage (approvals still apply)"
            >
              <option value="workspace-write">🛡️ Workspace</option>
              <option value="read-only">🔒 Read-only</option>
              <option value="danger-full-access">⚠️ Full access</option>
            </select>
            <span className="mp-sep" aria-hidden="true">·</span>
            <select
              className="mp-select mp-effort"
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value as ReasoningEffort)}
              aria-label="Reasoning effort"
              title="Reasoning effort: how hard the model thinks (low = fast, high = thorough). Applies to reasoning models."
            >
              <option value="low">🧠 Low</option>
              <option value="medium">🧠 Med</option>
              <option value="high">🧠 High</option>
            </select>
          </div>
          <select
            className="select steer-select"
            value={queueMode}
            onChange={(e) => setQueueMode(e.target.value as QueueMode)}
            aria-label="Steering mode"
            title="Steering: Interrupt aborts the running turn; Queue waits for the turn boundary (Claude Code style)"
          >
            <option value="interrupt">⚡ Interrupt</option>
            <option value="queue">⏳ Queue</option>
          </select>
          {queuedCount > 0 && (
            <span className="queued-badge" title={`${queuedCount} message(s) queued for the turn boundary`}>
              ⏳ {queuedCount} queued
            </span>
          )}
          <div
            className="mode-toggle"
            role="group"
            aria-label={t('chat.modeChatLabel')}
            title="Chat vs live voice call"
          >
            <button
              type="button"
              className={`mode-opt${chatMode === 'chat' ? ' active' : ''}`}
              onClick={() => setChatMode('chat')}
              aria-pressed={chatMode === 'chat'}
            >
              {t('chat.modeChat')}
            </button>
            <button
              type="button"
              className={`mode-opt${chatMode === 'call' ? ' active' : ''}`}
              onClick={() => setChatMode('call')}
              aria-pressed={chatMode === 'call'}
            >
              {t('chat.modeCall')}
            </button>
          </div>
          <LanguageSwitcher />
          <div className="spacer" style={{ flex: 1 }} />
          {autoApprove && <span className="mode-badge auto">AUTO-APPROVE ON</span>}
          {planMode && <span className="mode-badge plan">PLAN MODE</span>}
          <div className="settings-wrap">
            <button
              className={`icon-btn${settingsOpen ? ' active' : ''}`}
              onClick={() => setSettingsOpen((v) => !v)}
              aria-label="Run settings"
              aria-expanded={settingsOpen}
              title="Run settings: approvals, plan mode, budget, slash commands"
            >
              ⚙️
            </button>
            {settingsOpen && (
              <>
                <div className="pop-scrim" onClick={() => setSettingsOpen(false)} aria-hidden="true" />
                <div className="settings-pop" role="dialog" aria-label="Run settings">
                  <h4>Run settings</h4>
                  <ClayToggle
                    checked={autoApprove}
                    onChange={setAutoApprove}
                    label="Auto-approve"
                    title="Auto-approve this session: approval cards are skipped and tools run immediately (audited). Manual approval is the default."
                  />
                  <ClayToggle
                    checked={planMode}
                    onChange={setPlanMode}
                    label="Plan mode"
                    title="Plan mode: read-only exploration. File writes, shell commands and network calls are blocked."
                  />
                  <label className="budget-wrap" title="Fail-closed cap on estimated spend for one turn (USD).">
                    Max $ / turn
                    <input
                      className="input"
                      value={maxBudget}
                      onChange={(e) => setMaxBudget(e.target.value.replace(/[^0-9.]/g, ''))}
                      placeholder="—"
                      inputMode="decimal"
                      aria-label="Max dollars per turn"
                    />
                  </label>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setSettingsOpen(false);
                      setSlashMgrOpen(true);
                    }}
                    title="Create and manage /commands"
                  >
                    / Commands
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {chatMode === 'call' ? (
          <div className="chat-messages">
            {selectedBot ? (
              <CallPanel
                key={selectedBot.id}
                botId={selectedBot.id}
                botName={selectedBot.name}
                language={locale}
              />
            ) : (
              <p className="muted" style={{ padding: 16 }}>
                {t('chat.composerPlaceholderNoBot')}
              </p>
            )}
          </div>
        ) : (
          <>
            <CodingSessionStrip
              files={codeSession.files}
              active={codeSession.active}
              pendingApprovals={pendingApprovals}
              onDecide={decide}
              onOpenSession={() => {
                dismissedThisTurn.current = false;
                setCodeViewOpen(true);
              }}
            />
            {codeViewOpen && codeLayout === 'inline' && codeSession.files.length > 0 && (
              <CodeSessionView
                files={codeSession.files}
                layout="inline"
                onToggleLayout={() => setCodeLayout('side')}
                onClose={() => {
                  dismissedThisTurn.current = true;
                  setCodeViewOpen(false);
                }}
                onFileDone={codeSession.markFileDone}
              />
            )}
            {codeViewOpen && codeLayout === 'side' && codeSession.files.length > 0 && (
              <CodeSessionView
                files={codeSession.files}
                layout="side"
                onToggleLayout={() => setCodeLayout('inline')}
                onClose={() => {
                  dismissedThisTurn.current = true;
                  setCodeViewOpen(false);
                }}
                onFileDone={codeSession.markFileDone}
              />
            )}
        <div className="chat-messages" ref={messagesRef}>
          {blocks.length === 0 && (
            <div className="empty-state">
              <LazyClayScene className="empty-3d" />
              <div className="empty-pet">
                <Pet pet={petChoice.id} size={140} mood={petMood} />
              </div>
              <p>
                <strong>{t('chat.emptyAsk', { pet: petName })}</strong>
              </p>
              <p className="small muted">{selectedBot ? `Chatting as ${selectedBot.name}` : 'Select a bot'}</p>
              <p className="small">
                Send a message to start. Tool calls that need a human will pause here with an
                approval card — approve or deny inline and the agent continues.
              </p>
              <div className="chips" role="group" aria-label="Suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="chip-btn"
                    onClick={() => {
                      setInput(s);
                      inputRef.current?.focus();
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="small">
                Tip: type <span className="mono">/</span> for slash commands, <span className="mono">⌘↵</span> to
                send, flip on <strong>Auto-approve</strong> (⚙️) for hands-free runs, or use{' '}
                <strong>Plan mode</strong> to explore without changing anything.
              </p>
            </div>
          )}
          {blocks.map((b) => {
            switch (b.kind) {
              case 'user': {
                const summary = threadSummaries[b.id];
                return (
                  <div key={b.id} className="msg user" title={new Date(b.ts).toLocaleString()}>
                    <div className="msg-head">
                      <span className="avatar you" aria-hidden="true">
                        You
                      </span>
                      <span className="msg-time">{fmtTime(b.ts)}</span>
                      <CopyBtn text={b.text} />
                      <BranchBtn onBranch={() => branchFromBlock(b.id)} disabled={branching || sending} />
                      <ThreadBtn
                        onThread={() => openThreadFromBlock(b.id)}
                        disabled={threadLoading || sending}
                        replyCount={summary?.replyCount}
                        unread={summary?.unread}
                      />
                    </div>
                    <div className="msg-text">{b.text}</div>
                    <MessageReactions
                      reactions={messageReactions[b.id] ?? []}
                      onToggle={(emoji) => toggleReactionForBlock(b.id, emoji)}
                      disabled={sending}
                    />
                    {summary && summary.replyCount > 0 && (
                      <button
                        type="button"
                        className="thread-summary"
                        onClick={() => openThreadFromBlock(b.id)}
                      >
                        💬 {summary.replyCount} {summary.replyCount === 1 ? 'reply' : 'replies'}
                        {summary.unread ? ' • new' : ''}
                      </button>
                    )}
                  </div>
                );
              }
              case 'voice-note':
                return (
                  <div key={b.id} className="msg user" title={new Date(b.ts).toLocaleString()}>
                    <div className="msg-head">
                      <span className="avatar you" aria-hidden="true">
                        You
                      </span>
                      <span className="msg-time">{fmtTime(b.ts)}</span>
                    </div>
                    {b.audioDataUrl ? (
                      <VoiceNoteBubble
                        audioDataUrl={b.audioDataUrl}
                        mimeType={b.mimeType}
                        durationMs={b.durationMs}
                        transcript={b.transcript}
                        from="user"
                      />
                    ) : (
                      <div className="msg-text">
                        <span className="small muted">
                          {t('voice.voiceNote')} · {t('voice.transcript')}:{' '}
                        </span>
                        {b.transcript}
                      </div>
                    )}
                  </div>
                );
              case 'assistant': {
                const botLabel = b.botName ?? selectedBot?.name ?? 'Assistant';
                const summary = threadSummaries[b.id];
                return (
                  <div key={b.id} className="msg assistant" title={new Date(b.ts).toLocaleString()}>
                    <div className="msg-head">
                      <span className="avatar bot" aria-hidden="true">
                        {botLabel.charAt(0).toUpperCase()}
                      </span>
                      <span className="msg-author">{botLabel}</span>
                      <span className="msg-time">{fmtTime(b.ts)}</span>
                      {b.text.length > 0 && <CopyBtn text={b.text} />}
                      {!b.streaming && (
                        <BranchBtn onBranch={() => branchFromBlock(b.id)} disabled={branching || sending} />
                      )}
                      {!b.streaming && (
                        <ThreadBtn
                          onThread={() => openThreadFromBlock(b.id)}
                          disabled={threadLoading || sending}
                          replyCount={summary?.replyCount}
                          unread={summary?.unread}
                        />
                      )}
                    </div>
                    {summary && summary.replyCount > 0 && (
                      <button
                        type="button"
                        className="thread-summary"
                        onClick={() => openThreadFromBlock(b.id)}
                      >
                        💬 {summary.replyCount} {summary.replyCount === 1 ? 'reply' : 'replies'}
                        {summary.unread ? ' • new' : ''}
                      </button>
                    )}
                    <div className="msg-text">
                      {b.streaming && b.text.length === 0 ? (
                        <span>
                          <span className="thinking-pet" aria-hidden="true">
                            <Pet pet={petChoice.id} size={22} mood="thinking" label="" />
                          </span>
                          <span className="typing-dots" aria-label="Thinking">
                            <i />
                            <i />
                            <i />
                          </span>
                        </span>
                      ) : (
                        <>
                          {b.text}
                          {b.streaming && <span className="stream-caret" aria-hidden="true" />}
                        </>
                      )}
                    </div>
                    {!b.streaming && (
                      <MessageReactions
                        reactions={messageReactions[b.id] ?? []}
                        onToggle={(emoji) => toggleReactionForBlock(b.id, emoji)}
                        disabled={sending}
                      />
                    )}
                    {b.usage && (
                      <UsageFooter usage={b.usage} contextLength={contextLength} costUsd={b.costUsd} />
                    )}
                  </div>
                );
              }
              case 'widget':
                return (
                  <WidgetRenderer
                    key={b.id}
                    widget={b.widget}
                    onAction={(a, w) => void handleWidgetAction(a, w)}
                  />
                );
              case 'fusion':
                return (
                  <div key={b.id} className="msg-row assistant">
                    <FusionProgressView state={b.state} />
                  </div>
                );
              case 'tool': {
                const notice =
                  (b.call.name === 'ask_bot' || b.call.name === 'message_bot') &&
                  b.result !== undefined &&
                  typeof b.result === 'object' &&
                  b.result !== null &&
                  'notice' in b.result
                    ? (b.result as { notice: BotNoticeData }).notice
                    : null;
                if (notice) {
                  return (
                    <BotNoticeRow
                      key={b.id}
                      notice={notice}
                      bots={bots.map((x) => ({ id: x.id, name: x.name }))}
                      onOpenSheet={(peerId) => setConvSheetPeer(peerId)}
                    />
                  );
                }
                return (
                  <details key={b.id} className="tool-row">
                    <summary>
                      <span className={`chip${b.denied ? ' red' : b.result !== undefined ? ' green' : ' gray'}`}>
                        {b.denied ? 'denied' : b.result !== undefined ? 'done' : 'running'}
                      </span>
                      <span className="mono">{b.call.name}</span>
                    </summary>
                    <div className="tool-body">
                      <ToolCallBody call={b.call} />
                      {b.result !== undefined && (
                        <>
                          <div className="label mt">Result</div>
                          <pre className="mono small">{prettyJson(b.result)}</pre>
                        </>
                      )}
                    </div>
                  </details>
                );
              }
              case 'approval':
                return (
                  <div key={b.id} className="approval-card">
                    <h4>Approval required — <span className="mono">{b.call.name}</span></h4>
                    <pre>{prettyJson(b.call.args)}</pre>
                    {b.status === 'pending' ? (
                      <div className="approval-actions">
                        <button className="btn btn-primary btn-sm" disabled={b.remembering} onClick={() => decide(b.id, b.approvalId, 'approved')}>
                          Approve
                        </button>
                        <button className="btn btn-danger btn-sm" disabled={b.remembering} onClick={() => decide(b.id, b.approvalId, 'denied')}>
                          Deny
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={b.remembering}
                          onClick={() => void alwaysAllow(b.id, b.approvalId, b.call.name)}
                          title={`Never ask for ${b.call.name} again on this bot — saves a persistent allow rule, then approves this call.`}
                        >
                          {b.remembering ? 'Saving…' : `Always allow ${b.call.name}`}
                        </button>
                      </div>
                    ) : (
                      <div className="small muted mt">
                        {b.status === 'approved' ? 'Approved — the agent continues.' : 'Denied.'}
                      </div>
                    )}
                  </div>
                );
              case 'interrupted':
                return (
                  <div key={b.id} className="msg interrupted">
                    ⏹ {b.text}
                  </div>
                );
              case 'error':
                return (
                  <div key={b.id} className="msg error">
                    {b.text}
                  </div>
                );
            }
          })}
        </div>

        <div className="chat-input-wrap">
          {showSlashPop && (
            <div className="slash-pop" role="listbox" aria-label="Slash commands">
              {slashMatches.map((name, i) => (
                <button
                  key={name}
                  role="option"
                  aria-selected={i === slashHl}
                  className={`slash-opt${i === slashHl ? ' hl' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSlash(name);
                  }}
                  onMouseEnter={() => setSlashHl(i)}
                >
                  <span className="cmd">/{name}</span>
                  <span className="desc">{slashCommands[name]?.description || '—'}</span>
                </button>
              ))}
            </div>
          )}
          <div className="chat-input">
            {/* Feature interconnection (P2-E): attach a note/page so it lands
                in the bot's context on every turn. */}
            <NoteAttachButton
              botId={selectedBotId}
              botName={selectedBot?.name ?? 'bot'}
              sessionId={selectedBotId ? (activeConvo[selectedBotId] ?? '') : ''}
              disabled={!selectedBot}
            />
            {/* File upload: attach files to the chat message. */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length === 0) return;
                setUploading(true);
                try {
                  for (const f of files) {
                    if (f.size > 100 * 1024 * 1024) {
                      setLoadError(`"${f.name}" is too large (max 100MB)`);
                      continue;
                    }
                    const uploaded = await uploadFile(f);
                    setAttachedFiles((prev) => [...prev, uploaded]);
                  }
                } catch (err) {
                  setLoadError(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
                } finally {
                  setUploading(false);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }
              }}
            />
            <button
              className="btn btn-icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={!selectedBot || uploading}
              title="Attach files to this message"
              aria-label="Attach files"
            >
              {uploading ? '⏳' : '📎'}
            </button>
            {attachedFiles.length > 0 && (
              <div className="attached-files">
                {attachedFiles.map((f) => (
                  <span key={f.id} className="file-chip" title={
                    f.extracted
                      ? `Text extracted${f.extracted.units ? ` (${f.extracted.units} ${f.extracted.unitLabel ?? 'units'})` : ''}${f.extracted.truncated ? ' — truncated to 100KB' : ''}`
                      : f.extractFailed
                        ? 'Preview not available'
                        : f.name
                  }>
                    {fileTypeIcon(f.name, f.mimeType)} {f.name}
                    {f.extracted && (
                      <span className="extract-badge">
                        ✓{f.extracted.units ? ` ${f.extracted.units}${f.extracted.unitLabel ? ` ${f.extracted.unitLabel}` : ''}` : ''}
                      </span>
                    )}
                    {f.extractFailed && <span className="extract-badge extract-failed">no preview</span>}
                    <button
                      onClick={async () => {
                        try {
                          await deleteUploadedFile(f.id);
                        } catch {
                          // ignore
                        }
                        setAttachedFiles((prev) => prev.filter((x) => x.id !== f.id));
                      }}
                      aria-label={`Remove ${f.name}`}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              className="input composer"
              value={input}
              rows={1}
              onChange={(e) => {
                setInput(e.target.value);
                setSlashHl(0);
              }}
              onKeyDown={(e) => {
                if (showSlashPop && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault();
                  setSlashHl((h) =>
                    e.key === 'ArrowDown'
                      ? (h + 1) % slashMatches.length
                      : (h - 1 + slashMatches.length) % slashMatches.length,
                  );
                  return;
                }
                if (showSlashPop && e.key === 'Tab') {
                  e.preventDefault();
                  pickSlash(slashMatches[slashHl] ?? slashMatches[0] ?? '');
                  return;
                }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={selectedBot ? t('chat.composerPlaceholder', { bot: selectedBot.name }) : t('chat.composerPlaceholderNoBot')}
              disabled={!selectedBot}
              aria-label={t('chat.composerLabel')}
            />
            <VoiceNoteRecorder
              stt={getWebSTTProvider()}
              disabled={!selectedBot || sending}
              onVoiceNote={sendVoiceNote}
              onError={(msg) =>
                setBlocks((prev) => [...prev, { kind: 'error', id: nextId(), text: msg }])
              }
            />
            {sending ? (
              <button className="btn btn-stop" onClick={stopTurn} title={t('chat.stopTitle')}>
                ⏹ {t('chat.stop')}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void send()} disabled={!input.trim()}>
                {t('chat.send')}
              </button>
            )}
          </div>
          <div className="composer-footer">
            <span className="mono" title="Rough estimate: ~4 characters per token">
              ≈{formatTokens(estimateTokens(input))} tok
            </span>
            <span className="kbd-hint" title="Enter sends · Shift+Enter for a new line">
              <kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline
            </span>
            <button
              type="button"
              className={`fusion-toggle${fusionMode ? ' on' : ''}`}
              title="Fusion mode: decompose the task, run workers in parallel, fuse the results"
              aria-pressed={fusionMode}
              onClick={() => setFusionMode((v) => !v)}
            >
              ⚡ Fusion{fusionMode ? ' on' : ''}
            </button>
            <a className="fusion-history-link" href="/fusion" title="Past fusion runs">
              history
            </a>
            {botSessionUsage ? (
              <span
                className="mono"
                title={`Session: ${botSessionUsage.promptTokens} in / ${botSessionUsage.completionTokens} out`}
              >
                Σ {formatTokens(botSessionUsage.totalTokens)}
                {botSessionCost !== undefined && (
                  <span title={COST_ESTIMATE_TOOLTIP}> · ≈{formatUsd(botSessionCost)}</span>
                )}
                {sessionMeter && (
                  <span className={sessionMeter.warn ? 'amber' : undefined}>
                    {' '}· ctx {Math.round(sessionMeter.pct)}%
                  </span>
                )}
              </span>
            ) : (
              <span className="muted">No usage yet</span>
            )}
          </div>
        </div>
          </>
        )}
      </div>

      {/* Reply thread panel (slide-over) */}
      {openThread && (
        <div
          className="thread-panel"
          role="dialog"
          aria-label="Reply thread"
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            width: 420,
            maxWidth: '94vw',
            zIndex: 60,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg, #14141c)',
            borderLeft: '1px solid var(--border, #2a2a35)',
            boxShadow: '-12px 0 32px rgba(0,0,0,0.35)',
          }}
        >
          <div
            className="thread-panel-head"
            style={{ padding: '12px 14px', borderBottom: '1px solid var(--border, #2a2a35)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <strong>💬 Thread</strong>
              <button className="icon-btn" aria-label="Close thread" onClick={closeThread}>
                ✕
              </button>
            </div>
            <p className="small muted" style={{ margin: '6px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              on: {openThread.rootText.slice(0, 90)}
            </p>
          </div>
          <div className="thread-panel-body" style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
            {threadLoading ? (
              <p className="small muted">Loading thread…</p>
            ) : (
              threadBlocks.map((b) => {
                if (b.kind === 'user') {
                  return (
                    <div key={b.id} className="msg user" style={{ marginBottom: 10 }}>
                      <div className="msg-head">
                        <span className="avatar you" aria-hidden="true">You</span>
                        <span className="msg-time">{fmtTime(b.ts)}</span>
                      </div>
                      <div className="msg-text">{b.text}</div>
                    </div>
                  );
                }
                if (b.kind === 'assistant') {
                  return (
                    <div key={b.id} className="msg assistant" style={{ marginBottom: 10 }}>
                      <div className="msg-head">
                        <span className="avatar bot" aria-hidden="true">
                          {(b.botName ?? selectedBot?.name ?? 'A').charAt(0).toUpperCase()}
                        </span>
                        <span className="msg-author">{b.botName ?? selectedBot?.name ?? 'Assistant'}</span>
                        <span className="msg-time">{fmtTime(b.ts)}</span>
                        {b.text.length > 0 && <CopyBtn text={b.text} />}
                      </div>
                      <div className="msg-text">
                        {b.streaming && b.text.length === 0 ? (
                          <span className="typing-dots" aria-label="Thinking">
                            <i />
                            <i />
                            <i />
                          </span>
                        ) : (
                          <>
                            {b.text}
                            {b.streaming && <span className="stream-caret" aria-hidden="true" />}
                          </>
                        )}
                      </div>
                    </div>
                  );
                }
                if (b.kind === 'error') {
                  return (
                    <div key={b.id} className="msg error" style={{ marginBottom: 10 }}>
                      <div className="msg-text">⚠️ {b.text}</div>
                    </div>
                  );
                }
                return null;
              })
            )}
          </div>
          <div
            className="thread-panel-composer"
            style={{ padding: 12, borderTop: '1px solid var(--border, #2a2a35)' }}
          >
            <div style={{ display: 'flex', gap: 8 }}>
              <textarea
                className="input composer"
                value={threadInput}
                rows={2}
                onChange={(e) => setThreadInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
                    e.preventDefault();
                    void sendThreadReply();
                  }
                }}
                placeholder="Reply in thread…"
                disabled={threadSending || threadLoading}
                aria-label="Reply in thread"
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-primary"
                onClick={() => void sendThreadReply()}
                disabled={!threadInput.trim() || threadSending || threadLoading}
              >
                {threadSending ? '…' : 'Send'}
              </button>
            </div>
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              Replies stay in this thread — the main chat is untouched.
            </p>
          </div>
        </div>
      )}

      {/* Slash command manager */}
      {slashMgrOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            background: 'rgba(10,10,15,0.45)',
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSlashMgrOpen(false);
          }}
        >
          <div className="card" style={{ width: 560, maxWidth: '100%', maxHeight: '86vh', overflowY: 'auto' }} role="dialog" aria-label="Slash commands">
            <div className="row-between">
              <h3 style={{ margin: 0 }}>Slash commands</h3>
              <button className="icon-btn" aria-label="Close" onClick={() => setSlashMgrOpen(false)}>✕</button>
            </div>
            <p className="small muted">
              Type <span className="mono">/name args</span> in chat to run one. Use{' '}
              <span className="mono">{'{args}'}</span> in the prompt for the typed arguments.
            </p>
            {slashError && <div className="error-box">{slashError}</div>}
            <div className="slash-list">
              {slashNames.length === 0 && <p className="small muted">No commands yet — create the first below.</p>}
              {slashNames.map((name) => (
                <div key={name} className="card slash-item" style={{ padding: '12px 14px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="cmd">/{name}</span>
                    <div className="small muted truncate">{slashCommands[name]?.description || '—'}</div>
                  </div>
                  <button className="btn btn-sm" onClick={() => editSlash(name)}>Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => void removeSlash(name)}>Delete</button>
                </div>
              ))}
            </div>
            <h4 className="mt">{slashDraft.name && slashCommands[slashDraft.name] ? 'Edit command' : 'New command'}</h4>
            <div className="field">
              <label className="label" htmlFor="slash-name">Name</label>
              <input
                id="slash-name"
                className="input"
                value={slashDraft.name}
                onChange={(e) => setSlashDraft((d) => ({ ...d, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
                placeholder="work"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="slash-desc">Description</label>
              <input
                id="slash-desc"
                className="input"
                value={slashDraft.description}
                onChange={(e) => setSlashDraft((d) => ({ ...d, description: e.target.value }))}
                placeholder="Implement the feature end-to-end"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="slash-prompt">Prompt template (use {'{args}'})</label>
              <textarea
                id="slash-prompt"
                className="textarea"
                rows={5}
                value={slashDraft.prompt}
                onChange={(e) => setSlashDraft((d) => ({ ...d, prompt: e.target.value }))}
                placeholder="Implement this feature completely: {args}. Write the code, add tests, and summarize."
              />
            </div>
            <div className="approval-actions">
              <button className="btn btn-primary btn-sm" onClick={() => void saveSlash()}>Save command</button>
              <button className="btn btn-sm" onClick={() => { setSlashDraft({ name: '', description: '', prompt: '' }); setSlashError(''); }}>Clear</button>
            </div>
          </div>
        </div>
      )}
      {convSheetPeer && selectedBotId && (
        <BotConversationSheet
          botId={selectedBotId}
          peerId={convSheetPeer}
          peerName={bots.find((x) => x.id === convSheetPeer)?.name ?? convSheetPeer}
          onClose={() => setConvSheetPeer(null)}
        />
      )}
    </div>
  );
}

/**
 * Default export: the chat destination wrapped in the i18n provider.
 * (Global mount point would be app/layout.tsx around {children} — reported
 * in docs/I18N.md since layout/nav are owned by the navigation workstream.)
 */
export default function ChatPage() {
  return (
    <I18nProvider>
      <ChatPageInner />
    </I18nProvider>
  );
}
