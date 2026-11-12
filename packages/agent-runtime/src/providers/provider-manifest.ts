// SPDX-License-Identifier: Apache-2.0
// Provider manifests: loadable bridge packages, manifest-first (Timon parity A2).
//
// Why this module exists
// ----------------------
// Before A2, everything KriyaDot knew about a subscription CLI bridge —
// its binary name, install command, credential file, identity banner,
// isolation knob, model source — was hardcoded in a different module per
// fact (cli-bridge.ts, cli-identity.ts, cli-usage.ts, bridge-accounts.ts,
// catalog.json), so adding a bridge meant editing six places and the new
// bridge silently missed whichever integration its author forgot
// (accounts, cooldowns, usage, the Providers UI).
//
// A2 inverts that: each bridge is a loadable PACKAGE declared by one
// manifest in provider-manifest.json — a format in KriyaDot's own shape,
// extending the conventions of our catalog.json (a `providers` map keyed
// by id, plain JSON data only, curated static model lists where no live
// source exists). The manifest is read and VALIDATED before any bridge
// code runs: validateProviderManifestSet() fails closed on a duplicate
// id, a missing binary/install hint, an identity declaration that fails
// A8's regex-safety gate, an isolation claim with no knobs (or a
// non-isolatable claim with no honest note), a model source that names
// no CLI command it claims to run, or a catalog block that disagrees
// with the bridge's own provider preset. The consumers (detection,
// identity probing, account isolation, usage probes, the factory, the
// Providers UI data path) derive their per-bridge facts from the loaded
// manifests instead of restating them.
//
// Migration rule (behaviour must not change for existing users): the
// three shipped bridges (claude / codex / opencode) migrated FIRST. Their
// manifests restate — field for field — the A8 identity declarations, the
// A6 isolation notes, the A1 usage notes and the catalog presets that
// shipped in v0.2.2; the A2 test suite asserts that equality so a manifest
// edit cannot quietly change a live bridge.
//
// The five new bridges (copilot / grok / kimi / pi / hermes) are
// manifest+driver pairs on the SAME generic machinery: the generic CLI
// driver path (identity-verified resolution in cli-bridge.ts, ACP /
// one-shot agent drivers parameterised by the manifest's driver block),
// never five bespoke drivers. What each vendors' CLI actually does was
// investigated from its public documentation; every manifest carries
// `verified` + `verificationBasis` stating plainly what is verified
// (binary name, install hint, documented config-dir knob) and what is
// ASSUMED (exact --version banner wording, credential file names inside
// a documented home dir) because none of the five binaries exists on the
// build machine. Where a CLI has no machine-readable usage surface the
// manifest says so and the gauge stays honestly null; where it documents
// no per-account config-dir knob the manifest says isolatable: false
// with the reason, instead of pretending a second sign-in is isolated.
//
// Threat model: a manifest is TRUSTED input (it ships with KriyaDot,
// like catalog.json) but it is still validated as if it were not — the
// identity matcher it declares is only ever run through A8's bounded,
// ReDoS-gated matching over capped output, and a manifest can never
// weaken the identity check itself (no flag disables probing).
//
// Honest limits
// -------------
// - A manifest is a DECLARATION, not proof: the runtime still probes the
//   binary on the machine before spawning it. A manifest whose banner
//   assumption is wrong for a future CLI release fails closed (the
//   bridge reports "not the real CLI") rather than spawning a namesake.
// - Static model lists are curated labels. For ACP/agent-driven bridges
//   the CLI picks its serving model under the user's subscription; the
//   list exists so pickers have stable ids, and each manifest's basis
//   says where its labels came from.
// - Credential `kind: 'cli-own'` bridges never have token bytes read by
//   KriyaDot: sign-in state is a file-shape probe only (see cli-bridge).
//
// Clean room: Timon is AGPL-3.0. Only the BEHAVIOUR ("a bridge should be
// a declared, loadable package") was consulted; this format's fields,
// names and layout are KriyaDot's own, extending OUR catalog.json.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertSafeRegexPattern,
  type CliIdentityDeclaration,
  type CliIdentityMatch,
} from './cli-identity.js';

// Statically imported so single-file binaries carry the manifests even
// though import.meta.url no longer points at a real directory (same
// pattern as catalog.ts). The filesystem copy wins when present.
import bundledManifests from './provider-manifest.json' with { type: 'json' };

