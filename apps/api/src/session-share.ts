// SPDX-License-Identifier: Apache-2.0
/**
 * Session share links + export, and background-run management routes
 * (Octomind parity).
 *
 * Share: render a thread transcript to markdown and publish it as a
 * standalone artifact on the public-pages infra — the public URL is
 * /p/<slug>, served sanitized + CSP'd by that module. Export: the same
 * transcript as a file download (markdown or JSON). Background runs:
 * list + stop for the runtime's background specialist runs.
 */

import type { Router } from 'express';
import type { AgentRuntime } from '@mvp/agent-runtime';
import { PagePublicationStore, publicPathForSlug } from './public-pages.js';

export interface SessionShareDeps {
  agentRuntime: AgentRuntime;
  dataDir: string;
}

function errorBody(error: string): { error: string } {
  return { error };
}

/** Render a session's transcript as markdown. Null when it has no messages. */
export function renderTranscriptMarkdown(
  agentRuntime: AgentRuntime,
  sessionId: string,
): { title: string; markdown: string; count: number } | null {
  const messages = agentRuntime.listThreadMessages(sessionId);
  if (messages.length === 0) return null;
  const botId = agentRuntime.getSessionBotId(sessionId);
  const title = `Session ${sessionId.slice(0, 12)}${botId ? ` · ${botId}` : ''}`;
  const lines = [`# ${title}`, ''];
  for (const m of messages) {
    const who =
      m.role === 'user'
        ? 'User'
        : m.role === 'assistant'
          ? 'Assistant'
          : m.role === 'tool'
            ? `Tool (${m.toolName ?? 'tool'})`
            : 'System';
    lines.push(`**${who}:**`, '', typeof m.content === 'string' ? m.content : JSON.stringify(m.content), '');
    if (m.toolCalls && m.toolCalls.length > 0) {
      lines.push(`_Tool calls: ${m.toolCalls.map((c) => c.name).join(', ')}_`, '');
    }
  }
  return { title, markdown: lines.join('\n'), count: messages.length };
}

export function registerSessionShareRoutes(router: Router, deps: SessionShareDeps): void {
  const { agentRuntime } = deps;

  router.post('/sessions/:id/share', (req, res) => {
    try {
      const rendered = renderTranscriptMarkdown(agentRuntime, req.params.id);
      if (!rendered) {
        res.status(404).json(errorBody(`No messages in session "${req.params.id}"`));
        return;
      }
      const store = new PagePublicationStore(deps.dataDir);
      const pub = store.publishArtifact({
        title: rendered.title,
        content: rendered.markdown,
        contentKind: 'markdown',
      });
      res.status(201).json({
        slug: pub.slug,
        path: publicPathForSlug(pub.slug),
        title: pub.title,
        messages: rendered.count,
      });
    } catch (err) {
      res.status(500).json(errorBody(err instanceof Error ? err.message : 'Failed to share session'));
    }
  });

  router.get('/sessions/:id/export', (req, res) => {
    const rendered = renderTranscriptMarkdown(agentRuntime, req.params.id);
    if (!rendered) {
      res.status(404).json(errorBody(`No messages in session "${req.params.id}"`));
      return;
    }
    if (req.query.format === 'json') {
      const messages = agentRuntime.listThreadMessages(req.params.id);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="session-${req.params.id.slice(0, 12)}.json"`,
      );
      res.send(
        JSON.stringify(
          { sessionId: req.params.id, exportedAt: new Date().toISOString(), messages },
          null,
          2,
        ),
      );
      return;
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="session-${req.params.id.slice(0, 12)}.md"`,
    );
    res.send(rendered.markdown);
  });
}

export function registerBackgroundRunRoutes(router: Router, deps: SessionShareDeps): void {
  const { agentRuntime } = deps;

  router.get('/background-runs', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const botId = typeof req.query.botId === 'string' ? req.query.botId : undefined;
    const runs = agentRuntime.backgroundRuns.list({
      ...(sessionId ? { originSessionId: sessionId } : {}),
      ...(botId ? { originBotId: botId } : {}),
    });
    res.json({ runs });
  });

  router.post('/background-runs/:id/stop', (req, res) => {
    const stopped = agentRuntime.backgroundRuns.stop(req.params.id);
    if (!stopped) {
      res.status(404).json(errorBody(`No running background run "${req.params.id}"`));
      return;
    }
    res.json({ stopped: true, id: req.params.id });
  });
}
