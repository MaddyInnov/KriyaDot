// SPDX-License-Identifier: Apache-2.0
// Team-sharing manifest (OpenMausBot parity P1 #18).
//
// A self-contained, hand-editable, version-controllable spec for one agent
// team: team identity, embedded full bot configs (coordinator + members, so
// the team round-trips onto a fresh install), the rendered roster prompt
// snapshot, coordination rules (delegation policy), referenced workflow
// ids, and a SHA-256 checksum over the canonical payload.
//
// Pure logic — no I/O. HTTP wiring lives in apps/api (teams-routes.ts);
// file/UI naming uses the `kriyadot.team.json` convention documented there.

import { createHash } from 'node:crypto';
import {
  DELEGATION_POLICIES,
  DEFAULT_DELEGATION_POLICY,
  buildCoordinatorPrompt,
  isDelegationPolicy,
  type DelegationPolicy,
  type Team,
} from './teams.js';
import type { BotConfig } from './types.js';

/** Manifest format marker — also the `kriyadot.team.json` file convention. */
export const TEAM_MANIFEST_FORMAT = 'kriyadot.team';
/** Current manifest schema version. */
export const TEAM_MANIFEST_VERSION = '1';
/** Supported schema versions for import. */
export const TEAM_MANIFEST_SUPPORTED_VERSIONS: readonly string[] = ['1'] as const;

/** Coordination rules captured in the manifest. */
export interface TeamManifestCoordination {
  delegationPolicy: DelegationPolicy;
  delegationPolicyOverrides: Record<string, DelegationPolicy>;
}

/** One team, fully self-contained. */
export interface TeamManifestTeam {
  id: string;
  name: string;
  createdAt: number;
  /** Full coordinator bot config (embedded so import works without it). */
  coordinator: BotConfig;
  /** Full member bot configs, in team order. */
  members: BotConfig[];
  /**
   * Rendered coordinator roster prompt snapshot (task slot left as
   * `{{task}}`). For review/hand-editing reference: the live prompt is
   * regenerated from the team + member configs at run time.
   */
  rosterPrompt: string;
  coordinationRules: TeamManifestCoordination;
  /** Workflow ids referenced by this team (optional, informational). */
  workflows: string[];
}

export interface TeamManifest {
  format: typeof TEAM_MANIFEST_FORMAT;
  version: string;
  exportedAt: string;
  exportedFrom: string;
  team: TeamManifestTeam;
  /** Hex SHA-256 over the canonical JSON of the manifest minus this field. */
  checksum: string;
}

/**
 * Recursively sort object keys so the checksum is stable regardless of
 * property insertion order. Arrays keep their order (member order matters).
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex of the canonical JSON of `manifest` excluding `checksum`. */
export function computeTeamManifestChecksum(manifest: Omit<TeamManifest, 'checksum'>): string {
  const payload = JSON.stringify(canonicalize(manifest));
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'team';
}

/** Suggested download filename for an exported manifest. */
export function teamManifestFilename(teamName: string, exportedAt: string): string {
  const stamp = exportedAt.slice(0, 10).replace(/-/g, '');
  return `kriyadot.team.${slugify(teamName)}-${stamp}.json`;
}

export interface BuildTeamManifestArgs {
  team: Team;
  coordinator: BotConfig;
  members: BotConfig[];
  /** Referenced workflow ids (optional). */
  workflows?: string[];
  /** App version string recorded as the exporter. */
  appVersion?: string;
}

/**
 * Build a signed, self-contained manifest for one team. Throws when the
 * coordinator config is missing (a manifest without it is not portable).
 */