/** Bridge ids that existed before A2 (HTTPS-token / native bridges). */
export type LegacyCliBridgeId = 'claude' | 'codex' | 'opencode';
/** Bridge ids added by A2. */
export type NewCliBridgeId = 'copilot' | 'grok' | 'kimi' | 'pi' | 'hermes';
/** Every subscription bridge id. This is the widened CliBridgeId. */
export type AnyCliBridgeId = LegacyCliBridgeId | NewCliBridgeId;

export const LEGACY_CLI_BRIDGE_IDS: LegacyCliBridgeId[] = ['claude', 'codex', 'opencode'];
export const NEW_CLI_BRIDGE_IDS: NewCliBridgeId[] = ['copilot', 'grok', 'kimi', 'pi', 'hermes'];
export const ALL_CLI_BRIDGE_IDS: AnyCliBridgeId[] = [...LEGACY_CLI_BRIDGE_IDS, ...NEW_CLI_BRIDGE_IDS];

export function isAnyCliBridgeId(v: unknown): v is AnyCliBridgeId {
  return typeof v === 'string' && (ALL_CLI_BRIDGE_IDS as string[]).includes(v);
}
export function isLegacyCliBridgeId(v: unknown): v is LegacyCliBridgeId {
  return typeof v === 'string' && (LEGACY_CLI_BRIDGE_IDS as string[]).includes(v);
}

/** How an account's config dir is turned into spawn env (bridge-accounts). */
export type ManifestSpawnEnvKind = 'single-dir' | 'xdg-family' | 'none';

/** One bridge package, as data. JSON-compatible values only. */
export interface ProviderManifest {
  bridgeId: AnyCliBridgeId;
  /** Catalog preset id this bridge backs (e.g. 'copilot-subscription'). */
  providerId: string;
  displayName: string;
  /** True only when every load-bearing fact was verified (see basis). */
  verified: boolean;
  /** Plain-words account of what is verified vs assumed for this CLI. */
  verificationBasis: string;
  binary: {
    /** Bare command names resolved on PATH, in order. */
    names: string[];
    install: { posix: string; win32: string };
  };
  /** A8-shape identity declaration (carried by the manifest, A2 §1). */
  identity: CliIdentityDeclaration;
  credentials: {
    /** Credential file path relative to the user's home dir. */
    homeRelative: string;
    /**
     * 'oauth-json': KriyaDot reads the token (consent-gated, memory-only)
     * for the HTTPS lane. 'cli-own': the CLI owns its login end to end;
     * KriyaDot only shape-probes the file and never reads token bytes.
     */
    kind: 'oauth-json' | 'cli-own';
    /** Which shape probe applies (see cli-bridge token extractors). */
    tokenShape: 'claude-oauth' | 'codex-auth' | 'opencode-auth' | 'gh-hosts' | 'file-present';
  };
  isolation: {
    isolatable: boolean;
    envKnobs: string[];
    note: string;
    spawnEnvKind: ManifestSpawnEnvKind;
  };
  auth: {
    signInCommand: string;
    loginArgs: string[];
    statusArgs: string[] | null;
    flow: 'oauth-url' | 'paste-code' | 'cli-own';
  };
  models: {
    /** 'catalog-static': the catalog preset's curated list. 'cli-command': parsed from the CLI. */
    source: 'catalog-static' | 'cli-command';
    cliArgs: string[] | null;
  };
  usage: {
    surface: 'cli-status' | 'none';
    statusArgs: string[] | null;
    note: string;
  };
  driver: {
    kind: 'https-token' | 'native-cli' | 'acp' | 'agent-cli';
    /** agent/<cli-id>/… id for acp / agent-cli / native-cli drivers. */
    agentCliId?: string;
    /** ACP spawn args (kind 'acp' only). */
    acpArgs?: string[];
  };
  catalog: { api: string; baseUrl: string; envKey: string };
}

export interface ProviderManifestFile {
  version: 1;
  providers: Record<string, ProviderManifest>;
}

// ---------------------------------------------------------------------------
// Validation (fail closed). Pure: returns a list of problems, empty = valid.
// ---------------------------------------------------------------------------

