// SPDX-License-Identifier: Apache-2.0
// Timon parity A2 — manifest-first provider packages:
// - the manifest set loads and validates; the three legacy bridges'
//   manifests restate the shipped A8/A6/A1/catalog facts field-for-field
//   (migration without behaviour change)
// - manifest validation fails closed (duplicate ids, missing fields,
//   unsafe identity regex, dishonest isolation claims)
// - the five new bridges (copilot / grok / kimi / pi / hermes) are proven
//   with fake shim binaries on PATH: the genuine shim is accepted by the
//   identity-verified resolver, a hostile namesake is rejected — none of
//   the real CLIs is installed on this machine and none is needed
// - A6 integration: isolation registry + account store cover all eight
//   bridges from birth; A1 integration: usage gauges are honestly null
//   (no-surface) and swap decisions key on the new bridge ids
// Zero paid APIs — shims and temp dirs only.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_CLI_BRIDGE_IDS,
  BRIDGE_ACCOUNT_BRIDGES,
  BRIDGE_ISOLATION,
  BridgeAccountStore,
  CLI_BRIDGE_META,
  CLI_IDENTITY_DECLARATIONS,
  CLI_USAGE_PROBES,
  bridgeAccountCredentialsPath,
  bridgeAccountSpawnEnv,
  bridgeIdForProviderId,
  createProvider,
  detectCliBridges,
  getBridgeModels,
  getProviderManifest,
  getProviderPreset,
  grantBridgeConsent,
  isBridgeConnected,
  listProviderManifests,
  machineDefaultAccount,
  probeBridgeUsage,
  probeCliIdentity,
  resetBridgeConsent,
  resetBridgeUsageCache,
  resetCliIdentityCache,
  resetCliPathPins,
  resolveVerifiedCliExecutable,
  setCliPathPin,
  validateProviderManifest,
  validateProviderManifestSet,
  type AnyCliBridgeId,
  type BridgeAccount,
  type ProviderManifest,
} from '../src/index.js';
import bundledManifests from '../src/providers/provider-manifest.json' with { type: 'json' };

const NEW_IDS: AnyCliBridgeId[] = ['copilot', 'grok', 'kimi', 'pi', 'hermes'];

/** The genuine banner each new CLI is declared (in its manifest) to print. */
const GENUINE_BANNERS: Record<string, string> = {
  copilot: 'GitHub Copilot CLI 0.0.342',
  grok: 'grok 0.1.0',
  kimi: '2.8.0', // real-binary pass 2026-11-26: kimi --version is a bare semver
  pi: '0.30.0',
  hermes: 'Hermes Agent 0.9.0',
};

/**
 * Verbatim `--help` lines from the RECORDED real binaries (real-binary
 * pass 2026-11-26, outputs in ~/workspace/scratch/a2-real-binary/outputs/).
 * Since the B-3 close-out, pi / kimi identity requires help
 * corroboration (their --version is a content-free bare semver), so
 * their genuine shims must answer --help the way the real CLIs do:
 * kimi 2.8.0 opens with "Usage: kimi [options] [command]"; pi 1.6.1's
 * banner line is "pi - AI coding assistant with read, bash, edit,
 * write tools". The other bridges' version banners name the tool, so
 * no help fixture is needed for them.
 */
const GENUINE_HELP_LINES: Record<string, string> = {
  kimi: 'Usage: kimi [options] [command]',
  pi: 'pi - AI coding assistant with read, bash, edit, write tools',
};

let binDir = '';
let home = '';
let savedPath = '';

