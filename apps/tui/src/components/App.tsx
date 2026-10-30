// SPDX-License-Identifier: Apache-2.0
// Root component: view routing, per-bot transcripts, connection status,
// global keys, theming.
import React, { useCallback, useEffect, useState } from 'react';
import { randomUUID } from 'node:crypto';
import { Box, Text, useApp, useInput } from 'ink';
import type { BotSummary, KriyaDotApi } from '../api.js';
import { helpText } from '../commands.js';
import type { ThemeName, TuiPalette } from '../themes.js';
import { getPalette } from '../themes.js';
import type { TuiConfig } from '../config.js';
import { saveConfig } from '../config.js';
import { ChatView, nextMessageId, type ChatCommand, type ChatMessage } from './ChatView.js';
import { BotsView } from './BotsView.js';
import { WorkflowsView } from './WorkflowsView.js';
import { ActivityView } from './ActivityView.js';
import { MemoryView } from './MemoryView.js';
import { ModelsView } from './ModelsView.js';
import { JobsView } from './JobsView.js';
import { JobManager } from '../jobs.js';

type View = 'chat' | 'bots' | 'workflows' | 'activity' | 'memory' | 'models' | 'jobs';

interface Props {
  api: KriyaDotApi;
  config: TuiConfig;
}

const VIEW_TITLES: Record<View, string> = {
  chat: 'Chat',
  bots: 'Bots',
  workflows: 'Workflows',
  activity: 'Activity',
  memory: 'Memory',
  models: 'Models',
  jobs: 'Jobs',
};

export function App({ api, config }: Props): React.ReactElement {
  const { exit } = useApp();
  const [palette, setPalette] = useState<TuiPalette>(() => getPalette(config.theme));
  const [themeName, setThemeName] = useState<ThemeName>(config.theme);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [bot, setBot] = useState<BotSummary | null>(null);
  const [sessionId, setSessionId] = useState(() => randomUUID());
  const [view, setView] = useState<View>('bots');
  const [connectionError, setConnectionError] = useState('');
  /** Per-bot transcripts, so switching views doesn't lose chat history. */
  const [transcripts, setTranscripts] = useState<Record<string, ChatMessage[]>>({});
  /** Shared background-job registry (#187): ChatView registers turns, JobsView manages them. */
  const [jobManager] = useState(() => new JobManager());

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await api.listBots();
        if (!alive) return;
        setBots(list);
        const preferred = config.defaultBot ? list.find((b) => b.id === config.defaultBot) : undefined;
        const chosen = preferred ?? (list.length === 1 ? list[0] : null);
        if (chosen) {
          setBot(chosen);
          setView('chat');
        } else {
          setView('bots');
        }
      } catch (err) {
        if (alive) setConnectionError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, config.defaultBot]);

  const botMessages = bot ? (transcripts[bot.id] ?? []) : [];

  const setBotMessages = useCallback(
    (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      if (!bot) return;
      const id = bot.id;
      setTranscripts((t) => {
        const prev = t[id] ?? [{ id: nextMessageId(), role: 'system', text: `Chatting with ${bot.name}. Type /help for commands.` }];
        return { ...t, [id]: updater(prev) };
      });
    },
    [bot],
  );

  const postSystem = useCallback(
    (text: string) => {
      setBotMessages((m) => [...m, { id: nextMessageId(), role: 'system', text }]);
    },
    [setBotMessages],
  );

  const selectBot = useCallback((b: BotSummary) => {
    setBot(b);
    setSessionId(randomUUID());
    setView('chat');
  }, []);

  const applyTheme = useCallback(
    (name: ThemeName) => {
      setThemeName(name);
      setPalette(getPalette(name));
      try {
        saveConfig({ ...config, theme: name });
      } catch {
        // config persistence is best-effort
      }
      postSystem(`Theme switched to ${name}.`);
    },
    [config, postSystem],
  );

  const switchModel = useCallback(
    (modelId: string) => {
      if (!bot) return;
      void api
        .setBotModel(bot.id, modelId)
        .then(() => {
          setBot((b) => (b ? { ...b, model: modelId } : b));
          postSystem(`✓ Model switched to ${modelId}`);
        })
        .catch((err: Error) => postSystem(`⚠ Model switch failed: ${err.message}`));
    },
    [api, bot, postSystem],
  );

  const handleChatCommand = useCallback(
    (cmd: ChatCommand) => {
      switch (cmd.kind) {
        case 'bots':
          setView('bots');
          break;
        case 'workflows':
          setView('workflows');
          break;
        case 'activity':
          setView('activity');
          break;
        case 'memory':
          if (bot) setView('memory');
          break;
        case 'jobs':
          setView('jobs');
          break;
        case 'model-list':
          setView('models');
          break;
        case 'model-set':
          if (cmd.args) {
            switchModel(cmd.args);
            setView('chat');
          }
          break;
        case 'help':
          postSystem(`\n${helpText()}`);
          break;
        case 'clear':
          if (bot) setTranscripts((t) => ({ ...t, [bot.id]: [] }));
          break;
        case 'quit':
          exit();
          break;
        case 'unknown':
          break;
      }
    },
    [bot, exit, postSystem, switchModel],
  );

  // Global keys: Ctrl+C quits everywhere; Esc returns to chat from sub-views.
  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'C')) exit();
    else if (key.escape && view !== 'chat' && bot) setView('chat');
  });

  if (connectionError) {
    return (
      <Box padding={1} flexDirection="column">
        <Text color={palette.red} bold>Cannot reach the KriyaDot API</Text>
        <Text color={palette.text}>{connectionError}</Text>
        <Text color={palette.dim}>Start the API first (npm run dev:api), or pass --api &lt;url&gt;. Ctrl+C to quit.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      <Box borderStyle="single" borderColor={palette.border} paddingX={1}>
        <Text color={palette.accent} bold>◆ KriyaDot</Text>
        <Text color={palette.dim}>  {VIEW_TITLES[view]}</Text>
        {bot ? <Text color={palette.dim}>  · {bot.name}</Text> : null}
        <Box flexGrow={1} />
        <Text color={palette.dim}>{themeName} · Ctrl+C quit</Text>
      </Box>

      {view === 'bots' && <BotsView bots={bots} palette={palette} onSelect={selectBot} onBack={() => bot && setView('chat')} />}
      {view === 'chat' && bot && (
        <ChatView
          key={`${bot.id}:${sessionId}`}
          api={api}
          bot={bot}
          palette={palette}
          sessionId={sessionId}
          messages={botMessages}
          setMessages={setBotMessages}
          onCommand={handleChatCommand}
          onTheme={applyTheme}
          jobs={jobManager}
        />
      )}
      {view === 'jobs' && <JobsView jobs={jobManager} palette={palette} />}
      {view === 'chat' && !bot && (
        <Box paddingX={1}><Text color={palette.dim}>No bot selected. Press Esc to open the bot picker.</Text></Box>
      )}
      {view === 'workflows' && <WorkflowsView api={api} palette={palette} />}
      {view === 'activity' && <ActivityView api={api} palette={palette} />}
      {view === 'memory' && bot && <MemoryView api={api} bot={bot} palette={palette} />}
      {view === 'models' && (
        <ModelsView
          api={api}
          palette={palette}
          currentModel={bot?.model}
          onSelect={(m) => {
            switchModel(m);
            setView('chat');
          }}
          onBack={() => setView('chat')}
        />
      )}
    </Box>
  );
}
