// SPDX-License-Identifier: Apache-2.0
// Skill copy policy (§2.16 #154): every skill carries a copyPolicy —
//
//   'open' (default) — export/import freely.
//   'lock'           — export is allowed, but the exported package carries
//                      the policy plus a watermark header comment, and
//                      re-importing it marks the copy as a LOCKED IMPORT:
//                      a locked import can never be re-exported.
//   'deny'           — export endpoints refuse outright.
//
// Policy lives in a sidecar store (<dataDir>/skill-copy-policies.json) so
// the agent-runtime UserSkillStore schema stays untouched; export/import
// themselves are implemented here (there was no prior export endpoint)
// against the same UserSkillStore the local lifecycle uses, so imported
// skills start DISABLED exactly like local installs.

import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import type { UserSkillRecord, UserSkillStore } from '@mvp/agent-runtime';

export type SkillCopyPolicy = 'open' | 'lock' | 'deny';
export const SKILL_COPY_POLICIES: readonly SkillCopyPolicy[] = ['open', 'lock', 'deny'];

export function isSkillCopyPolicy(v: unknown): v is SkillCopyPolicy {
  return v === 'open' || v === 'lock' || v === 'deny';
}

export class SkillExportDeniedError extends Error {}
export class SkillPackageError extends Error {}

interface PolicyRow {
  policy: SkillCopyPolicy;
  lockedImport?: boolean;
}

type PolicyFile = Record<string, PolicyRow>;

