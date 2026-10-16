// SPDX-License-Identifier: Apache-2.0
'use client';

// Modules hub: lists the KriyaDot modules with live stats. Each card links
// to the module's dedicated web page under /modules/<key>.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { authedFetch } from '../../lib/api';

// Mount point the integrator uses for registerMuseModuleRoutes().
const MODULES_BASE = '/api/modules';

interface ModuleDef {
  key: string;
  name: string;
  blurb: string;
  stat: (o: Overview | null) => string;
}

interface Overview {
  feed: { briefSet: boolean; posts: number };
  reminders: { scheduled: number };
  goals: { active: number; completed: number };
  artifacts: { count: number };
  threads: { count: number };
  ideas: { total: number; active: number };
  calls: { count: number };
  research: { reports: number };
  social: { watchlist: number };
  kb?: { documents: number; corpora: number };
}

const MODULES: ModuleDef[] = [
  {
    key: 'feed',
    name: 'Feed',
    blurb: 'Proactive feed: a stored user brief plus background-generated posts.',
    stat: (o) => (o ? `${o.feed.posts} posts · brief ${o.feed.briefSet ? 'set' : 'not set'}` : '—'),
  },
  {
    key: 'reminders',
    name: 'Reminders',
    blurb: 'User reminders (title, when, channel) with due-checking and cron firing.',
    stat: (o) => (o ? `${o.reminders.scheduled} scheduled` : '—'),
  },
  {
    key: 'goals',
    name: 'Goals',
    blurb: 'User goals with progress tracking and history.',
    stat: (o) => (o ? `${o.goals.active} active · ${o.goals.completed} completed` : '—'),
  },
  {
    key: 'artifacts',
    name: 'Artifacts',
    blurb: 'Durable titled documents with full version history.',
    stat: (o) => (o ? `${o.artifacts.count} artifacts` : '—'),
  },
  {
    key: 'media',
    name: 'Media',
    blurb: 'Image / video / audio generation hooks (mock provider until founder keys).',
    stat: () => 'mock provider',
  },
  {
    key: 'calls',
    name: 'Calls',
    blurb: 'Voice call log. Real telephony is out of scope — simulated records only.',
    stat: (o) => (o ? `${o.calls.count} logged` : '—'),
  },
  {
    key: 'threads',
    name: 'Threads',
    blurb: 'Side chats: separate persistent conversations, independent of main sessions.',
    stat: (o) => (o ? `${o.threads.count} threads` : '—'),
  },
  {
    key: 'research',
    name: 'Research',
    blurb: 'Deep-research agent: plan → gather → synthesize, with cited sources.',
    stat: (o) => (o ? `${o.research.reports} reports` : '—'),
  },
  {
    key: 'browser',
    name: 'Browser',
    blurb: 'Approval-gated web actions: navigate, extract text, screenshot.',
    stat: () => 'approval-gated',
  },
  {
    key: 'ideas',
    name: 'Ideas',
    blurb: 'Idea cards with status tracking: new → active → done / dismissed.',
    stat: (o) => (o ? `${o.ideas.total} total · ${o.ideas.active} active` : '—'),
  },
  {
    key: 'shopping',
    name: 'Shopping',
    blurb: 'Product search plus an approval-gated mock purchase flow.',
    stat: () => 'mock catalog',
  },
  {
    key: 'places',
    name: 'Places',
    blurb: 'Place search with map widget payloads (lat/lng + pins).',
    stat: () => 'mock geo data',
  },
  {
    key: 'social',
    name: 'Social',
    blurb: 'Social listening: keyword watchlist, mock social search, digest.',
    stat: (o) => (o ? `${o.social.watchlist} keywords watched` : '—'),
  },
  {
    key: 'kb',
    name: 'Knowledge Base',
    blurb: 'RAG over your documents — local embeddings, cited answers. Zero API keys.',
    stat: (o) => (o?.kb ? `${o.kb.documents} documents · ${o.kb.corpora} corpora` : '—'),
  },
];

const api = (path: string): Promise<unknown> =>
  authedFetch(path).then(async (res) => {
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`API ${res.status}: ${detail || res.statusText}`);
    }
    return res.json() as Promise<unknown>;
  });

export default function ModulesPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setOverview((await api(`${MODULES_BASE}/overview`)) as Overview);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <div className="row-between">
        <div>
          <h1 className="page-title">Modules</h1>
          <p className="page-sub">
            The 13 KriyaDot modules. Live counts come from the modules API; each card opens the
            module&apos;s dedicated page.
          </p>
        </div>
        <button className="btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}

      <div className="grid-2">
        {MODULES.map((m) => (
          <div className="card" key={m.key}>
            <div className="row-between">
              <strong>{m.name}</strong>
              <span className="small muted">{m.stat(overview)}</span>
            </div>
            <p className="small muted mt">{m.blurb}</p>
            <div className="mt">
              <Link className="btn btn-sm" href={`/modules/${m.key}`}>
                Open {m.name} →
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