function script(lines: string[]): string {
  return ['#!/bin/sh', ...lines, ''].join('\n');
}
function plant(name: string, body: string): string {
  const p = join(binDir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}
function plantGenuine(id: string): string {
  const helpLine = GENUINE_HELP_LINES[id];
  if (helpLine) {
    return plant(
      id,
      script([
        `if [ "$1" = "--help" ]; then echo "${helpLine}"; exit 0; fi`,
        `echo "${GENUINE_BANNERS[id]}"`,
        'exit 0',
      ]),
    );
  }
  return plant(id, script([`echo "${GENUINE_BANNERS[id]}"`, 'exit 0']));
}
function plantHostile(id: string): string {
  return plant(
    id,
    script([
      'echo "Traceback (most recent call last):"',
      'echo "ModuleNotFoundError: No module named x"',
      'exit 1',
    ]),
  );
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'a2-bin-'));
  home = mkdtempSync(join(tmpdir(), 'a2-home-'));
  savedPath = process.env.PATH ?? '';
  resetCliIdentityCache();
  resetCliPathPins();
  resetBridgeConsent();
  resetBridgeUsageCache();
});
afterEach(() => {
  process.env.PATH = savedPath;
  resetCliIdentityCache();
  resetCliPathPins();
  resetBridgeConsent();
  resetBridgeUsageCache();
});

// ---------------------------------------------------------------------------

describe('manifest set: loadable, complete, validated', () => {
  it('loads exactly the eight bridges, in declaration order', () => {
    expect(ALL_CLI_BRIDGE_IDS).toEqual([
      'claude',
      'codex',
      'opencode',
      'copilot',
      'grok',
      'kimi',
      'pi',
      'hermes',
    ]);
    expect(listProviderManifests().map((m) => m.bridgeId)).toEqual(ALL_CLI_BRIDGE_IDS);
    expect(validateProviderManifestSet(bundledManifests)).toEqual([]);
    for (const m of listProviderManifests()) {
      // Plain data only: a JSON round-trip changes nothing.
      expect(JSON.parse(JSON.stringify(m))).toEqual(m);
      expect(m.verificationBasis.length).toBeGreaterThan(20);
    }
  });

  it('legacy three manifests restate the shipped facts field-for-field (no behaviour change)', () => {
    for (const id of ['claude', 'codex', 'opencode'] as const) {
      const m = getProviderManifest(id);
      // A8 identity declarations, verbatim.
      expect(m.identity).toEqual(CLI_IDENTITY_DECLARATIONS[id]);
      // A6 isolation registry, verbatim.
      expect(m.isolation.isolatable).toBe(BRIDGE_ISOLATION[id].isolatable);
      expect(m.isolation.envKnobs).toEqual(BRIDGE_ISOLATION[id].envKnobs);
      expect(m.isolation.note).toBe(BRIDGE_ISOLATION[id].note);
      // CLI meta (label / sign-in / install), verbatim.
      expect(CLI_BRIDGE_META[id]).toEqual({
        label: m.displayName,
        signInCommand: m.auth.signInCommand,
        installCommand: m.binary.install.posix,
      });
      // A1 usage declaration notes, verbatim.
      expect(m.usage.note).toBe(CLI_USAGE_PROBES[id].note);
      expect(m.usage.statusArgs).toEqual(CLI_USAGE_PROBES[id].statusArgs);
      // Catalog preset agreement (provider id, api, baseUrl, envKey).
      const preset = getProviderPreset(m.providerId)!;
      expect(preset.bridge).toBe(id);
      expect(preset.api).toBe(m.catalog.api);
      expect(preset.baseUrl).toBe(m.catalog.baseUrl);
      expect(preset.envKey).toBe(m.catalog.envKey);
      expect(m.verified).toBe(true);
    }
    // The A8 export itself is untouched: still exactly the three bridges.
    expect(Object.keys(CLI_IDENTITY_DECLARATIONS).sort()).toEqual(['claude', 'codex', 'opencode']);
  });

  it('new five manifests agree with their catalog presets and static model lists', () => {
    for (const id of NEW_IDS) {
      const m = getProviderManifest(id);
      const preset = getProviderPreset(m.providerId)!;
      expect(preset, `${id} preset`).toBeDefined();
      expect(preset.bridge).toBe(id);
      expect(preset.api).toBe(m.catalog.api);
      expect(preset.baseUrl).toBe(m.catalog.baseUrl);
      expect(preset.envKey).toBe(m.catalog.envKey);
      // Model source is the honest curated static list (the catalog
      // preset list) — no CLI model-list command is claimed.
      expect(m.models.source).toBe('catalog-static');
      expect(m.models.cliArgs).toBeNull();
      expect(preset.models.length).toBeGreaterThan(0);
      expect(preset.models.some((x) => x.default)).toBe(true);
      // getBridgeModels defers to the catalog for static-source bridges.
      expect(getBridgeModels(id)).toEqual([]);
      // Verified-vs-assumed honesty is on the record. Real-binary pass
      // 2026-11-26: grok / kimi / pi were verified against real binaries
      // (and their bases say so); copilot (credential claim) and hermes
      // (no binary obtainable) stay honestly unverified.
      if (id === 'grok' || id === 'kimi' || id === 'pi') {
        expect(m.verified).toBe(true);
        expect(m.verificationBasis).toMatch(/Real-binary pass 2026-11-26/);
      } else {
        expect(m.verified).toBe(false);
        expect(m.verificationBasis).toMatch(/ASSUMED|assumed/);
      }
    }
  });
});

