// SPDX-License-Identifier: Apache-2.0
// Shared SQLite backing store for the Muse-parity modules.
//
// Design decision (documented per the workstream brief): all 13 modules share
// ONE sqlite file, `<dataDir>/muse-modules.db`, with namespaced tables
// (`mm_<module>_*`). Rationale: a single file is easier to back up / move
// between environments than 13 files, and table-name namespacing keeps module
// bookkeeping from colliding. Every module store takes a ModuleDb instance,
// so tests can inject `:memory:` for full isolation.
//
// Follows the node:sqlite loading pattern from agent-runtime's
// subagent-store.ts (vitest's Vite pipeline cannot statically resolve the
// `node:sqlite` specifier, so it is loaded at runtime).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { openDb } from '@mvp/agent-runtime';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mm_feed_brief (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  brief TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mm_feed_posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_note TEXT,
  dismissed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_feed_posts_created ON mm_feed_posts (created_at DESC);

CREATE TABLE IF NOT EXISTS mm_reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  when_ts INTEGER NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  fired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_reminders_status_when ON mm_reminders (status, when_ts);

CREATE TABLE IF NOT EXISTS mm_goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mm_goal_progress (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  pct INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_goal_progress_goal ON mm_goal_progress (goal_id, created_at);

CREATE TABLE IF NOT EXISTS mm_artifacts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mm_artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (artifact_id, version)
);
CREATE INDEX IF NOT EXISTS idx_mm_artifact_versions_artifact ON mm_artifact_versions (artifact_id, version);

CREATE TABLE IF NOT EXISTS mm_calls (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  peer TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_sec INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  recording_ref TEXT,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_calls_started ON mm_calls (started_at DESC);

CREATE TABLE IF NOT EXISTS mm_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mm_thread_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_thread_messages_thread ON mm_thread_messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS mm_research_reports (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  report_md TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mm_browser_approvals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mm_browser_approvals_status ON mm_browser_approvals (status, created_at);

CREATE TABLE IF NOT EXISTS mm_ideas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_ideas_status ON mm_ideas (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS mm_carts (
  id TEXT PRIMARY KEY,
  items_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mm_orders (
  id TEXT PRIMARY KEY,
  items_json TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  approval_code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_orders_status ON mm_orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS mm_social_watchlist (
  id TEXT PRIMARY KEY,
  keyword TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mm_meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  page_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_meetings_created ON mm_meetings (created_at DESC);

CREATE TABLE IF NOT EXISTS mm_slide_decks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slides_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mm_kb_corpora (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mm_kb_documents (
  id TEXT PRIMARY KEY,
  corpus_id TEXT,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  char_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_kb_documents_corpus ON mm_kb_documents (corpus_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mm_kb_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  page INTEGER,
  embedding TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_kb_chunks_doc ON mm_kb_chunks (document_id, idx);
-- Lexical leg of KB hybrid search: FTS5/BM25 over chunk text + document
-- title. Synced manually in KnowledgeBaseStore.addDocument/deleteDocument/
-- deleteCorpus (chunk ids are TEXT primary keys, so the external-content
-- trigger pattern does not apply).
CREATE VIRTUAL TABLE IF NOT EXISTS mm_kb_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  corpus_id UNINDEXED,
  title,
  text
);

-- Goal milestones (P3-E): ordered checklist items inside a goal. Completing
-- every milestone auto-completes the goal.
CREATE TABLE IF NOT EXISTS mm_goal_milestones (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mm_goal_milestones_goal ON mm_goal_milestones (goal_id, position);

-- Commitments (P3-E): explicit "I will do X by Y" tracking with outcomes.
CREATE TABLE IF NOT EXISTS mm_commitments (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  due_at INTEGER,
  goal_id TEXT,
  reminder_id TEXT,
  status TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mm_commitments_status_due ON mm_commitments (status, due_at);

-- Watchers (P3-E): edge-triggered condition watchers. The host evaluates a
-- watcher (cron trigger muse-watcher:<id>, like reminders) and calls
-- evaluateWatcher(); an event is recorded only on a false→true transition.
CREATE TABLE IF NOT EXISTS mm_watchers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cron TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_condition INTEGER,
  last_checked_at INTEGER,
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mm_watcher_events (
  id TEXT PRIMARY KEY,
  watcher_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mm_watcher_events_watcher ON mm_watcher_events (watcher_id, created_at DESC);
`;

/**
 * Shared database handle for all Muse-parity modules. Opens (creating)
 * `<dbPath>` — normally `<dataDir>/muse-modules.db` — and ensures every
 * module table exists. Pass `':memory:'` in tests for isolation.
 */
export class ModuleDb {
  readonly db: DatabaseSyncType;
  readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath;
    this.db = openDb(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }
}