const BRIDGE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkIdentityMatch(m: unknown, problems: string[], where: string): void {
  if (!isPlainObject(m) || typeof m.kind !== 'string') {
    problems.push(`${where}: identity match must be an object with a kind`);
    return;
  }
  switch (m.kind) {
    case 'firstLineContains':
    case 'firstLinePrefix':
    case 'outputContains':
      if (typeof m.needle !== 'string' || m.needle.length === 0 || m.needle.length > 120) {
        problems.push(`${where}: identity match "${m.kind}" needs a non-empty needle (≤120 chars)`);
      }
      break;
    case 'firstLineSemver':
      break;
    case 'regex':
      if (typeof m.source !== 'string' || !assertSafeRegexPattern(m.source)) {
        problems.push(`${where}: identity regex is missing or fails the A8 ReDoS safety gate`);
      }
      break;
    default:
      problems.push(`${where}: unknown identity match kind "${String(m.kind)}"`);
  }
}

/** Validate one manifest (already known to sit under key `expectedId`). */
export function validateProviderManifest(raw: unknown, expectedId?: string): string[] {
  const problems: string[] = [];
  if (!isPlainObject(raw)) return ['manifest must be an object'];
  const id = raw.bridgeId;
  const tag = typeof id === 'string' ? `manifest "${id}"` : 'manifest';
  if (typeof id !== 'string' || !BRIDGE_ID_RE.test(id)) problems.push(`${tag}: bridgeId is missing or not a slug`);
  if (expectedId !== undefined && id !== expectedId) {
    problems.push(`${tag}: map key "${expectedId}" does not match bridgeId "${String(id)}"`);
  }
  if (typeof raw.providerId !== 'string' || !raw.providerId.endsWith('-subscription')) {
    problems.push(`${tag}: providerId must be the catalog preset id ending in "-subscription"`);
  }
  if (typeof raw.displayName !== 'string' || raw.displayName.length === 0) {
    problems.push(`${tag}: displayName is required`);
  }
  if (typeof raw.verified !== 'boolean') problems.push(`${tag}: verified must be a boolean`);
  if (typeof raw.verificationBasis !== 'string' || raw.verificationBasis.length < 20) {
    problems.push(`${tag}: verificationBasis must state what is verified vs assumed (≥20 chars)`);
  }
  // Binary.
  const binary = raw.binary;
  if (!isPlainObject(binary) || !Array.isArray(binary.names) || binary.names.length === 0) {
    problems.push(`${tag}: binary.names must name at least one executable`);
  } else {
    for (const n of binary.names) {
      if (typeof n !== 'string' || n.length === 0 || /[/\\\s]/.test(n)) {
        problems.push(`${tag}: binary name "${String(n)}" must be a bare command name`);
      }
    }
    const install = binary.install;
    if (!isPlainObject(install) || typeof install.posix !== 'string' || install.posix.length === 0) {
      problems.push(`${tag}: binary.install.posix is required`);
    }
    if (!isPlainObject(install) || typeof install.win32 !== 'string' || install.win32.length === 0) {
      problems.push(`${tag}: binary.install.win32 is required`);
    }
  }
  // Identity (A8 declaration carried by the manifest).
  const identity = raw.identity;
  if (!isPlainObject(identity)) {
    problems.push(`${tag}: identity declaration is required`);
  } else {
    if (identity.bridgeId !== id) problems.push(`${tag}: identity.bridgeId must equal bridgeId`);
    if (typeof identity.commandName !== 'string' || identity.commandName.length === 0) {
      problems.push(`${tag}: identity.commandName is required`);
    }
    if (
      isPlainObject(binary) && Array.isArray(binary.names) &&
      typeof identity.commandName === 'string' && !(binary.names as unknown[]).includes(identity.commandName)
    ) {
      problems.push(`${tag}: identity.commandName must be one of binary.names`);
    }
    if (!Array.isArray(identity.versionArgs) || identity.versionArgs.length === 0) {
      problems.push(`${tag}: identity.versionArgs must be a non-empty argv`);
    }
    checkIdentityMatch(identity.versionMatch, problems, tag);
    if (identity.helpMatch !== undefined) checkIdentityMatch(identity.helpMatch, problems, tag);
    if (identity.helpMatch !== undefined && !Array.isArray(identity.helpArgs)) {
      problems.push(`${tag}: identity.helpMatch requires identity.helpArgs`);
    }
    if (!Array.isArray(identity.rejectIfOutputContains)) {
      problems.push(`${tag}: identity.rejectIfOutputContains must be an array (may be empty)`);
    }
  }
  // Credentials.
  const creds = raw.credentials;
  if (!isPlainObject(creds) || typeof creds.homeRelative !== 'string' || creds.homeRelative.length === 0) {
    problems.push(`${tag}: credentials.homeRelative is required`);
  } else if (creds.homeRelative.startsWith('/') || creds.homeRelative.split(/[\\/]/).includes('..')) {
    problems.push(`${tag}: credentials.homeRelative must be a home-relative path without ".."`);
  }
  if (!isPlainObject(creds) || (creds.kind !== 'oauth-json' && creds.kind !== 'cli-own')) {
    problems.push(`${tag}: credentials.kind must be "oauth-json" or "cli-own"`);
  }
  // Isolation (A6 honesty: a knob claim needs knobs; a non-claim needs the note).
  const iso = raw.isolation;
  if (!isPlainObject(iso) || typeof iso.isolatable !== 'boolean') {
    problems.push(`${tag}: isolation.isolatable must be a boolean`);
  } else {
    if (typeof iso.note !== 'string' || iso.note.length < 20) {
      problems.push(`${tag}: isolation.note must explain the knob (or its absence) in plain words`);
    }
    if (iso.isolatable) {
      if (!Array.isArray(iso.envKnobs) || iso.envKnobs.length === 0) {
        problems.push(`${tag}: isolatable: true requires isolation.envKnobs`);
      }
      if (iso.spawnEnvKind !== 'single-dir' && iso.spawnEnvKind !== 'xdg-family') {
        problems.push(`${tag}: isolatable: true requires spawnEnvKind "single-dir" or "xdg-family"`);
      }
    } else {
      if (iso.spawnEnvKind !== 'none') problems.push(`${tag}: isolatable: false requires spawnEnvKind "none"`);
    }
  }
  // Auth.
  const auth = raw.auth;
  if (!isPlainObject(auth) || typeof auth.signInCommand !== 'string' || auth.signInCommand.length === 0) {
    problems.push(`${tag}: auth.signInCommand is required`);
  }
  if (!isPlainObject(auth) || !Array.isArray(auth.loginArgs)) {
    problems.push(`${tag}: auth.loginArgs must be an argv array (may be empty)`);
  }
  // Models.
  const models = raw.models;
  if (!isPlainObject(models) || (models.source !== 'catalog-static' && models.source !== 'cli-command')) {
    problems.push(`${tag}: models.source must be "catalog-static" or "cli-command"`);
  } else if (models.source === 'cli-command' && (!Array.isArray(models.cliArgs) || models.cliArgs.length === 0)) {
    problems.push(`${tag}: models.source "cli-command" requires models.cliArgs`);
  } else if (models.source === 'catalog-static' && models.cliArgs !== null) {
    problems.push(`${tag}: models.source "catalog-static" requires models.cliArgs to be null`);
  }
  // Usage (honesty: "none" must not name a probe).
  const usage = raw.usage;
  if (!isPlainObject(usage) || (usage.surface !== 'cli-status' && usage.surface !== 'none')) {
    problems.push(`${tag}: usage.surface must be "cli-status" or "none"`);
  } else {
    if (typeof usage.note !== 'string' || usage.note.length < 20) {
      problems.push(`${tag}: usage.note must explain the surface (or its absence)`);
    }
    if (usage.surface === 'cli-status' && (!Array.isArray(usage.statusArgs) || usage.statusArgs.length === 0)) {
      problems.push(`${tag}: usage.surface "cli-status" requires usage.statusArgs`);
    }
    if (usage.surface === 'none' && usage.statusArgs !== null) {
      problems.push(`${tag}: usage.surface "none" requires usage.statusArgs to be null`);
    }
  }
  // Driver.
  const driver = raw.driver;
  if (!isPlainObject(driver) || !['https-token', 'native-cli', 'acp', 'agent-cli'].includes(String(driver.kind))) {
    problems.push(`${tag}: driver.kind must be https-token, native-cli, acp or agent-cli`);
  } else if (driver.kind !== 'https-token') {
    if (typeof driver.agentCliId !== 'string' || driver.agentCliId.length === 0) {
      problems.push(`${tag}: driver kind "${String(driver.kind)}" requires driver.agentCliId`);
    }
    if (driver.kind === 'acp' && (!Array.isArray(driver.acpArgs) || driver.acpArgs.length === 0)) {
      problems.push(`${tag}: driver kind "acp" requires driver.acpArgs`);
    }
  }
  // Catalog block.
  const catalog = raw.catalog;
  if (!isPlainObject(catalog) || typeof catalog.envKey !== 'string' || !ENV_KEY_RE.test(catalog.envKey)) {
    problems.push(`${tag}: catalog.envKey must be an env var name`);
  }
  if (!isPlainObject(catalog) || typeof catalog.api !== 'string' || catalog.api.length === 0) {
    problems.push(`${tag}: catalog.api is required`);
  }
  return problems;
}

