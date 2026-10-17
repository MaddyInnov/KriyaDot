// SPDX-License-Identifier: Apache-2.0
// Test helpers: a scripted fake KriyaDotApi and an in-memory CommandDeps.
import type {
  BotSummary,
  ChatEvent,
  ChatRequest,
  McpServerInfo,
  ModelInfo,
  RoutineSummary,
  ThreadMessage,
  ThreadSummary,
  KriyaDotApi,
} from '../src/api.js';
import type { ChatCallbacks } from '../src/api.js';
import type { CommandDeps } from '../src/commands.js';
import type { CliConfig } from '../src/config.js';
import type { ReplLineSource } from '../src/repl.js';

export interface FakeApiOptions {
  bots?: BotSummary[];
  models?: ModelInfo[];
  threads?: ThreadSummary[];
  messages?: ThreadMessage[];
  branchResult?: { id: string; title: string; botId: string };
  routines?: RoutineSummary[];
  routineRuns?: Array<{ id: string; routineId: string; status: string; startedAt?: number }>;
  mcpServers?: McpServerInfo[];
  /** Scripted SSE events for each sendChat call. */
  chatScript?: ChatEvent[];
  onChatRequest?: (req: ChatRequest) => void;
  health?: boolean;
}

export interface FakeApi extends FakeApiOptions {
  decisions: Array<{ approvalId: string; decision: string }>;
  chatRequests: ChatRequest[];
  deletedThreads: string[];
  importedMarkdown?: string;
  exportedMarkdown?: string;
  importedManifest?: unknown;
  asApi(): KriyaDotApi;
}

export function makeFakeApi(opts: FakeApiOptions = {}): FakeApi {
  const fake: FakeApi = {
    ...opts,
    decisions: [],
    chatRequests: [],
    deletedThreads: [],
    asApi() {
      const self = this;
      return {
        health: async () => self.health ?? true,
        listBots: async () => self.bots ?? [],
        listModels: async () => self.models ?? [],
        listThreads: async () => self.threads ?? [],
        threadMessages: async () => self.messages ?? [],
        branchThread: async () => self.branchResult ?? { id: 'new-thread', title: 'Branch', botId: 'bot-a' },
        deleteThread: async (threadId: string) => {
          self.deletedThreads.push(threadId);
        },
        listRoutines: async () => self.routines ?? [],
        runRoutineNow: async () => 'run-123',
        listRoutineRuns: async () => self.routineRuns ?? [],
        listMcpServers: async () => self.mcpServers ?? [],
        importTeamMarkdown: async (markdown: string) => {
          self.importedMarkdown = markdown;
          return { id: 'team-1', name: 'Imported team' };
        },
        exportTeamMarkdown: async () => self.exportedMarkdown ?? '# Team: Exported\n',
        importTeamManifest: async (manifest: unknown) => {
          self.importedManifest = manifest;
          return { id: 'team-2', name: 'Manifest team' };
        },
        decideApproval: async (approvalId: string, decision: 'approved' | 'denied') => {
          self.decisions.push({ approvalId, decision });
        },
        sendChat: async (req: ChatRequest, cb: ChatCallbacks) => {
          self.chatRequests.push(req);
          const controller = new AbortController();
          const script = self.chatScript ?? [{ type: 'done' } as ChatEvent];
          queueMicrotask(() => {
            for (const ev of script) cb.onEvent(ev);
          });
          return controller;
        },
      } as unknown as KriyaDotApi;
    },
  };
  return fake;
}

export interface CapturedDeps extends CommandDeps {
  stdoutText: () => string;
  stderrText: () => string;
}

export function makeDeps(fake: FakeApi, opts: Partial<CommandDeps> = {}): CapturedDeps {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const stdout = { write: (s: string) => (outChunks.push(s), true) } as unknown as NodeJS.WritableStream;
  const stderr = { write: (s: string) => (errChunks.push(s), true) } as unknown as NodeJS.WritableStream;
  const stdin = {} as NodeJS.ReadableStream;
  const cfg: CliConfig = { apiUrl: 'http://localhost:4000', token: 'test-token' };
  const deps = {
    cfg,
    api: fake.asApi(),
    createApi: () => fake.asApi(),
    stdin,
    stdout,
    stderr,
    isTTY: false,
    readStdinAll: async () => '',
    prompt: async () => null,
    clearScreen: () => undefined,
    createLineSource: () => {
      throw new Error('no line source in this test');
    },
    ...opts,
    stdoutText: () => outChunks.join(''),
    stderrText: () => errChunks.join(''),
  } as CapturedDeps;
  return deps;
}

/** Fake REPL line source playing a script; null entries in the script mean EOF. */
export function makeFakeLines(script: Array<string | null>): ReplLineSource & { asked: string[] } {
  const asked: string[] = [];
  const remaining = [...script];
  return {
    asked,
    question: async (prompt: string) => {
      asked.push(prompt);
      if (remaining.length === 0) return null;
      return remaining.shift() ?? null;
    },
    onInterrupt: () => undefined,
    close: () => undefined,
  };
}
