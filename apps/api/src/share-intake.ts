// SPDX-License-Identifier: Apache-2.0
// OS share-target intake (Muse parity §4.5 C-11) — PWA share target first.
//
// The web app manifest declares a `share_target` pointing at GET
// /share-target (web page), which forwards the shared {title, text, url}
// here. This module is the durable intake: every share lands in
// <dataDir>/share-intake.db as a pending item the chat composer can pick
// up ("Shared to KriyaDot"), instead of evaporating in a query string.
// A POST form variant is provided for platforms that POST shares.
//
// Native share extensions (iOS Share Extension / Android App Links
// intents) post to the same POST route with the same fields — the
// intake contract is platform-neutral on purpose.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Router } from 'express';
import { openDb } from '@mvp/agent-runtime';

export interface SharePayload {
  title?: string;
  text?: string;
  url?: string;
}
export interface ShareIntakeItem extends Required<SharePayload> {
  id: string;
  source: string;
  receivedAt: string;
  consumedAt: string | null;
}

const LIMITS = { title: 300, text: 8000, url: 2000 };

/** Normalize + cap a raw share payload. Returns null when it carries nothing. */
export function normalizeSharePayload(raw: SharePayload, source = 'pwa-share-target'): ShareIntakeItem | null {
  const title = String(raw.title ?? '').trim().slice(0, LIMITS.title);
  const text = String(raw.text ?? '').trim().slice(0, LIMITS.text);
  let url = String(raw.url ?? '').trim().slice(0, LIMITS.url);
  // Android shares often put the URL inside `text`; lift it out so the
  // composer can render a link card instead of a wall of text.
  if (!url) {
    const m = text.match(/https?:\/\/[^\s]+/);
    if (m) url = m[0];
  }
  if (url && !/^https?:\/\//i.test(url)) url = ''; // only web URLs are linkable
  if (!title && !text && !url) return null;
  return {
    id: `share_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title, text, url, source, receivedAt: new Date().toISOString(), consumedAt: null,
  };
}

/** The manifest fragment the host merges into public/manifest.json (C-11). */
export function shareTargetManifest(): Record<string, unknown> {
  return {
    share_target: {
      action: '/share-target',
      method: 'GET',
      enctype: 'application/x-www-form-urlencoded',
      params: { title: 'title', text: 'text', url: 'url' },
    },
  };
}

interface Row { id: string; title: string; text: string; url: string; source: string; received_at: string; consumed_at: string | null }

export class ShareIntakeStore {
  private readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openDb(join(dataDir, 'share-intake.db'));
    this.db.exec(`CREATE TABLE IF NOT EXISTS share_intake (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL, url TEXT NOT NULL,
      source TEXT NOT NULL, received_at TEXT NOT NULL, consumed_at TEXT);`);
  }
  add(item: ShareIntakeItem): ShareIntakeItem {
    this.db.prepare(`INSERT INTO share_intake (id, title, text, url, source, received_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`)
      .run(item.id, item.title, item.text, item.url, item.source, item.receivedAt);
    return item;
  }
  list(limit = 50, unconsumedOnly = false): ShareIntakeItem[] {
    const rows = (unconsumedOnly
      ? this.db.prepare(`SELECT * FROM share_intake WHERE consumed_at IS NULL ORDER BY received_at DESC LIMIT ?`).all(limit)
      : this.db.prepare(`SELECT * FROM share_intake ORDER BY received_at DESC LIMIT ?`).all(limit)) as unknown as Row[];
    return rows.map((r) => ({ id: r.id, title: r.title, text: r.text, url: r.url, source: r.source, receivedAt: r.received_at, consumedAt: r.consumed_at }));
  }
  consume(id: string): boolean {
    const r = this.db.prepare(`UPDATE share_intake SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`).run(new Date().toISOString(), id);
    return r.changes > 0;
  }
  close(): void { this.db.close(); }
}

export function createShareIntakeRouter(deps: { store: ShareIntakeStore }): Router {
  const router = express.Router();
  const intake = (raw: SharePayload, source: string, res: express.Response) => {
    const item = normalizeSharePayload(raw, source);
    if (!item) { res.status(400).json({ ok: false, error: 'share payload is empty (title, text or url required)' }); return; }
    deps.store.add(item);
    res.status(201).json({ ok: true, item });
  };
  // PWA share target posts (form-encoded or JSON) and native extensions.
  router.post('/share-target', (req, res) => {
    const b = (req.body ?? {}) as SharePayload;
    intake(b, typeof (req.body as { source?: unknown })?.source === 'string' ? String((req.body as { source: string }).source) : 'pwa-share-target', res);
  });
  router.get('/share-target/recent', (req, res) => {
    res.json({ ok: true, items: deps.store.list(50, req.query.unconsumed === '1') });
  });
  router.post('/share-target/:id/consume', (req, res) => {
    if (!deps.store.consume(req.params.id)) { res.status(404).json({ ok: false, error: 'unknown or already-consumed share' }); return; }
    res.json({ ok: true });
  });
  return router;
}
