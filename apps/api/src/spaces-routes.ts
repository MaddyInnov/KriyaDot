// SPDX-License-Identifier: Apache-2.0
// HTTP routes for Spaces (user-level contexts: Work/Personal, ...).
//
//   GET    /                        → { ok, spaces }
//   POST   /                        → { name } → { ok, space } (201)
//   PATCH  /:id                     → { name?, modelOverride?, apiKeyRef?,
//                                       workspaceOverride?, paused? } → { ok, space }
//   DELETE /:id                     → { ok, deleted }
//
// apiKeyRef is returned exactly as stored: a vault secret NAME (reference
// id). Raw key values are never stored in the space record and never appear
// in any response.
//
// The chat route uses resolveSpaceForRun() to turn an incoming space
// selector (X-Sarviq-Space header or `spaceId` body field) into a
// per-run context: paused spaces reject with 423, and a space's apiKeyRef
// is resolved server-side to a memory-only key value for the turn.

import express, { type Request, type Response, type Router } from 'express';
import { SecureVault } from '@mvp/vault';
import {
  DEFAULT_SPACE_ID,
  SpaceError,
  type Space,
  type SpaceStore,
} from '@mvp/agent-runtime';

export interface SpaceRouteDeps {
  spaceStore: SpaceStore;
  dataDir: string;
}

function errorBody(message: string, detail?: string): Record<string, unknown> {
  return { ok: false, error: message, ...(detail ? { detail } : {}) };
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

function spaceErrorStatus(err: unknown): number {
  if (err instanceof SpaceError) {
    return err.code === 'not-found' ? 404 : 400;
  }
  return 500;
}

export function registerSpaceRoutes(router: Router, deps: SpaceRouteDeps): void {
  const { spaceStore } = deps;

  router.get('/', (_req: Request, res: Response) => {
    res.json({ ok: true, spaces: spaceStore.listSpaces() });
  });

  router.post('/', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { name?: unknown };
    try {
      const space = spaceStore.createSpace(typeof body.name === 'string' ? body.name : '');
      res.status(201).json({ ok: true, space });
    } catch (err) {
      res
        .status(spaceErrorStatus(err))
        .json(errorBody(err instanceof Error ? err.message : 'Failed to create space'));
    }
  });

  router.patch('/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid space id'));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of ['name', 'modelOverride', 'apiKeyRef', 'workspaceOverride', 'paused'] as const) {
      if (key in body) patch[key] = body[key];
    }
    try {
      const space = spaceStore.updateSpace(id, {
        name: patch.name as string | null | undefined,
        modelOverride: patch.modelOverride as string | null | undefined,
        apiKeyRef: patch.apiKeyRef as string | null | undefined,
        workspaceOverride: patch.workspaceOverride as string | null | undefined,
        paused: patch.paused as boolean | undefined,
      });
      res.json({ ok: true, space });
    } catch (err) {
      res
        .status(spaceErrorStatus(err))
        .json(errorBody(err instanceof Error ? err.message : 'Failed to update space'));
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    if (!validId(id)) {
      res.status(400).json(errorBody('Invalid space id'));
      return;
    }
    try {
      if (!spaceStore.deleteSpace(id)) {
        res.status(404).json(errorBody(`Unknown space "${id}"`));
        return;
      }
      res.json({ ok: true, deleted: id });
    } catch (err) {
      res
        .status(spaceErrorStatus(err))
        .json(errorBody(err instanceof Error ? err.message : 'Failed to delete space'));
    }
  });
}

/** HTTP-mapped error thrown by resolveSpaceForRun(). */
export class SpaceHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SpaceHttpError';
    this.status = status;
  }
}

export interface SpaceRunContext {
  space: Space;
  /**
   * Raw key value resolved from the space's apiKeyRef. Memory-only for the
   * duration of the run — never persisted, logged, or serialized.
   */
  apiKeyOverride?: string;
}

function callerOf(req: Request): string {
  const header = req.header('x-user-id');
  return typeof header === 'string' && header.length > 0 ? header : 'default-user';
}

/**
 * Resolve the active space for a chat run from the `X-Sarviq-Space` header
 * or a `spaceId` body field. Returns undefined when no space is selected.
 *
 * - Unknown space → 404.
 * - Paused space → 423 (runs are rejected while paused).
 * - apiKeyRef set → the referenced vault secret is resolved server-side;
 *   missing secret → 400. Only the reference id lives in the space record;
 *   the resolved value is returned here for in-memory use by the turn only.
 */
export function resolveSpaceForRun(opts: {
  req: Request;
  spaceStore: SpaceStore;
  dataDir: string;
  spaceId?: string;
}): SpaceRunContext | undefined {
  const { req, spaceStore, dataDir, spaceId } = opts;
  const header = req.header('x-sarviq-space');
  const selector =
    (typeof spaceId === 'string' && spaceId.trim()) ||
    (typeof header === 'string' && header.trim()) ||
    '';
  if (!selector) return undefined;

  const space = spaceStore.resolveSpace(selector);
  if (!space) {
    throw new SpaceHttpError(404, `Unknown space "${selector}"`);
  }
  if (space.paused) {
    throw new SpaceHttpError(
      423,
      `Space "${space.name}" is paused — resume it before starting new runs`,
    );
  }
  let apiKeyOverride: string | undefined;
  if (space.apiKeyRef) {
    // The vault is per-user, namespaced like the /vault API routes.
    const vault = new SecureVault(dataDir, callerOf(req), callerOf(req));
    const secret = vault.get(space.apiKeyRef);
    if (!secret) {
      throw new SpaceHttpError(
        400,
        `Space "${space.name}" references vault secret "${space.apiKeyRef}", which does not exist`,
      );
    }
    apiKeyOverride = secret.value;
  }
  return { space, apiKeyOverride };
}

export { DEFAULT_SPACE_ID };