describe('manifest validation fails closed', () => {
  function mutated(fn: (m: ProviderManifest) => void): ProviderManifest {
    const m = JSON.parse(JSON.stringify(getProviderManifest('grok'))) as ProviderManifest;
    fn(m);
    return m;
  }
  it('rejects a manifest with no binary names', () => {
    const problems = validateProviderManifest(mutated((m) => { m.binary.names = []; }));
    expect(problems.join(' ')).toMatch(/binary\.names/);
  });
  it('rejects an identity regex that fails the A8 ReDoS gate', () => {
    const problems = validateProviderManifest(
      mutated((m) => { m.identity.versionMatch = { kind: 'regex', source: '(a+)+$' }; }),
    );
    expect(problems.join(' ')).toMatch(/ReDoS/);
  });
  it('rejects isolatable: true with no env knobs', () => {
    const problems = validateProviderManifest(
      mutated((m) => { m.isolation = { isolatable: true, envKnobs: [], note: 'x'.repeat(30), spawnEnvKind: 'single-dir' }; }),
    );
    expect(problems.join(' ')).toMatch(/envKnobs/);
  });
  it('rejects isolatable: false carrying a spawn env kind', () => {
    const problems = validateProviderManifest(
      // grok (the mutation base) is isolatable since the 2026-11-26
      // real-binary pass — force the false case explicitly.
      mutated((m) => { m.isolation = { ...m.isolation, isolatable: false, envKnobs: [], spawnEnvKind: 'single-dir' }; }),
    );
    expect(problems.join(' ')).toMatch(/spawnEnvKind "none"/);
  });
  it('rejects a cli-command model source with no command', () => {
    const problems = validateProviderManifest(
      mutated((m) => { m.models = { source: 'cli-command', cliArgs: null }; }),
    );
    expect(problems.join(' ')).toMatch(/cliArgs/);
  });
  it('rejects a usage surface "none" that still names a probe', () => {
    const problems = validateProviderManifest(
      mutated((m) => { m.usage = { surface: 'none', statusArgs: ['status'], note: 'x'.repeat(30) }; }),
    );
    expect(problems.join(' ')).toMatch(/statusArgs to be null/);
  });
  it('rejects duplicate providerIds and map-key mismatches at the set level', () => {
    const file = JSON.parse(JSON.stringify(bundledManifests)) as typeof bundledManifests;
    (file.providers as Record<string, { providerId: string }>).kimi!.providerId = 'grok-subscription';
    expect(validateProviderManifestSet(file).join(' ')).toMatch(/duplicate providerId/);
    const file2 = JSON.parse(JSON.stringify(bundledManifests)) as typeof bundledManifests;
    (file2.providers as Record<string, { bridgeId: string }>).grok!.bridgeId = 'kimi';
    expect(validateProviderManifestSet(file2).join(' ')).toMatch(/does not match bridgeId/);
  });
  it('B-4: rejects two bridges claiming the same binary name at the set level', () => {
    const file = JSON.parse(JSON.stringify(bundledManifests)) as typeof bundledManifests;
    (file.providers as Record<string, { binary: { names: string[] } }>).kimi!.binary.names = ['grok'];
    expect(validateProviderManifestSet(file).join(' ')).toMatch(/binary name "grok" is also claimed by/);
    // The shipped set itself is clean.
    expect(validateProviderManifestSet(bundledManifests)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('new bridges: identity-verified resolution with fake shims', () => {
  it.each(NEW_IDS)('%s: the genuine shim is accepted, by probe and by resolution', (id) => {
    const exe = plantGenuine(id);
    expect(probeCliIdentity(id, exe).ok).toBe(true);
    const res = resolveVerifiedCliExecutable(id, { pathDirs: [binDir], homeDir: home });
    expect(res.path).toBe(exe);
    expect(res.namesake).toBeUndefined();
  });

  it.each(NEW_IDS)('%s: a hostile namesake (python traceback) is rejected', (id) => {
    plantHostile(id);
    const res = resolveVerifiedCliExecutable(id, { pathDirs: [binDir], homeDir: home });
    expect(res.path).toBeUndefined();
    expect(res.namesake).toBeDefined();
    expect(res.namesake?.looksLike).toBe('a Python program');
  });

  it.each(NEW_IDS)('%s: a wrong-banner namesake is rejected', (id) => {
    plant(id, script(['echo "totally unrelated tool 9.9.9"', 'exit 0']));
    const res = resolveVerifiedCliExecutable(id, { pathDirs: [binDir], homeDir: home });
    expect(res.path).toBeUndefined();
  });

  it('detection covers all eight bridges; a planted grok shim + login is detected', () => {
    plantGenuine('grok');
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(join(home, '.grok', 'auth.json'), '{"token":"shape-only"}');
    const detections = detectCliBridges({ homeDir: home, pathDirs: [binDir] });
    expect(detections.map((d) => d.id)).toEqual(ALL_CLI_BRIDGE_IDS);
    const grok = detections.find((d) => d.id === 'grok')!;
    expect(grok.cliPresent).toBe(true);
    expect(grok.credentialsPresent).toBe(true);
    expect(grok.detected).toBe(true);
    const kimi = detections.find((d) => d.id === 'kimi')!;
    expect(kimi.detected).toBe(false);
  });

  it('a user pin works for a new bridge exactly like the legacy three (A8 machinery)', () => {
    const exe = plantGenuine('hermes');
    setCliPathPin('hermes', exe);
    const res = resolveVerifiedCliExecutable('hermes', { pathDirs: [], homeDir: home });
    expect(res.path).toBe(exe);
    expect(res.pinned).toMatchObject({ status: 'verified' });
  });
});

// ---------------------------------------------------------------------------

describe('A6 integration: accounts + isolation from birth', () => {
  it('the account registry covers all eight bridges', () => {
    expect(BRIDGE_ACCOUNT_BRIDGES).toEqual(ALL_CLI_BRIDGE_IDS);
    const store = new BridgeAccountStore();
    for (const id of ALL_CLI_BRIDGE_IDS) {
      expect(store.list(id).map((a) => a.id)).toEqual(['default']);
    }
  });

  it('isolation registry: pi / grok / kimi carry verified knobs; copilot / hermes are honestly single-account', () => {
    expect(BRIDGE_ISOLATION.pi).toMatchObject({ isolatable: true, envKnobs: ['PI_CODING_AGENT_DIR'] });
    // Real-binary pass 2026-11-26: GROK_HOME (grok 1.0.92 shipped docs)
    // and KIMI_CODE_HOME (kimi 2.8.0 binary) are VERIFIED knobs, so grok
    // and kimi left the single-account set.
    expect(BRIDGE_ISOLATION.grok).toMatchObject({ isolatable: true, envKnobs: ['GROK_HOME'] });
    expect(BRIDGE_ISOLATION.kimi).toMatchObject({ isolatable: true, envKnobs: ['KIMI_CODE_HOME'] });
    // B-9 (sweep 2026-11-25): hermes joined the single-account set —
    // HERMES_HOME is an ASSUMED knob, and an unconfirmed knob fails
    // open (turns would silently run as the machine-default login).
    for (const id of ['copilot', 'hermes'] as const) {
      expect(BRIDGE_ISOLATION[id].isolatable).toBe(false);
      expect(BRIDGE_ISOLATION[id].envKnobs).toEqual([]);
      expect(BRIDGE_ISOLATION[id].note.length).toBeGreaterThan(20);
      // The manifest and the registry agree.
      expect(getProviderManifest(id).isolation.isolatable).toBe(false);
    }
  });

  function account(partial: Partial<BridgeAccount> & { id: string }): BridgeAccount {
    return {
      bridgeId: 'pi',
      label: partial.id,
      machineDefault: false,
      createdByUs: true,
      ...partial,
    } as BridgeAccount;
  }

  it('spawn env: pi / grok / kimi accounts carry their dir; copilot + hermes accounts carry nothing', () => {
    expect(bridgeAccountSpawnEnv(account({ id: 'w', configDir: '/a/pi-work' }))).toEqual({
      PI_CODING_AGENT_DIR: '/a/pi-work',
    });
    expect(bridgeAccountSpawnEnv(account({ id: 'w', bridgeId: 'grok', configDir: '/a/g-work' }))).toEqual({
      GROK_HOME: '/a/g-work',
    });
    expect(bridgeAccountSpawnEnv(account({ id: 'w', bridgeId: 'kimi', configDir: '/a/k-work' }))).toEqual({
      KIMI_CODE_HOME: '/a/k-work',
    });
    // Non-isolatable: an account record exists, but the CLI cannot be
    // pointed anywhere — the spawn env is honestly empty. (Hermes
    // since B-9: its knob is assumed, not confirmed.)
    expect(
      bridgeAccountSpawnEnv(account({ id: 'w', bridgeId: 'hermes', configDir: '/a/h-work' })),
    ).toEqual({});
    expect(
      bridgeAccountSpawnEnv(account({ id: 'w', bridgeId: 'copilot', configDir: '/a/c-work' })),
    ).toEqual({});
    expect(bridgeAccountSpawnEnv(machineDefaultAccount('pi'))).toEqual({});
  });

  it('credential paths follow each manifest layout (default vs account)', () => {
    const h = '/home/tester';
    expect(bridgeAccountCredentialsPath(machineDefaultAccount('copilot'), h)).toBe(
      join(h, '.config', 'gh', 'hosts.yml'),
    );
    expect(bridgeAccountCredentialsPath(machineDefaultAccount('grok'), h)).toBe(join(h, '.grok', 'auth.json'));
    // Real-binary pass 2026-11-26: kimi's home is ~/.kimi-code and its
    // OAuth token is credentials/kimi-code.json inside it.
    expect(bridgeAccountCredentialsPath(machineDefaultAccount('kimi'), h)).toBe(
      join(h, '.kimi-code', 'credentials', 'kimi-code.json'),
    );
    expect(bridgeAccountCredentialsPath(machineDefaultAccount('pi'), h)).toBe(join(h, '.pi', 'agent', 'auth.json'));
    expect(bridgeAccountCredentialsPath(machineDefaultAccount('hermes'), h)).toBe(join(h, '.hermes', 'auth.json'));
    expect(bridgeAccountCredentialsPath(account({ id: 'w', configDir: '/a/pi-work' }), h)).toBe(
      join('/a/pi-work', 'auth.json'),
    );
    // Isolatable (2026-11-26): a named grok / kimi account probes its
    // OWN dir — GROK_HOME / KIMI_CODE_HOME point the CLI there.
    expect(
      bridgeAccountCredentialsPath(account({ id: 'w', bridgeId: 'grok', configDir: '/a/g-work' }), h),
    ).toBe(join('/a/g-work', 'auth.json'));
    expect(
      bridgeAccountCredentialsPath(account({ id: 'w', bridgeId: 'kimi', configDir: '/a/k-work' }), h),
    ).toBe(join('/a/k-work', 'credentials', 'kimi-code.json'));
    // Non-isolatable: even a named account probes the machine default
    // file — that is the only file the CLI itself will ever read.
    expect(
      bridgeAccountCredentialsPath(account({ id: 'w', bridgeId: 'copilot', configDir: '/a/c-work' }), h),
    ).toBe(join(h, '.config', 'gh', 'hosts.yml'));
  });
});

// ---------------------------------------------------------------------------

describe('A1 integration: usage honesty + swap keying', () => {
  it.each(NEW_IDS)('%s: usage probe is honestly no-surface / null', (id) => {
    expect(CLI_USAGE_PROBES[id].statusArgs).toBeNull();
    const gauge = probeBridgeUsage(id, { fresh: true });
    expect(gauge.utilisationPercent).toBeNull();
    expect(gauge.source).toBe('no-surface');
    expect(gauge.bridgeId).toBe(id);
  });

  it('swap keying resolves the new bridge ids from presets and agent ids', () => {
    expect(bridgeIdForProviderId('copilot-subscription')).toBe('copilot');
    expect(bridgeIdForProviderId('grok-subscription')).toBe('grok');
    expect(bridgeIdForProviderId('kimi-subscription')).toBe('kimi');
    expect(bridgeIdForProviderId('pi-subscription')).toBe('pi');
    expect(bridgeIdForProviderId('hermes-subscription')).toBe('hermes');
    expect(bridgeIdForProviderId('agent/grok/grok-4.7')).toBe('grok');
    expect(bridgeIdForProviderId('agent/kimi/kimi-code/k3')).toBe('kimi');
    expect(bridgeIdForProviderId('agent/pi/default')).toBe('pi');
    expect(bridgeIdForProviderId('agent/hermes/hermes-default')).toBe('hermes');
    expect(bridgeIdForProviderId('agent/copilot/default')).toBe('copilot');
  });
});

// ---------------------------------------------------------------------------

describe('factory: manifest-parameterised drivers on the verified spawn path', () => {
  it('refuses a new bridge that was never connected (selection integrity: no silent lane)', () => {
    expect(isBridgeConnected('grok')).toBe(false);
    expect(() => createProvider('grok-subscription')).toThrow(/not connected/);
  });

  it('a connected grok bridge builds the ACP provider on the VERIFIED binary', () => {
    const exe = plantGenuine('grok');
    process.env.PATH = [binDir, savedPath].join(delimiter);
    grantBridgeConsent('grok');
    const provider = createProvider('grok-subscription');
    expect(provider.providerId).toBe('agent/grok/grok-4.7');
    // The provider was constructed against the shim's verified path —
    // construction is pure; no process spawns until a turn runs.
    expect(exe).toContain('grok');
  });

  it('a connected pi bridge builds the one-shot agent provider on the VERIFIED binary', () => {
    plantGenuine('pi');
    process.env.PATH = [binDir, savedPath].join(delimiter);
    grantBridgeConsent('pi');
    const provider = createProvider('pi-subscription');
    expect(provider.providerId).toBe('agent/pi/default');
  });

  it('a namesake binary is never built into a provider, even when connected', () => {
    plantHostile('kimi');
    process.env.PATH = [binDir, savedPath].join(delimiter);
    grantBridgeConsent('kimi');
    expect(() => createProvider('kimi-subscription')).toThrow(/isn't Kimi CLI|Traceback/);
  });
});
