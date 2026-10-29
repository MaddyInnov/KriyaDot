// SPDX-License-Identifier: Apache-2.0
// SkillHub network installs (§2.16 #151): install a skill package from the
// network through the SAME lifecycle as local skill installs.
//
// Sources:
//   - a registry index URL: JSON { skills: [{ id, name, description,
//     downloadUrl, sha256? }] } — install one entry by id;
//   - a direct package URL: a skill package JSON (the kriyadot.skill
//     export format, or a bare { name, description, instructions } object).
//
// Safety:
//   - URLs must be http(s); anything else is rejected before any fetch.
//   - When a SHA-256 is provided (index entry, package field, or the
//     caller's expected value) it is verified against the exact downloaded
//     bytes BEFORE anything is written; a mismatch installs nothing.
//   - Installed skills go through UserSkillStore.createSkill with source
//     'imported', so they start DISABLED and sit in the review queue like
//     every other user skill — a network install never self-enables.
//   - Packages carrying copyPolicy 'lock' are recorded as locked imports
//     (cannot be re-exported) via the skill copy-policy store.

import { createHash } from 'node:crypto';
import express, { type Router } from 'express';
import type { UserSkillRecord, UserSkillStore } from '@mvp/agent-runtime';
import { parseSkillPackage, type SkillCopyPolicyStore } from './skill-copy-policy.js';

export class SkillHubError extends Error {}
export class SkillHubChecksumError extends SkillHubError {}

export interface SkillHubIndexEntry {
  id: string;
  name: string;
  description: string;
  downloadUrl: string;
  sha256?: string;
}

export interface SkillHubIndex {
  skills: SkillHubIndexEntry[];
}

export type SkillHubFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const defaultFetch: SkillHubFetch = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

function assertHttpUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SkillHubError(`${what} is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SkillHubError(`${what} must be an http(s) URL: "${raw}"`);
  }
  return url;
}

/** Parse + validate a registry index document. Throws SkillHubError. */
export function parseSkillHubIndex(text: string): SkillHubIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SkillHubError('SkillHub registry index is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { skills?: unknown }).skills)) {
    throw new SkillHubError('SkillHub registry index must be an object with a "skills" array.');
  }
  const skills: SkillHubIndexEntry[] = [];
  for (const [i, raw] of ((parsed as { skills: unknown[] }).skills).entries()) {
    if (!raw || typeof raw !== 'object') throw new SkillHubError(`Registry entry ${i} is not an object.`);
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id) throw new SkillHubError(`Registry entry ${i} has no "id".`);
    if (typeof e.name !== 'string' || !e.name) throw new SkillHubError(`Registry entry "${e.id}" has no "name".`);
    if (typeof e.downloadUrl !== 'string' || !e.downloadUrl) {
      throw new SkillHubError(`Registry entry "${e.id}" has no "downloadUrl".`);
    }
    assertHttpUrl(e.downloadUrl, `Registry entry "${e.id}" downloadUrl`);
    if (e.sha256 !== undefined && (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(e.sha256))) {
      throw new SkillHubError(`Registry entry "${e.id}" has an invalid sha256 (expected 64 hex chars).`);
    }
    skills.push({
      id: e.id,
      name: e.name,
      description: typeof e.description === 'string' ? e.description : '',
      downloadUrl: e.downloadUrl,
      ...(typeof e.sha256 === 'string' ? { sha256: e.sha256.toLowerCase() } : {}),
    });
  }
  return { skills };
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface SkillHubInstallDeps {
  store: UserSkillStore;
  fetchFn?: SkillHubFetch;
  /** Copy-policy store: lock packages are recorded as locked imports. */
  copyPolicies?: SkillCopyPolicyStore;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

async function fetchText(fetchFn: SkillHubFetch, url: string, what: string): Promise<string> {
  let res: Awaited<ReturnType<SkillHubFetch>>;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new SkillHubError(`Failed to fetch ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new SkillHubError(`Failed to fetch ${what}: HTTP ${res.status}`);
  return res.text();
}

/** Fetch + parse a registry index from its URL. */
export async function fetchSkillHubIndex(
  registryUrl: string,
  fetchFn: SkillHubFetch = defaultFetch,
): Promise<SkillHubIndex> {
  assertHttpUrl(registryUrl, 'Registry URL');
  const text = await fetchText(fetchFn, registryUrl, 'SkillHub registry index');
  return parseSkillHubIndex(text);
}

/**
 * Download one package, verify its checksum when one is known, and install
 * it DISABLED via the user-skill store. `expectedSha256` (from the index
 * entry or the caller) wins over a checksum embedded in the package.
 */
