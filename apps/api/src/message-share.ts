// SPDX-License-Identifier: Apache-2.0
// Per-message share action (Muse parity §4.5 C-12).
//
// Session share (session-share.ts) publishes a WHOLE transcript. C-12
// is the per-message action: share ONE message as a public link (via
// the same PagePublicationStore, so links get the same sanitized,
// CSP'd serving) or export it as text / markdown / JSON. Tool and
// system messages are not shareable — a share is a user/assistant
// utterance, not an internal trace.

import express, { type Router } from 'express';
import type { IdentifiedMessage } from '@mvp/agent-runtime';
import { PagePublicationStore, publicPathForSlug } from './public-pages.js';

export interface MessageShareDeps {
  dataDir: string;
  listThreadMessages: (sessionId: string) => IdentifiedMessage[];
}

export function isShareableMessage(m: IdentifiedMessage): boolean {
  return (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0;
}

/** Render one message as standalone markdown for link/export sharing. */
export function renderMessageMarkdown(m: IdentifiedMessage, sessionId: string): string {
  const who = m.role === 'user' ? 'User' : 'Assistant';
  return [`# Shared message`, '', `**${who}** · session \`${sessionId.slice(0, 12)}\` · ${m.ts}`, '', m.content, ''].join('\n');
}

/** Plain-text export shape (what the web "Copy / Share as text" uses). */
export function renderMessageText(m: IdentifiedMessage): string {
  return m.content;
}

export function createMessageShareRouter(deps: MessageShareDeps): Router {
  const router = express.Router({ mergeParams: true });
  const find = (sessionId: string, messageId: string): IdentifiedMessage | null => {
    const id = Number(messageId);
    if (!Number.isFinite(id)) return null;
    return deps.listThreadMessages(sessionId).find((m) => m.id === id) ?? null;
  };

  // POST /sessions/:sessionId/messages/:messageId/share → public link
  router.post('/sessions/:sessionId/messages/:messageId/share', (req, res) => {
    const m = find(req.params.sessionId, req.params.messageId);
    if (!m) { res.status(404).json({ ok: false, error: 'message not found' }); return; }
    if (!isShareableMessage(m)) { res.status(422).json({ ok: false, error: 'only user/assistant messages can be shared' }); return; }
    try {
      const store = new PagePublicationStore(deps.dataDir);
      const pub = store.publishArtifact({
        title: `Message from session ${req.params.sessionId.slice(0, 12)}`,
        content: renderMessageMarkdown(m, req.params.sessionId),
        contentKind: 'markdown',
      });
      res.status(201).json({ ok: true, slug: pub.slug, path: publicPathForSlug(pub.slug), messageId: m.id });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'share failed' });
    }
  });

  // GET /sessions/:sessionId/messages/:messageId/export?format=text|markdown|json
  router.get('/sessions/:sessionId/messages/:messageId/export', (req, res) => {
    const m = find(req.params.sessionId, req.params.messageId);
    if (!m) { res.status(404).json({ ok: false, error: 'message not found' }); return; }
    if (!isShareableMessage(m)) { res.status(422).json({ ok: false, error: 'only user/assistant messages can be exported' }); return; }
    const format = typeof req.query.format === 'string' ? req.query.format : 'text';
    const stem = `message-${req.params.sessionId.slice(0, 8)}-${m.id}`;
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${stem}.json"`);
      res.send(JSON.stringify({ sessionId: req.params.sessionId, messageId: m.id, role: m.role, ts: m.ts, content: m.content }, null, 2));
      return;
    }
    if (format === 'markdown') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${stem}.md"`);
      res.send(renderMessageMarkdown(m, req.params.sessionId));
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}.txt"`);
    res.send(renderMessageText(m));
  });

  return router;
}