export class SkillCopyPolicyStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'skill-copy-policies.json');
  }

  private read(): PolicyFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      return parsed as PolicyFile;
    } catch {
      return {};
    }
  }

  private write(rows: PolicyFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** Policy for a skill; 'open' when never set. */
  getPolicy(name: string): SkillCopyPolicy {
    const row = this.read()[name];
    return row && isSkillCopyPolicy(row.policy) ? row.policy : 'open';
  }

  setPolicy(name: string, policy: SkillCopyPolicy): SkillCopyPolicy {
    const rows = this.read();
    rows[name] = { ...rows[name], policy };
    this.write(rows);
    return policy;
  }

  /** True when this skill arrived as a 'lock' package import (no re-export). */
  isLockedImport(name: string): boolean {
    return this.read()[name]?.lockedImport === true;
  }

  markLockedImport(name: string): void {
    const rows = this.read();
    rows[name] = { policy: rows[name]?.policy ?? 'lock', lockedImport: true };
    this.write(rows);
  }

  /** Export gate: 'deny' skills and locked imports may not be exported. */
  assertExportable(name: string): void {
    if (this.isLockedImport(name)) {
      throw new SkillExportDeniedError(
        `Skill "${name}" is a locked import (copyPolicy "lock") and cannot be re-exported.`,
      );
    }
    if (this.getPolicy(name) === 'deny') {
      throw new SkillExportDeniedError(`Skill "${name}" has copyPolicy "deny" — export is refused.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Package format (shared with SkillHub installs)
// ---------------------------------------------------------------------------

export const SKILL_PACKAGE_FORMAT = 'kriyadot.skill';

export interface SkillPackage {
  format: typeof SKILL_PACKAGE_FORMAT;
  version: 1;
  name: string;
  description: string;
  skillVersion: string;
  instructions: string;
  examples?: string;
  copyPolicy: SkillCopyPolicy;
  exportedAt: string;
  sha256?: string;
}

export const LOCK_WATERMARK =
  '<!-- KriyaDot skill export — copyPolicy: lock. This package is licensed for local use only; re-export is disabled on import. -->';

/** Build an export package for a stored skill. Throws SkillExportDeniedError. */
export function buildSkillExportPackage(
  store: UserSkillStore,
  policies: SkillCopyPolicyStore,
  name: string,
): SkillPackage {
  const rec = store.get(name);
  if (!rec) throw new SkillPackageError(`Unknown skill: "${name}"`);
  if (rec.status === 'draft' || rec.status === 'rejected') {
    throw new SkillPackageError(`Cannot export a ${rec.status} skill proposal.`);
  }
  policies.assertExportable(name);
  const policy = policies.getPolicy(name);
  const content = store.readSkillFileContent(name);
  const instructions =
    policy === 'lock' ? `${LOCK_WATERMARK}\n\n${content.instructions}` : content.instructions;
  return {
    format: SKILL_PACKAGE_FORMAT,
    version: 1,
    name: rec.name,
    description: rec.description,
    skillVersion: rec.version,
    instructions,
    ...(content.examples ? { examples: content.examples } : {}),
    copyPolicy: policy,
    exportedAt: new Date().toISOString(),
  };
}

/** Parse + validate a skill package (object or JSON text). Throws SkillPackageError. */
export function parseSkillPackage(input: unknown): {
  name: string;
  description: string;
  instructions: string;
  examples?: string;
  version?: string;
  copyPolicy: SkillCopyPolicy;
  sha256?: string;
} {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new SkillPackageError('Skill package is not valid JSON.');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillPackageError('Skill package must be a JSON object.');
  }
  const pkg = raw as Record<string, unknown>;
  if (pkg.format !== undefined && pkg.format !== SKILL_PACKAGE_FORMAT) {
    throw new SkillPackageError(`Unsupported skill package format: ${String(pkg.format)}`);
  }
  const name = typeof pkg.name === 'string' ? pkg.name : '';
  const description = typeof pkg.description === 'string' ? pkg.description : '';
  const instructions = typeof pkg.instructions === 'string' ? pkg.instructions : '';
  if (!name) throw new SkillPackageError('Skill package has no "name".');
  if (!instructions.trim()) throw new SkillPackageError('Skill package has no "instructions".');
  const copyPolicy = isSkillCopyPolicy(pkg.copyPolicy) ? pkg.copyPolicy : 'open';
  return {
    name,
    description: description || `Imported skill "${name}"`,
    instructions,
    ...(typeof pkg.examples === 'string' ? { examples: pkg.examples } : {}),
    ...(typeof pkg.skillVersion === 'string'
      ? { version: pkg.skillVersion }
      : typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version)
        ? { version: pkg.version }
        : {}),
    copyPolicy,
    ...(typeof pkg.sha256 === 'string' ? { sha256: pkg.sha256 } : {}),
  };
}

/**
 * Import a package through the user-skill store (starts DISABLED).
 * 'lock' packages become locked imports; other policies are recorded as
 * the imported skill's own policy.
 */
export function importSkillPackage(
  store: UserSkillStore,
  policies: SkillCopyPolicyStore,
  input: unknown,
): UserSkillRecord {
  const pkg = parseSkillPackage(input);
  const rec = store.createSkill({
    name: pkg.name,
    description: pkg.description,
    instructions: pkg.instructions,
    examples: pkg.examples,
    version: pkg.version,
    source: 'imported',
  });
  if (pkg.copyPolicy === 'lock') {
    policies.markLockedImport(pkg.name);
  } else {
    policies.setPolicy(pkg.name, pkg.copyPolicy);
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Routes (router factory — mount next to the skill store router):
//   GET  /:name/export            → skill package JSON (policy-gated)
//   POST /import { package }      → import a package (starts DISABLED)
//   PUT  /:name/copy-policy { policy } → set a skill's copy policy
// ---------------------------------------------------------------------------

export interface SkillPackageRouterDeps {
  store: UserSkillStore;
  policies: SkillCopyPolicyStore;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

export function createSkillPackageRouter(deps: SkillPackageRouterDeps): Router {
  const router = express.Router();
  const { store, policies } = deps;

  router.get('/:name/export', (req, res) => {
    try {
      const pkg = buildSkillExportPackage(store, policies, req.params.name);
      deps.audit?.('skill.exported', { detail: { name: pkg.name, copyPolicy: pkg.copyPolicy } });
      res.json({ ok: true, package: pkg });
    } catch (err) {
      const status = err instanceof SkillExportDeniedError ? 403 : err instanceof SkillPackageError ? 404 : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/import', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const rec = importSkillPackage(store, policies, body.package ?? body);
      deps.audit?.('skill.imported', {
        detail: { name: rec.name, copyPolicy: policies.getPolicy(rec.name), lockedImport: policies.isLockedImport(rec.name) },
      });
      res.status(201).json({
        ok: true,
        skill: { name: rec.name, status: rec.status, source: rec.source },
        copyPolicy: policies.getPolicy(rec.name),
        lockedImport: policies.isLockedImport(rec.name),
        message: `Skill "${rec.name}" imported DISABLED — enable it before any bot can use it.`,
      });
    } catch (err) {
      const status = err instanceof SkillPackageError ? 400 : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/:name/copy-policy', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!store.get(req.params.name)) {
      res.status(404).json({ error: `Unknown skill: "${req.params.name}"` });
      return;
    }
    if (!isSkillCopyPolicy(body.policy)) {
      res.status(400).json({ error: 'policy must be one of: open, lock, deny' });
      return;
    }
    const policy = policies.setPolicy(req.params.name, body.policy);
    deps.audit?.('skill.copy_policy_set', { detail: { name: req.params.name, policy } });
    res.json({ ok: true, name: req.params.name, copyPolicy: policy });
  });

  return router;
}