export function buildTeamManifest(args: BuildTeamManifestArgs): TeamManifest {
  const { team, coordinator, members } = args;
  const rosterPrompt = buildCoordinatorPrompt({
    teamName: team.name,
    coordinatorName: coordinator.name,
    members: members.map((m) => ({ id: m.id, name: m.name, description: m.description })),
    task: '{{task}}',
  });
  const unsigned: Omit<TeamManifest, 'checksum'> = {
    format: TEAM_MANIFEST_FORMAT,
    version: TEAM_MANIFEST_VERSION,
    exportedAt: new Date().toISOString(),
    exportedFrom: args.appVersion ?? 'kriyadot',
    team: {
      id: team.id,
      name: team.name,
      createdAt: team.createdAt,
      coordinator,
      members,
      rosterPrompt,
      coordinationRules: {
        delegationPolicy: team.delegationPolicy ?? DEFAULT_DELEGATION_POLICY,
        delegationPolicyOverrides: team.delegationPolicyOverrides ?? {},
      },
      workflows: [...(args.workflows ?? [])],
    },
  };
  return { ...unsigned, checksum: computeTeamManifestChecksum(unsigned) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validBotId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
}

function validateEmbeddedBot(raw: unknown, where: string, errors: string[]): BotConfig | undefined {
  if (!isRecord(raw)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  if (!validBotId(raw.id)) errors.push(`${where}.id: must be 1-64 chars of letters, digits, _ or -`);
  if (typeof raw.name !== 'string' || !raw.name.trim()) errors.push(`${where}.name: must be a non-empty string`);
  if (typeof raw.description !== 'string') errors.push(`${where}.description: must be a string`);
  if (typeof raw.systemPrompt !== 'string') errors.push(`${where}.systemPrompt: must be a string`);
  if (typeof raw.provider !== 'string') errors.push(`${where}.provider: must be a string`);
  if (typeof raw.model !== 'string') errors.push(`${where}.model: must be a string`);
  for (const f of ['skills', 'tools', 'mcpServers'] as const) {
    if (!Array.isArray(raw[f]) || !(raw[f] as unknown[]).every((e) => typeof e === 'string')) {
      errors.push(`${where}.${f}: must be an array of strings`);
    }
  }
  if (errors.length > 0) return undefined;
  return raw as unknown as BotConfig;
}

export type TeamManifestValidation =
  | { ok: true; manifest: TeamManifest }
  | { ok: false; errors: string[] };

/**
 * Pure manifest validation: schema shape, supported version, and SHA-256
 * checksum. No I/O, no side effects. A hand-edited manifest is fine as
 * long as the checksum still matches — editors must recompute it (the
 * export UI and `computeTeamManifestChecksum` make that easy).
 */
export function validateTeamManifest(input: unknown): TeamManifestValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['manifest: must be an object'] };
  if (input.format !== TEAM_MANIFEST_FORMAT) {
    errors.push(`manifest.format: must be "${TEAM_MANIFEST_FORMAT}"`);
  }
  if (typeof input.version !== 'string' || !TEAM_MANIFEST_SUPPORTED_VERSIONS.includes(input.version)) {
    errors.push(
      `manifest.version: unsupported (supported: ${TEAM_MANIFEST_SUPPORTED_VERSIONS.join(', ')})`,
    );
  }
  if (typeof input.exportedAt !== 'string' || !input.exportedAt) {
    errors.push('manifest.exportedAt: must be an ISO timestamp string');
  }
  if (typeof input.exportedFrom !== 'string' || !input.exportedFrom) {
    errors.push('manifest.exportedFrom: must be a non-empty string');
  }
  if (typeof input.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(input.checksum)) {
    errors.push('manifest.checksum: must be a 64-char hex SHA-256');
  }
  const t = input.team;
  let team: TeamManifestTeam | undefined;
  if (!isRecord(t)) {
    errors.push('manifest.team: must be an object');
  } else {
    if (!validBotId(t.id)) errors.push('manifest.team.id: must be 1-64 chars of letters, digits, _ or -');
    if (typeof t.name !== 'string' || !t.name.trim()) errors.push('manifest.team.name: must be a non-empty string');
    if (typeof t.createdAt !== 'number' || !Number.isFinite(t.createdAt)) {
      errors.push('manifest.team.createdAt: must be a number');
    }
    if (typeof t.rosterPrompt !== 'string' || !t.rosterPrompt) {
      errors.push('manifest.team.rosterPrompt: must be a non-empty string');
    }
    const cr = t.coordinationRules;
    let rules: TeamManifestCoordination | undefined;
    if (!isRecord(cr)) {
      errors.push('manifest.team.coordinationRules: must be an object');
    } else {
      const policy = cr.delegationPolicy;
      if (policy !== undefined && !isDelegationPolicy(policy)) {
        errors.push(`manifest.team.coordinationRules.delegationPolicy: must be one of ${DELEGATION_POLICIES.join(', ')}`);
      }
      const overrides = cr.delegationPolicyOverrides;
      const cleanOverrides: Record<string, DelegationPolicy> = {};
      if (overrides !== undefined) {
        if (!isRecord(overrides)) {
          errors.push('manifest.team.coordinationRules.delegationPolicyOverrides: must be an object');
        } else {
          for (const [botId, p] of Object.entries(overrides)) {
            if (!isDelegationPolicy(p)) {
              errors.push(
                `manifest.team.coordinationRules.delegationPolicyOverrides["${botId}"]: must be one of ${DELEGATION_POLICIES.join(', ')}`,
              );
            } else {
              cleanOverrides[botId] = p;
            }
          }
        }
      }
      rules = {
        delegationPolicy: isDelegationPolicy(policy) ? policy : DEFAULT_DELEGATION_POLICY,
        delegationPolicyOverrides: cleanOverrides,
      };
    }
    let workflows: string[] | undefined;
    if (t.workflows === undefined) {
      workflows = [];
    } else if (Array.isArray(t.workflows) && t.workflows.every((w) => typeof w === 'string')) {
      workflows = [...(t.workflows as string[])];
    } else {
      errors.push('manifest.team.workflows: must be an array of strings');
    }
    const coordinator = validateEmbeddedBot(t.coordinator, 'manifest.team.coordinator', errors);
    const members: BotConfig[] = [];
    if (!Array.isArray(t.members)) {
      errors.push('manifest.team.members: must be an array');
    } else {
      (t.members as unknown[]).forEach((m, i) => {
        const b = validateEmbeddedBot(m, `manifest.team.members[${i}]`, errors);
        if (b) members.push(b);
      });
    }
    if (members.length === 0 && errors.length === 0) {
      errors.push('manifest.team.members: must list at least one member bot');
    }
    if (rules && workflows && coordinator && errors.length === 0) {
      team = {
        id: t.id as string,
        name: (t.name as string).trim().slice(0, 120),
        createdAt: t.createdAt as number,
        coordinator,
        members,
        rosterPrompt: t.rosterPrompt as string,
        coordinationRules: rules,
        workflows,
      };
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // Checksum last: only meaningful when the shape is otherwise valid.
  const { checksum, ...unsigned } = input as unknown as TeamManifest;
  const expected = computeTeamManifestChecksum(unsigned as Omit<TeamManifest, 'checksum'>);
  if (checksum !== expected) {
    return {
      ok: false,
      errors: [
        'manifest.checksum: mismatch — the manifest was modified after export. ' +
          'Re-export or recompute the checksum over the canonical payload.',
      ],
    };
  }
  return {
    ok: true,
    manifest: {
      format: TEAM_MANIFEST_FORMAT,
      version: input.version as string,
      exportedAt: input.exportedAt as string,
      exportedFrom: input.exportedFrom as string,
      team: team as TeamManifestTeam,
      checksum: checksum as string,
    },
  };
}

/**
 * Describe what importing `manifest` would do against the current state —
 * used by the import route for the 409 name-collision response and by
 * tests. Pure: no I/O.
 */
export function describeTeamImport(
  manifest: TeamManifest,
  existingTeams: Pick<Team, 'id' | 'name'>[],
  existingBotIds: Set<string>,
): {
  nameCollision: { teamId: string; name: string } | null;
  missingBotIds: string[];
} {
  const needle = manifest.team.name.trim().toLowerCase();
  const hit = existingTeams.find((t) => t.name.trim().toLowerCase() === needle);
  const botIds = [manifest.team.coordinator.id, ...manifest.team.members.map((m) => m.id)];
  return {
    nameCollision: hit ? { teamId: hit.id, name: hit.name } : null,
    missingBotIds: [...new Set(botIds.filter((id) => !existingBotIds.has(id)))],
  };
}
