// SPDX-License-Identifier: Apache-2.0
// Interactive API docs (Octop §2.1 deployment polish): an OpenAPI 3.1
// document assembled from a spec registry, plus a single self-contained
// HTML explorer (inline CSS/JS, NO CDN / no external URLs) with try-it
// for GET endpoints.
//
// Parent mounts it in index.ts:
//   import { createApiDocsRouter } from './api-docs.js';
//   app.use('/api', createApiDocsRouter());
// → GET /api/docs.json (OpenAPI) and GET /api/docs (explorer UI).

import express, { type Request, type Response, type Router } from 'express';

export interface ApiSpecEntry {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** OpenAPI path template, e.g. '/api/kb/{id}/search'. */
  path: string;
  summary: string;
  tags: string[];
  detail?: string;
  /** Query parameter names (rendered as optional string params). */
  query?: string[];
  /** When true, the entry documents a JSON request body. */
  requestBody?: boolean;
}

/** Spec registry: main existing route groups at summary level + this workstream's routes in detail. */
export const API_SPEC_REGISTRY: ApiSpecEntry[] = [
  // --- Existing route groups (summary level) ---
  { method: 'get', path: '/api/bots', summary: 'List bots on the roster', tags: ['bots'] },
  { method: 'get', path: '/api/bots/{id}', summary: 'Get one bot', tags: ['bots'] },
  { method: 'post', path: '/api/chat', summary: 'Send a chat turn to a bot', tags: ['chat'], requestBody: true },
  { method: 'get', path: '/api/notes', summary: 'List user notes', tags: ['notes'] },
  { method: 'post', path: '/api/notes', summary: 'Create a note', tags: ['notes'], requestBody: true },
  { method: 'get', path: '/api/notes/search', summary: 'Search notes (knowledge index)', tags: ['notes'], query: ['q'] },
  { method: 'get', path: '/api/workflows', summary: 'List workflows', tags: ['workflows'] },
  { method: 'post', path: '/api/workspace/backup', summary: 'Download a workspace backup zip (secrets excluded)', tags: ['workspace'] },
  { method: 'get', path: '/api/workspace/backups', summary: 'List rollback snapshots', tags: ['workspace'] },
  { method: 'get', path: '/api/tools', summary: 'List registered agent tools', tags: ['tools'] },
  { method: 'get', path: '/api/health', summary: 'Service health', tags: ['system'] },
  { method: 'get', path: '/api/audit', summary: 'Recent governance audit entries', tags: ['system'] },

  // --- Managed knowledge bases (detail) ---
  { method: 'post', path: '/api/kb', summary: 'Create a knowledge base (corpus)', tags: ['kb'], detail: 'Body: { name, description?, maxDocs?, maxBytes?, embeddingProvider?: "local" | "neural" }. Owner = the verified principal (owner token / tenancy JWT / SSO session).', requestBody: true },
  { method: 'get', path: '/api/kb', summary: 'List knowledge bases visible to the actor', tags: ['kb'], detail: 'Includes corpora shared to the actor (user or org) with read/contribute roles.' },
  { method: 'get', path: '/api/kb/search', summary: 'Search across visible knowledge bases with citations', tags: ['kb'], detail: 'Returns { citations: [{ kbId, docId, docTitle, chunkIndex, excerpt, score }] }.', query: ['q', 'kbId', 'topK'] },
  { method: 'get', path: '/api/kb/{id}', summary: 'Get one knowledge base', tags: ['kb'] },
  { method: 'patch', path: '/api/kb/{id}', summary: 'Update a knowledge base (owner only)', tags: ['kb'], detail: 'Patchable: name, description, maxDocs, maxBytes, embeddingProvider.', requestBody: true },
  { method: 'delete', path: '/api/kb/{id}', summary: 'Delete a knowledge base (owner only)', tags: ['kb'] },
  { method: 'post', path: '/api/kb/{id}/folders', summary: 'Add a folder to a knowledge base', tags: ['kb'], detail: 'Requires contribute access. Body: { name, parentId? }.', requestBody: true },
  { method: 'post', path: '/api/kb/{id}/share', summary: 'Share a knowledge base (owner only)', tags: ['kb'], detail: 'Body: { principalType: "user" | "org", principalId, role: "read" | "contribute" }.', requestBody: true },
  { method: 'post', path: '/api/kb/{id}/unshare', summary: 'Revoke a knowledge-base share (owner only)', tags: ['kb'], detail: 'Body: { principalType, principalId }.', requestBody: true },
  { method: 'get', path: '/api/kb/{id}/documents', summary: 'List documents in a knowledge base', tags: ['kb'] },
  { method: 'post', path: '/api/kb/{id}/documents', summary: 'Add a document (contribute; limits enforced)', tags: ['kb'], detail: 'Body: { title, text, fileName?, folderId? }. Original text is retained verbatim; chunks + vectors are indexed with the corpus embedding provider.', requestBody: true },
  { method: 'get', path: '/api/kb/{id}/documents/{docId}', summary: 'Get a document with original + edited text', tags: ['kb'] },
  { method: 'put', path: '/api/kb/{id}/documents/{docId}', summary: 'Edit a document (original retained)', tags: ['kb'], detail: 'Body: { editedText }. Re-indexes chunks from the edited text; byte limit re-checked.', requestBody: true },
  { method: 'delete', path: '/api/kb/{id}/documents/{docId}', summary: 'Delete a document', tags: ['kb'] },
  { method: 'get', path: '/api/kb/{id}/search', summary: 'Search one knowledge base with citations', tags: ['kb'], query: ['q', 'topK'] },

  // --- Storage admin (detail) ---
  { method: 'get', path: '/api/storage', summary: 'List configured workspace backends', tags: ['storage'], detail: 'Each entry: { name, kind, assignedBots } from the WORKSPACE_BACKENDS_JSON registry.' },
  { method: 'get', path: '/api/storage/health', summary: 'Health-probe every workspace backend', tags: ['storage'], detail: 'Runs each backend health() plus an object count when healthy.' },
  { method: 'get', path: '/api/storage/{name}', summary: 'One backend: kind + object count + assigned bots', tags: ['storage'] },
  { method: 'get', path: '/api/storage/{name}/count', summary: 'Object count for one backend', tags: ['storage'] },

  // --- ACME / TLS (detail) ---
  { method: 'get', path: '/.well-known/acme-challenge/{token}', summary: 'ACME http-01 challenge response', tags: ['acme'], detail: 'Served at the app ROOT (not under /api) from the AcmeChallengeStore; returns the key authorization as text/plain. Mount createAcmeChallengeRouter(acmeChallengeStore) before the /api routers.' },

  // --- Docs itself ---
  { method: 'get', path: '/api/docs.json', summary: 'OpenAPI 3.1 document for this API', tags: ['docs'] },
  { method: 'get', path: '/api/docs', summary: 'Interactive API explorer (self-contained HTML)', tags: ['docs'] },
];