export async function installSkillPackageFromUrl(
  deps: SkillHubInstallDeps,
  args: { packageUrl: string; expectedSha256?: string },
): Promise<{ skill: UserSkillRecord; sha256: string }> {
  assertHttpUrl(args.packageUrl, 'Package URL');
  const fetchFn = deps.fetchFn ?? defaultFetch;
  const text = await fetchText(fetchFn, args.packageUrl, 'skill package');
  const digest = sha256Hex(text);
  let pkg;
  try {
    pkg = parseSkillPackage(text);
  } catch (err) {
    throw new SkillHubError(err instanceof Error ? err.message : String(err));
  }
  const expected = (args.expectedSha256 ?? pkg.sha256)?.toLowerCase();
  if (expected) {
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      throw new SkillHubError('Expected sha256 must be 64 hex characters.');
    }
    if (digest !== expected) {
      throw new SkillHubChecksumError(
        `Skill package checksum mismatch for "${pkg.name}": expected ${expected}, got ${digest}. Nothing was installed.`,
      );
    }
  }
  const skill = deps.store.createSkill({
    name: pkg.name,
    description: pkg.description,
    instructions: pkg.instructions,
    examples: pkg.examples,
    version: pkg.version,
    source: 'imported',
  });
  if (pkg.copyPolicy === 'lock') deps.copyPolicies?.markLockedImport(pkg.name);
  deps.audit?.('skill.hub_installed', {
    detail: { name: skill.name, source: args.packageUrl, sha256: digest, status: skill.status },
  });
  return { skill, sha256: digest };
}

/** Install one entry from a registry index by entry id. */
export async function installSkillFromRegistry(
  deps: SkillHubInstallDeps,
  args: { registryUrl: string; skillId: string },
): Promise<{ skill: UserSkillRecord; entry: SkillHubIndexEntry; sha256: string }> {
  const index = await fetchSkillHubIndex(args.registryUrl, deps.fetchFn ?? defaultFetch);
  const entry = index.skills.find((s) => s.id === args.skillId);
  if (!entry) {
    throw new SkillHubError(
      `SkillHub registry has no skill with id "${args.skillId}" (has: ${index.skills.map((s) => s.id).join(', ') || 'none'}).`,
    );
  }
  const { skill, sha256 } = await installSkillPackageFromUrl(deps, {
    packageUrl: entry.downloadUrl,
    expectedSha256: entry.sha256,
  });
  return { skill, entry, sha256 };
}

// ---------------------------------------------------------------------------
// Routes (router factory — the parent mounts this next to the skill store
// router, e.g. app.use('/api/skills', createSkillHubRouter({...}))):
//   GET  /hub/index?url=<registryUrl>     → browse a registry index
//   POST /hub/install { registryUrl, skillId } | { packageUrl, sha256? }
// ---------------------------------------------------------------------------

export function createSkillHubRouter(deps: SkillHubInstallDeps): Router {
  const router = express.Router();

  router.get('/hub/index', async (req, res) => {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    if (!url) {
      res.status(400).json({ error: 'url query parameter (registry index URL) is required' });
      return;
    }
    try {
      const index = await fetchSkillHubIndex(url, deps.fetchFn ?? defaultFetch);
      res.json({ ok: true, skills: index.skills });
    } catch (err) {
      const status = err instanceof SkillHubError ? 400 : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/hub/install', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (typeof body.registryUrl === 'string' && body.registryUrl) {
        if (typeof body.skillId !== 'string' || !body.skillId) {
          res.status(400).json({ error: 'skillId is required with registryUrl' });
          return;
        }
        const out = await installSkillFromRegistry(deps, {
          registryUrl: body.registryUrl,
          skillId: body.skillId,
        });
        res.status(201).json({
          ok: true,
          skill: { name: out.skill.name, status: out.skill.status, source: out.skill.source },
          sha256: out.sha256,
          message: `Skill "${out.skill.name}" installed DISABLED from SkillHub — review + enable it before any bot can use it.`,
        });
        return;
      }
      if (typeof body.packageUrl === 'string' && body.packageUrl) {
        const out = await installSkillPackageFromUrl(deps, {
          packageUrl: body.packageUrl,
          expectedSha256: typeof body.sha256 === 'string' ? body.sha256 : undefined,
        });
        res.status(201).json({
          ok: true,
          skill: { name: out.skill.name, status: out.skill.status, source: out.skill.source },
          sha256: out.sha256,
          message: `Skill "${out.skill.name}" installed DISABLED from SkillHub — review + enable it before any bot can use it.`,
        });
        return;
      }
      res.status(400).json({ error: 'Provide registryUrl + skillId, or packageUrl' });
    } catch (err) {
      const status = err instanceof SkillHubError ? 400 : 500;
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
