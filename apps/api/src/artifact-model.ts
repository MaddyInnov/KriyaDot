// SPDX-License-Identifier: Apache-2.0
// CA-32: Artifact model-call runtime (closes the Mu FL-5 remainder).
//
// Hosted pages/artifacts may ask the HOST to make a model call on their
// behalf. The artifact never holds a key and never talks to a provider:
//   browser artifact → POST /api/artifacts/model-call { slug, prompt }
//   → this broker checks the publication exists, enforces the per-user
//     spend cap through the existing billing CostTracker / spend-cap
//     check (injected), resolves the per-user provider key from the
//     vault (injected resolver — the key value never leaves this module
//     and is never returned or logged), calls the injected provider,
//     records the cost, and audit-logs the call.
//
// All collaborators are injected, so tests run with a mock provider,
// a fake vault and an in-memory cap check — zero paid calls.

import { Router } from 'express';
import type { Request, Response } from 'express';

export interface ArtifactModelCallInput {
  slug: string;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
}

export interface ArtifactModelProviderResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface ArtifactModelDeps {
  /** Resolve a publication slug → { slug, title } or undefined. Host binds PagePublicationStore. */
  findPublication: (slug: string) => { slug: string; title: string } | undefined;
  /** Per-user key from the vault. Returns the key VALUE for the provider call only. */
  resolveProviderKey: (userId: string) => Promise<string | undefined> | string | undefined;
  /** Provider call. Host binds its provider factory; tests inject a mock. */
  callProvider: (input: { apiKey: string | undefined; prompt: string; system?: string; maxOutputTokens: number }) => Promise<ArtifactModelProviderResult>;
  /** Spend-cap check against the existing cost tracker. Return allowed=false to block (fail-closed on throw). */
  checkCap: (input: { userId: string; slug: string; estimatedCostCents: number }) => Promise<{ allowed: boolean; message?: string }> | { allowed: boolean; message?: string };
  /** Record actual spend in the existing cost tracker. */
  recordCost?: (input: { userId: string; slug: string; model: string; inputTokens: number; outputTokens: number; costCents: number }) => void;
  audit?: (action: string, fields: Record<string, unknown>) => void;
  /** Rough pre-call estimate used for the cap check. Default 5 cents. */
  estimateCostCents?: number;
  maxPromptChars?: number;
}

export class ArtifactModelError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = 'ArtifactModelError'; this.status = status; }
}

export async function artifactModelCall(
  input: ArtifactModelCallInput,
  deps: ArtifactModelDeps,
  ctx: { userId: string },
): Promise<ArtifactModelProviderResult & { slug: string }> {
  const maxPrompt = deps.maxPromptChars ?? 8000;
  if (!input || typeof input.slug !== 'string' || !input.slug) throw new ArtifactModelError(400, 'slug is required');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new ArtifactModelError(400, 'prompt is required');
  if (input.prompt.length > maxPrompt) throw new ArtifactModelError(413, `prompt exceeds ${maxPrompt} chars`);
  const pub = deps.findPublication(input.slug);
  if (!pub) throw new ArtifactModelError(404, 'unknown artifact/publication slug');

  // Spend cap first — fail closed if the check itself errors.
  let cap: { allowed: boolean; message?: string };
  try {
    cap = await deps.checkCap({ userId: ctx.userId, slug: input.slug, estimatedCostCents: deps.estimateCostCents ?? 5 });
  } catch (err) {
    deps.audit?.('artifact.model-call.cap-error', { slug: input.slug, userId: ctx.userId });
    throw new ArtifactModelError(503, `spend-cap check failed (${err instanceof Error ? err.message : String(err)}); blocking fail-closed`);
  }
  if (!cap.allowed) {
    deps.audit?.('artifact.model-call.cap-denied', { slug: input.slug, userId: ctx.userId });
    throw new ArtifactModelError(402, cap.message ?? 'spend cap exceeded for artifact model calls');
  }

  const apiKey = await deps.resolveProviderKey(ctx.userId);
  const result = await deps.callProvider({
    apiKey,
    prompt: input.prompt,
    system: typeof input.system === 'string' ? input.system.slice(0, 2000) : undefined,
    maxOutputTokens: Math.min(Math.max(1, input.maxOutputTokens ?? 512), 4096),
  });
  deps.recordCost?.({
    userId: ctx.userId, slug: input.slug, model: result.model,
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, costCents: result.costCents,
  });
  // Audit carries metadata only — never the key, never the full prompt.
  deps.audit?.('artifact.model-call', {
    slug: input.slug, userId: ctx.userId, model: result.model,
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, costCents: result.costCents,
    keyConfigured: Boolean(apiKey),
  });
  return { ...result, slug: input.slug };
}

/**
 * Client-side bridge snippet injected into (or linked from) a hosted
 * artifact. It exposes `window.kriyadotModel(prompt)` which calls the
 * host broker — the artifact itself holds no credentials.
 */
export function artifactModelBridgeScript(slug: string): string {
  const safeSlug = JSON.stringify(slug);
  return [
    '<script>',
    'window.kriyadotModel = async function(prompt, opts) {',
    '  const res = await fetch("/api/artifacts/model-call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: ' + safeSlug + ', prompt: String(prompt), system: opts && opts.system, maxOutputTokens: opts && opts.maxOutputTokens }) });',
    '  if (!res.ok) { const b = await res.json().catch(function(){ return {}; }); throw new Error(b.error || ("model call failed (" + res.status + ")")); }',
    '  const data = await res.json(); return data.text;',
    '};',
    '</script>',
  ].join('\n');
}

/** Register-style routes. Mount: app.use('/api/artifacts', r) with registerArtifactModelRoutes(r, deps, getUserId). */
export function registerArtifactModelRoutes(
  router: Router,
  deps: ArtifactModelDeps,
  getUserId: (req: Request) => string,
): void {
  router.post('/model-call', async (req: Request, res: Response) => {
    try {
      const result = await artifactModelCall(req.body as ArtifactModelCallInput, deps, { userId: getUserId(req) });
      res.status(200).json({ ok: true, text: result.text, model: result.model, costCents: result.costCents, slug: result.slug });
    } catch (err) {
      if (err instanceof ArtifactModelError) { res.status(err.status).json({ error: err.message }); return; }
      res.status(500).json({ error: err instanceof Error ? err.message : 'artifact model call failed' });
    }
  });
  router.get('/:slug/bridge.js', (req: Request, res: Response) => {
    if (!deps.findPublication(req.params.slug)) { res.status(404).type('text/plain').send('unknown artifact'); return; }
    res.status(200).type('application/javascript').send(artifactModelBridgeScript(req.params.slug).replace(/<\/?script>/g, ''));
  });
}