export function buildOpenApiDocument(registry: ApiSpecEntry[] = API_SPEC_REGISTRY): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const entry of registry) {
    const pathItem = (paths[entry.path] ??= {});
    const operation: Record<string, unknown> = {
      summary: entry.summary,
      tags: entry.tags,
      responses: {
        '200': { description: 'OK' },
        '400': { description: 'Bad request' },
        '403': { description: 'Forbidden' },
        '404': { description: 'Not found' },
      },
    };
    if (entry.detail) operation.description = entry.detail;
    const params: Array<Record<string, unknown>> = [];
    for (const m of entry.path.matchAll(/\{([^}]+)\}/g)) {
      params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
    }
    for (const q of entry.query ?? []) {
      params.push({ name: q, in: 'query', required: false, schema: { type: 'string' } });
    }
    if (params.length > 0) operation.parameters = params;
    if (entry.requestBody) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } },
      };
    }
    pathItem[entry.method] = operation;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'KriyaDot API',
      version: '0.1.0',
      description: 'Local-first AI agent platform API. Interactive explorer at /api/docs.',
    },
    paths,
  };
}

const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KriyaDot API Docs</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a2e; background: #fafafa; }
  h1 { font-size: 1.4rem; }
  input[type=search] { width: 100%; padding: 0.5rem; margin: 1rem 0; border: 1px solid #ccc; border-radius: 6px; }
  .ep { background: #fff; border: 1px solid #e2e2e2; border-radius: 8px; padding: 0.75rem 1rem; margin: 0.5rem 0; }
  .method { font-weight: 700; text-transform: uppercase; font-size: 0.8rem; padding: 0.15rem 0.45rem; border-radius: 4px; background: #e8eaf6; }
  .get { background: #e0f2e9; } .post { background: #fff3d6; } .delete { background: #fde0e0; }
  .path { font-family: ui-monospace, monospace; }
  .detail { color: #555; font-size: 0.9rem; margin-top: 0.35rem; white-space: pre-wrap; }
  button { margin-left: 0.5rem; cursor: pointer; }
  pre { background: #11131a; color: #d6e2ff; padding: 0.75rem; border-radius: 6px; overflow: auto; max-height: 300px; }
</style>
</head>
<body>
<h1>KriyaDot API</h1>
<p>OpenAPI 3.1: <a href="docs.json">docs.json</a>. GET endpoints have a live try-it.</p>
<input type="search" id="filter" placeholder="Filter endpoints...">
<div id="list">Loading...</div>
<script>
async function main() {
  const res = await fetch('docs.json');
  const spec = await res.json();
  const list = document.getElementById('list');
  const entries = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) entries.push({ path, method, op });
  }
  function render(filter) {
    list.innerHTML = '';
    for (const { path, method, op } of entries) {
      const hay = (method + ' ' + path + ' ' + (op.summary || '')).toLowerCase();
      if (filter && !hay.includes(filter)) continue;
      const div = document.createElement('div');
      div.className = 'ep';
      const head = document.createElement('div');
      const m = document.createElement('span'); m.className = 'method ' + method; m.textContent = method;
      const p = document.createElement('span'); p.className = 'path'; p.textContent = ' ' + path + ' ';
      const s = document.createElement('span'); s.textContent = op.summary || '';
      head.append(m, p, s);
      div.append(head);
      if (op.description) { const d = document.createElement('div'); d.className = 'detail'; d.textContent = op.description; div.append(d); }
      if (method === 'get' && !path.includes('{')) {
        const btn = document.createElement('button'); btn.textContent = 'Try it';
        btn.onclick = async () => {
          const out = document.createElement('pre');
          out.textContent = 'Loading...';
          div.append(out);
          try {
            const r = await fetch(path);
            out.textContent = (await r.text()).slice(0, 4000);
          } catch (e) { out.textContent = String(e); }
        };
        head.append(btn);
      }
      list.append(div);
    }
    if (!list.children.length) list.textContent = 'No endpoints match.';
  }
  render('');
  document.getElementById('filter').addEventListener('input', (e) => render(e.target.value.toLowerCase()));
}
main();
</script>
</body>
</html>
`;

export function createApiDocsRouter(registry: ApiSpecEntry[] = API_SPEC_REGISTRY): Router {
  const router = express.Router();
  router.get('/docs.json', (_req: Request, res: Response) => {
    res.json(buildOpenApiDocument(registry));
  });
  router.get('/docs', (_req: Request, res: Response) => {
    res.type('text/html').send(DOCS_HTML);
  });
  return router;
}
