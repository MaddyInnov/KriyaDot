// SPDX-License-Identifier: Apache-2.0
// White-label branding (enterprise pack).
//
// Brand config is deployment-global, stored at <dataDir>/brand.json:
//   { name, tagline, logoDataUrl | logoUrl, primaryColor }
// GET /brand is public-ish (the web shell needs it before login); PUT /brand
// is admin-gated: the caller (x-user-id) must be owner/admin in SOME org of
// this deployment, or hold the loopback bearer (req.loopbackAuthed).
//
// HOST WIRING (index.ts):
//   import { createBrandRouter } from './brand.js';
//   app.use('/api/brand', createBrandRouter({ dataDir: config.dataDir, tenancyDbPath: join(config.dataDir, 'tenancy.db') }));
// The web side mounts apps/web/components/brand-provider.tsx near the root.

import fs from 'node:fs';
import { join } from 'node:path';
import express, { type Router } from 'express';
import { TenantStore, canAct } from '@mvp/tenancy';

export interface BrandConfig {
  name: string;
  tagline: string;
  logoDataUrl?: string;
  logoUrl?: string;
  /** CSS hex color, e.g. #6d3fc4. */
  primaryColor: string;
  updatedAt: number;
  updatedBy?: string;
}

export const DEFAULT_BRAND: Omit<BrandConfig, 'updatedAt'> = {
  name: 'KriyaDot',
  tagline: 'Your all-in-one AI agent',
  primaryColor: '#6d3fc4',
};

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export class BrandStore {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = join(dataDir, 'brand.json');
  }

  get(): BrandConfig {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<BrandConfig>;
      return { ...DEFAULT_BRAND, ...parsed, updatedAt: parsed.updatedAt ?? 0 };
    } catch {
      return { ...DEFAULT_BRAND, updatedAt: 0 };
    }
  }

  set(input: Partial<BrandConfig>, updatedBy: string): BrandConfig {
    const next: BrandConfig = { ...this.get(), updatedAt: Date.now(), updatedBy };
    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('brand name must be 1-80 chars');
      next.name = input.name.trim();
    }
    if (input.tagline !== undefined) {
      if (typeof input.tagline !== 'string' || input.tagline.length > 160) throw new Error('brand tagline must be a string (max 160 chars)');
      next.tagline = input.tagline;
    }
    if (input.primaryColor !== undefined) {
      if (typeof input.primaryColor !== 'string' || !COLOR_RE.test(input.primaryColor)) throw new Error('primaryColor must be a #rrggbb hex color');
      next.primaryColor = input.primaryColor;
    }
    if (input.logoDataUrl !== undefined) {
      if (input.logoDataUrl !== null && (typeof input.logoDataUrl !== 'string' || !input.logoDataUrl.startsWith('data:image/') || input.logoDataUrl.length > 700_000)) {
        throw new Error('logoDataUrl must be a data:image/ URL (max ~700k chars)');
      }
      if (input.logoDataUrl) next.logoDataUrl = input.logoDataUrl;
      else delete next.logoDataUrl;
    }
    if (input.logoUrl !== undefined) {
      if (input.logoUrl !== null && (typeof input.logoUrl !== 'string' || !/^https?:\/\//.test(input.logoUrl))) throw new Error('logoUrl must be http(s)');
      if (input.logoUrl) next.logoUrl = input.logoUrl;
      else delete next.logoUrl;
    }
    fs.mkdirSync(join(this.file, '..'), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }
}

export interface BrandDeps {
  dataDir: string;
  tenancyDbPath?: string;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function callerOf(req: express.Request): string {
  const h = req.header('x-user-id');
  return typeof h === 'string' && h ? h : 'default-user';
}

export function createBrandRouter(deps: BrandDeps): Router {
  const router = express.Router();
  const store = new BrandStore(deps.dataDir);
  const tenants = new TenantStore(deps.tenancyDbPath ?? join(deps.dataDir, 'tenancy.db'));

  function isAdmin(req: express.Request): boolean {
    if ((req as express.Request & { loopbackAuthed?: boolean }).loopbackAuthed) return true;
    // Admin-gated per tenancy role: owner/admin in any org of this deployment.
    return tenants.listOrgsForUser(callerOf(req)).some((o) => canAct(o.role, 'admin'));
  }

  router.get('/', (_req, res) => {
    res.json({ ok: true, brand: store.get() });
  });

  router.put('/', (req, res) => {
    if (!isAdmin(req)) {
      res.status(403).json({ ok: false, error: 'brand updates require an org admin/owner (or the loopback token)' });
      return;
    }
    try {
      const brand = store.set((req.body ?? {}) as Partial<BrandConfig>, callerOf(req));
      deps.audit?.('brand.updated', { actor: callerOf(req), detail: { name: brand.name, primaryColor: brand.primaryColor } });
      res.json({ ok: true, brand });
    } catch (e) {
      res.status(400).json({ ok: false, error: e instanceof Error ? e.message : 'invalid brand' });
    }
  });

  return router;
}
