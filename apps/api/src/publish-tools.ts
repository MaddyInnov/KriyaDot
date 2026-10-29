// SPDX-License-Identifier: Apache-2.0
// Agent tools for public page publishing (W3).
//
//   publish_page            — publish a collaborative Page at /p/<slug>
//   unpublish_page          — take a page's public link down
//   page_publication_status — read a page's publication state (read-only)
//
// Governance: publishing makes content world-reachable (to anyone with the
// link, subject to how the server is exposed), so publish/unpublish are
// mutating external-facing actions and REQUIRE human approval via
// publishPagePolicyRules() — prepend them to the global policy in index.ts
// (first match wins), next to interconnectionPolicyRules(). The status tool
// is read-only and auto-allowed. "Always allow" remains available through
// the standard approval-card flow, which persists an allow rule per bot.

import type { BotPolicyRule, ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import { PageStore } from './pages.js';
import {
  PagePublicationStore,
  publicPathForSlug,
  publicationStatus,
} from './public-pages.js';

export function publishPagePolicyRules(): BotPolicyRule[] {
  return [
    {
      id: 'publish-page-status-allow',
      toolPattern: '^page_publication_status$',
      effect: 'allow',
      reason: 'Reading a page\'s publication status is read-only observation',
    },
    {
      id: 'publish-page-approval',
      toolPattern: '^publish_page$',
      effect: 'require-approval',
      reason: 'Publishing makes page content public to anyone with the link; needs human approval',
    },
    {
      id: 'unpublish-page-approval',
      toolPattern: '^unpublish_page$',
      effect: 'require-approval',
      reason: 'Unpublishing changes a page\'s public reachability; needs human approval',
    },
  ];
}

export interface PublishToolDeps {
  registry: Map<string, ToolDefinition>;
  dataDir: string;
  /** Optional pre-built stores (tests). */
  pageStore?: PageStore;
  publicationStore?: PagePublicationStore;
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${key}" is required (non-empty string)`);
  return v.trim();
}

function resolvePage(pages: PageStore, ref: string): { id: string; title: string } {
  const byId = pages.get(ref);
  if (byId) return byId;
  // Fall back to an exact (case-insensitive) title match so bots can publish
  // a page they just made by name.
  const matches = pages.list().filter((p) => p.title.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`publish_page: multiple pages titled "${ref}" — use the page id instead`);
  }
  throw new Error(`publish_page: unknown page "${ref}" (no page with that id or title)`);
}

/** Register publish_page / unpublish_page / page_publication_status. */
export function registerPublishTools(deps: PublishToolDeps): void {
  const pages = deps.pageStore ?? new PageStore(deps.dataDir);
  const publications = deps.publicationStore ?? new PagePublicationStore(deps.dataDir);

  const tools: ToolDefinition[] = [
    {
      name: 'publish_page',
      description: [
        'Publish a collaborative Page so anyone with the link can view it',
        '(read-only, no sign-in) at the returned public path. Use it when the',
        'user asks to share/publish a page. The page itself stays editable;',
        'later edits appear at the same link.',
        '',
        'Args:',
        '- page (string, required): the page id, or its exact title.',
        '',
        'Returns { published, pageId, title, slug, path, views } where "path"',
        'is the public URL path (e.g. /p/<slug>) on this KriyaDot server.',
        'Requires human approval (governance policy).',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'Page id, or exact page title' },
        },
        required: ['page'],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
        const page = resolvePage(pages, strArg(args, 'page'));
        const pub = publications.publishPage(page);
        return {
          published: true,
          pageId: page.id,
          title: page.title,
          slug: pub.slug,
          path: publicPathForSlug(pub.slug),
          publishedAt: pub.publishedAt,
          views: pub.views,
        };
      },
    },
    {
      name: 'unpublish_page',
      description: [
        'Take a page\'s public link down. The page itself is not deleted;',
        'the public URL immediately returns 404. Requires human approval.',
        '',
        'Args:',
        '- page (string, required): the page id, or its exact title.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'Page id, or exact page title' },
        },
        required: ['page'],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
        const page = resolvePage(pages, strArg(args, 'page'));
        const removed = publications.unpublishPage(page.id);
        return { published: false, pageId: page.id, title: page.title, wasPublished: removed };
      },
    },
    {
      name: 'page_publication_status',
      description: [
        'Check whether a page is publicly published, and if so its public',
        'path and view count. Read-only.',
        '',
        'Args:',
        '- page (string, required): the page id, or its exact title.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'Page id, or exact page title' },
        },
        required: ['page'],
        additionalProperties: false,
      },
      handler: async (args: Record<string, unknown>, _ctx: ToolContext) => {
        const page = resolvePage(pages, strArg(args, 'page'));
        const status = publicationStatus(publications.getForPage(page.id));
        return { pageId: page.id, title: page.title, ...status };
      },
    },
  ];

  for (const tool of tools) {
    if (!deps.registry.has(tool.name)) {
      deps.registry.set(tool.name, tool);
    }
  }
}