/** Validate a whole manifest file: per-manifest rules + set rules (duplicates, coverage). */
export function validateProviderManifestSet(raw: unknown): string[] {
  if (!isPlainObject(raw)) return ['manifest file must be an object'];
  const problems: string[] = [];
  if (raw.version !== 1) problems.push('manifest file version must be 1');
  const providers = raw.providers;
  if (!isPlainObject(providers)) return [...problems, 'manifest file providers must be an object'];
  const seenProviderIds = new Map<string, string>();
  for (const [key, manifest] of Object.entries(providers)) {
    problems.push(...validateProviderManifest(manifest, key));
    if (isPlainObject(manifest) && typeof manifest.providerId === 'string') {
      const prior = seenProviderIds.get(manifest.providerId);
      if (prior) problems.push(`manifest "${key}": duplicate providerId "${manifest.providerId}" (also on "${prior}")`);
      seenProviderIds.set(manifest.providerId, key);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Loading. The shipped set is validated at module load; an invalid shipped
// manifest is a build error, surfaced loudly rather than half-loading.
// ---------------------------------------------------------------------------

/** Absolute path of the shipped provider-manifest.json (src/ and dist/). */
export function providerManifestFilePath(): string {
  return fileURLToPath(new URL('./provider-manifest.json', import.meta.url));
}

function loadManifestFile(): ProviderManifestFile {
  try {
    const raw = readFileSync(providerManifestFilePath(), 'utf8');
    return JSON.parse(raw) as ProviderManifestFile;
  } catch {
    return bundledManifests as ProviderManifestFile;
  }
}

let cachedManifests: Map<AnyCliBridgeId, ProviderManifest> | null = null;

function manifests(): Map<AnyCliBridgeId, ProviderManifest> {
  if (cachedManifests) return cachedManifests;
  const file = loadManifestFile();
  const problems = validateProviderManifestSet(file);
  if (problems.length > 0) {
    throw new Error(`Invalid provider manifests (fail closed): ${problems.join('; ')}`);
  }
  const map = new Map<AnyCliBridgeId, ProviderManifest>();
  for (const m of Object.values(file.providers)) map.set(m.bridgeId, m);
  // Coverage: every known bridge id must have exactly one manifest.
  for (const id of ALL_CLI_BRIDGE_IDS) {
    if (!map.has(id)) throw new Error(`Invalid provider manifests (fail closed): no manifest for bridge "${id}"`);
  }
  if (map.size !== ALL_CLI_BRIDGE_IDS.length) {
    throw new Error('Invalid provider manifests (fail closed): manifest set names an unknown bridge id');
  }
  cachedManifests = map;
  return map;
}

/** Test helper: drop the cached manifest set so a modified file is re-read. */
export function resetProviderManifestCache(): void {
  cachedManifests = null;
}

/** All loaded bridge manifests, in ALL_CLI_BRIDGE_IDS order. */
export function listProviderManifests(): ProviderManifest[] {
  const map = manifests();
  return ALL_CLI_BRIDGE_IDS.map((id) => map.get(id)!);
}

/** One bridge's manifest. Throws for an unknown id (fail closed). */
export function getProviderManifest(id: AnyCliBridgeId): ProviderManifest {
  const m = manifests().get(id);
  if (!m) throw new Error(`No provider manifest for bridge "${id}"`);
  return m;
}

/** The A8 identity declaration a bridge's manifest carries. */
export function manifestIdentityDeclaration(id: AnyCliBridgeId): CliIdentityDeclaration {
  return getProviderManifest(id).identity as CliIdentityDeclaration;
}

/** The catalog preset id a bridge backs ('copilot-subscription', …). */
export function manifestProviderId(id: AnyCliBridgeId): string {
  return getProviderManifest(id).providerId;
}

/** The curated static model source decision for a bridge. */
export function manifestModelSource(id: AnyCliBridgeId): ProviderManifest['models'] {
  return getProviderManifest(id).models;
}
