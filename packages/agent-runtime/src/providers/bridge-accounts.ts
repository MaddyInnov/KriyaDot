// SPDX-License-Identifier: Apache-2.0
// Multiple sign-ins per CLI bridge (Timon parity A6).
//
// Why this module exists
// ----------------------
// A1 modelled every bridge state key (usage gauge, cooldown) by
// (bridgeId, accountId) but only the machine-default account existed.
// A6 makes accounts real for ALL bridges: a bridge can have N accounts,
// each a stable id + a human label + its OWN config directory for the
// vendor CLI. Two bots can run on two different logins of the same CLI
// on one machine, and one account's quota death never blocks its sibling.
//
// Reasoning / design decisions
// ----------------------------
// - An account record is a LABEL + a DIRECTORY PATH + two flags. Nothing
//   else is stored, listed, or returned — no token bytes, no credential
//   file contents. The config dirs are the CLIs' own; KriyaDot never
//   reads credential files except through cli-bridge's consent-gated,
//   memory-only token loaders and boolean shape probes.
// - The machine-default account (id 'default') is NOT a record we own:
//   it has no config-dir override, so the CLI resolves its own default
//   location exactly as it did before A6 — existing users see zero
//   change. It cannot be removed or renamed away (its label is fixed
//   copy in the UI layer, and the store refuses removal).
// - Per-CLI isolation knobs (investigated 2026-11-12 against each CLI's
//   documented environment surface — behaviour only, clean-room):
//   * Claude Code: CLAUDE_CONFIG_DIR points the CLI at a whole config
//     dir; credentials live at <dir>/.credentials.json. One var, full
//     isolation. (The ENGINES-pack claude-accounts.ts profiles already
//     used this; A6 generalises the model to every bridge.)
//   * Codex: CODEX_HOME points the CLI at a whole home dir; the login
//     lives at <dir>/auth.json. One var, full isolation.
//   * OpenCode: split layout — config under XDG_CONFIG_HOME/opencode
//     (OPENCODE_CONFIG_DIR can point at that config dir directly, but
//     it does NOT move credentials), while the login lives in the DATA
//     dir at XDG_DATA_HOME/opencode/auth.json. Full isolation therefore
//     needs the XDG family: XDG_CONFIG_HOME, XDG_DATA_HOME,
//     XDG_STATE_HOME, XDG_CACHE_HOME pointed at per-account subdirs,
//     plus OPENCODE_CONFIG_DIR for the config dir itself. An account's
//     `configDir` for OpenCode is the account ROOT; the subdirs hang
//     off it (config/, data/, state/, cache/).
//   All three bridges are isolatable, so no bridge is modelled
//   single-account today — but the capability table carries an explicit
//   `isolatable` flag + reason so a future CLI without a knob is
//   modelled honestly as single-account instead of pretending.
// - Selection precedence (per turn, per bridge): the bot's configured
//   account for that bridge (BotConfig.bridgeAccounts, with the legacy
//   Claude-only BotConfig.accountProfile honoured for claude) → the
//   user's default account choice for the bridge (store-level, set in
//   the Providers UI) → the machine default. An unknown bot-named id
//   falls back DOWN the chain rather than failing the turn — the same
//   rule claude-accounts.ts set for profiles.
// - Account removal semantics (explicit, mirrored in UI copy): removing
//   an account deletes OUR registry entry. The account's config dir is
//   deleted ONLY when the caller explicitly asks AND the dir is one we
//   created under our managed root (<dataDir>/bridge-accounts/…) — a
//   user-supplied external dir is never deleted by us. The machine
//   default account can never be removed.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { BotConfig } from '../types.js';
import {
  bridgeHasUsableTokenAtPath,
  type CliBridgeId,
} from './cli-bridge.js';
import { DEFAULT_BRIDGE_ACCOUNT_ID } from './cli-usage.js';

/** The bridge ids that carry subscription accounts. */
/**
 * Every bridge that carries subscription accounts: the original three
 * plus the five A2 manifest-first bridges (multi-account from birth —
 * a bridge whose CLI has no isolation knob is still registered here and
 * modelled honestly via BRIDGE_ISOLATION's isolatable: false).
 */
export const BRIDGE_ACCOUNT_BRIDGES: CliBridgeId[] = [
  'claude',
  'codex',
  'opencode',
  'copilot',
  'grok',
  'kimi',
  'pi',
  'hermes',
];

export function isBridgeAccountBridge(v: unknown): v is CliBridgeId {
  return typeof v === 'string' && (BRIDGE_ACCOUNT_BRIDGES as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Per-CLI isolation capability (declared data).
// ---------------------------------------------------------------------------

export interface BridgeIsolationSpec {
  bridgeId: CliBridgeId;
  /** False → this bridge is honestly modelled as single-account. */
  isolatable: boolean;
  /** The env knobs that carry the isolation (empty when not isolatable). */
  envKnobs: string[];
  /** Plain-words explanation surfaced in logs/UI when relevant. */
  note: string;
}

export const BRIDGE_ISOLATION: Record<CliBridgeId, BridgeIsolationSpec> = {
  claude: {
    bridgeId: 'claude',
    isolatable: true,
    envKnobs: ['CLAUDE_CONFIG_DIR'],
    note: 'CLAUDE_CONFIG_DIR points Claude Code at a per-account config dir (credentials at <dir>/.credentials.json).',
  },
  codex: {
    bridgeId: 'codex',
    isolatable: true,
    envKnobs: ['CODEX_HOME'],
    note: 'CODEX_HOME points the Codex CLI at a per-account home dir (login at <dir>/auth.json).',
  },
  opencode: {
    bridgeId: 'opencode',
    isolatable: true,
    envKnobs: ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'OPENCODE_CONFIG_DIR'],
    note:
      'OpenCode splits config and data: OPENCODE_CONFIG_DIR moves config only, NOT the login — ' +
      'the login (auth.json) follows XDG_DATA_HOME, so isolation sets the whole XDG family at per-account subdirs.',
  },
  // A2 bridges (declared in their provider manifests; kept field-equal
  // by the A2 tests). copilot / grok / kimi document no per-account
  // config-dir knob, so they are honestly single-account: accounts may
  // be registered, but spawns carry no override and every account
  // resolves to the machine's one login for that CLI.
  copilot: {
    bridgeId: 'copilot',
    isolatable: false,
    envKnobs: [],
    note:
      'GitHub Copilot CLI documents no per-account config-dir knob: it shares the GitHub CLI login ' +
      '(~/.config/gh/hosts.yml) machine-wide. Modelled honestly as single-account.',
  },
  grok: {
    bridgeId: 'grok',
    isolatable: false,
    envKnobs: [],
    note:
      'No per-account config-dir environment knob is verified for the Grok Build CLI (login under ~/.grok). ' +
      'Modelled honestly as single-account until xAI documents one.',
  },
  kimi: {
    bridgeId: 'kimi',
    isolatable: false,
    envKnobs: [],
    note:
      'No per-account config-dir environment knob is verified for the Kimi Code CLI (login under ~/.kimi). ' +
      'Modelled honestly as single-account until Moonshot documents one.',
  },
  pi: {
    bridgeId: 'pi',
    isolatable: true,
    envKnobs: ['PI_CODING_AGENT_DIR'],
    note: 'PI_CODING_AGENT_DIR points Pi at a per-account agent dir (credentials at <dir>/auth.json).',
  },
  hermes: {
    bridgeId: 'hermes',
    isolatable: true,
    envKnobs: ['HERMES_HOME'],
    note:
      'HERMES_HOME points Hermes at a per-account home dir (assumed knob — see the hermes manifest ' +
      'verificationBasis); the machine default is ~/.hermes.',
  },
};

// ---------------------------------------------------------------------------
// Account model.
// ---------------------------------------------------------------------------

export interface BridgeAccount {
  /** Stable account id (slug); 'default' is the machine default. */
  id: string;
  bridgeId: CliBridgeId;
  /** Human label shown in pickers, e.g. "Work login". */
  label: string;
  /**
   * The account's config dir for the vendor CLI (see BRIDGE_ISOLATION
   * for the per-bridge layout). Absent ONLY for the machine-default
   * account, which uses the CLI's own default location.
   */
  configDir?: string;
  /** True for the machine's existing sign-in (no override, unremovable). */
  machineDefault: boolean;
  /** True when KriyaDot created this dir under its managed root. */
  createdByUs: boolean;
}

const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The machine-default account for a bridge (synthesised, never stored). */
export function machineDefaultAccount(bridgeId: CliBridgeId): BridgeAccount {
  return {
    id: DEFAULT_BRIDGE_ACCOUNT_ID,
    bridgeId,
    label: 'Machine default',
    machineDefault: true,
    createdByUs: false,
  };
}

/**
 * Validate + normalise a non-default account record (throws with a
 * readable reason). `managedRoot` is <dataDir>/bridge-accounts; a
 * configDir inside it marks the account as created-by-us (removal may
 * delete the dir), a dir anywhere else is user-supplied (never deleted).
 */
export function validateBridgeAccount(
  input: unknown,
  opts: { managedRoot?: string; homeDir?: string } = {},
): BridgeAccount {
  if (typeof input !== 'object' || input === null) throw new Error('account must be an object');
  const o = input as Record<string, unknown>;
  if (!isBridgeAccountBridge(o.bridgeId)) {
    throw new Error(`invalid bridge "${String(o.bridgeId)}" (expected one of ${BRIDGE_ACCOUNT_BRIDGES.join(', ')})`);
  }
  const bridgeId = o.bridgeId;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!ACCOUNT_ID_RE.test(id)) throw new Error(`invalid account id "${id}" (lowercase slug required)`);
  if (id === DEFAULT_BRIDGE_ACCOUNT_ID) {
    throw new Error('the machine-default account is built in and cannot be created or edited');
  }
  const label = typeof o.label === 'string' ? o.label.trim().slice(0, 80) : '';
  if (!label) throw new Error('account label is required');
  const homeDir = opts.homeDir ?? homedir();
  const rawDir = typeof o.configDir === 'string' ? o.configDir.trim() : '';
  if (!rawDir) throw new Error('account configDir is required for a non-default account');
  const configDir = isAbsolute(rawDir) ? resolve(rawDir) : resolve(join(homeDir, rawDir));
  const createdByUs =
    opts.managedRoot !== undefined &&
    (configDir === resolve(opts.managedRoot) || configDir.startsWith(resolve(opts.managedRoot) + sep));
  return { id, bridgeId, label, configDir, machineDefault: false, createdByUs };
}

/** The managed root under which KriyaDot creates account config dirs. */
export function bridgeAccountsManagedRoot(dataDir: string): string {
  return join(dataDir, 'bridge-accounts');
}

/** The config dir KriyaDot creates for a new account of a bridge. */
export function managedAccountConfigDir(dataDir: string, bridgeId: CliBridgeId, accountId: string): string {
  return join(bridgeAccountsManagedRoot(dataDir), bridgeId, accountId);
}

// ---------------------------------------------------------------------------
// Spawn env + credential path per account.
// ---------------------------------------------------------------------------

/**
 * Env overrides for spawning the bridge CLI under an account. The
 * machine-default account returns {} — the child inherits the process
 * env untouched, exactly as before A6.
 */
export function bridgeAccountSpawnEnv(account: BridgeAccount): Record<string, string> {
  if (account.machineDefault || !account.configDir) return {};
  const dir = account.configDir;
  // A2: a bridge with no isolation knob spawns with NO override — the
  // CLI always uses the machine's one login, whatever account record
  // the turn resolved to (BRIDGE_ISOLATION carries the honest note).
  if (!BRIDGE_ISOLATION[account.bridgeId].isolatable) return {};
  switch (account.bridgeId) {
    case 'claude':
      return { CLAUDE_CONFIG_DIR: dir };
    case 'codex':
      return { CODEX_HOME: dir };
    case 'pi':
      return { PI_CODING_AGENT_DIR: dir };
    case 'hermes':
      return { HERMES_HOME: dir };
    case 'opencode':
      return {
        XDG_CONFIG_HOME: join(dir, 'config'),
        XDG_DATA_HOME: join(dir, 'data'),
        XDG_STATE_HOME: join(dir, 'state'),
        XDG_CACHE_HOME: join(dir, 'cache'),
        OPENCODE_CONFIG_DIR: join(dir, 'config', 'opencode'),
      };
    case 'copilot':
    case 'grok':
    case 'kimi':
      return {}; // unreachable: non-isolatable bridges returned above
  }
}

/**
 * The account's credential file path (existence/shape probing only —
 * callers must never read credential contents out of this module's
 * consumers). For the machine default this is the CLI's own location
 * under the machine home.
 */
export function bridgeAccountCredentialsPath(account: BridgeAccount, homeDir: string = homedir()): string {
  if (account.machineDefault || !account.configDir) {
    switch (account.bridgeId) {
      case 'claude':
        return join(homeDir, '.claude', '.credentials.json');
      case 'codex':
        return join(homeDir, '.codex', 'auth.json');
      case 'opencode':
        return join(homeDir, '.local', 'share', 'opencode', 'auth.json');
      case 'copilot':
        return join(homeDir, '.config', 'gh', 'hosts.yml');
      case 'grok':
        return join(homeDir, '.grok', 'auth.json');
      case 'kimi':
        return join(homeDir, '.kimi', 'credentials.json');
      case 'pi':
        return join(homeDir, '.pi', 'agent', 'auth.json');
      case 'hermes':
        return join(homeDir, '.hermes', 'auth.json');
    }
  }
  // A2: a non-isolatable bridge's CLI can only ever read the machine
  // default location — probing an account dir would report a sign-in
  // the CLI itself will never use.
  if (!BRIDGE_ISOLATION[account.bridgeId].isolatable) {
    return bridgeAccountCredentialsPath({ ...account, machineDefault: true, configDir: undefined }, homeDir);
  }
  const dir = account.configDir;
  switch (account.bridgeId) {
    case 'claude':
      return join(dir, '.credentials.json');
    case 'codex':
      return join(dir, 'auth.json');
    case 'opencode':
      return join(dir, 'data', 'opencode', 'auth.json');
    case 'pi':
      return join(dir, 'auth.json');
    case 'hermes':
      return join(dir, 'auth.json');
    case 'copilot':
    case 'grok':
    case 'kimi':
      // Unreachable (non-isolatable handled above); kept for exhaustiveness.
      return join(dir, 'auth.json');
  }
}

/**
 * Sign-in state for one account, detected independently per account:
 * the account's OWN credential file shape (boolean only — token bytes
 * never leave cli-bridge). Two accounts of the same bridge are probed
 * against two different files, so one being signed in says nothing
 * about the other.
 */
export function bridgeAccountSignedIn(account: BridgeAccount, homeDir: string = homedir()): boolean {
  return bridgeHasUsableTokenAtPath(account.bridgeId, bridgeAccountCredentialsPath(account, homeDir));
}

/** Public view of an account for APIs/UI: label + path + flags only. */
export function publicBridgeAccount(account: BridgeAccount): {
  accountId: string;
  bridgeId: CliBridgeId;
  label: string;
  configDir: string | null;
  machineDefault: boolean;
  createdByUs: boolean;
} {
  return {
    accountId: account.id,
    bridgeId: account.bridgeId,
    label: account.label,
    configDir: account.configDir ?? null,
    machineDefault: account.machineDefault,
    createdByUs: account.createdByUs,
  };
}

// ---------------------------------------------------------------------------
// Store: accounts per bridge + the user's default choice per bridge.
// The machine-default account is implicit (always present, never stored).
// ---------------------------------------------------------------------------

export interface BridgeAccountStoreData {
  accounts: BridgeAccount[];
  /** bridgeId → account id the user picked as their default (absent = machine default). */
  userDefaults: Partial<Record<CliBridgeId, string>>;
}

export class BridgeAccountStore {
  private readonly accounts = new Map<string, BridgeAccount>();
  private readonly userDefaults = new Map<CliBridgeId, string>();

  constructor(data?: BridgeAccountStoreData) {
    for (const a of data?.accounts ?? []) {
      if (!a.machineDefault) this.accounts.set(`${a.bridgeId}:${a.id}`, a);
    }
    for (const [bridgeId, accountId] of Object.entries(data?.userDefaults ?? {})) {
      if (isBridgeAccountBridge(bridgeId) && typeof accountId === 'string') {
        this.userDefaults.set(bridgeId, accountId);
      }
    }
  }

  /** All accounts of one bridge, machine default first, then by label. */
  list(bridgeId: CliBridgeId): BridgeAccount[] {
    const rest = [...this.accounts.values()]
      .filter((a) => a.bridgeId === bridgeId)
      .sort((a, b) => a.label.localeCompare(b.label));
    return [machineDefaultAccount(bridgeId), ...rest];
  }

  /** Every stored (non-default) account across bridges. */
  listStored(): BridgeAccount[] {
    return [...this.accounts.values()].sort(
      (a, b) => a.bridgeId.localeCompare(b.bridgeId) || a.label.localeCompare(b.label),
    );
  }

  get(bridgeId: CliBridgeId, accountId: string): BridgeAccount | undefined {
    if (accountId === DEFAULT_BRIDGE_ACCOUNT_ID) return machineDefaultAccount(bridgeId);
    return this.accounts.get(`${bridgeId}:${accountId}`);
  }

  /** Create or replace a non-default account (validated by the caller). */
  upsert(account: BridgeAccount): BridgeAccount {
    if (account.machineDefault || account.id === DEFAULT_BRIDGE_ACCOUNT_ID) {
      throw new Error('the machine-default account cannot be stored or edited');
    }
    this.accounts.set(`${account.bridgeId}:${account.id}`, account);
    return account;
  }

  /** Rename a non-default account. Throws when it does not exist. */
  rename(bridgeId: CliBridgeId, accountId: string, label: string): BridgeAccount {
    const clean = typeof label === 'string' ? label.trim().slice(0, 80) : '';
    if (!clean) throw new Error('account label is required');
    const existing = this.get(bridgeId, accountId);
    if (!existing || existing.machineDefault) {
      throw new Error(
        accountId === DEFAULT_BRIDGE_ACCOUNT_ID
          ? 'the machine-default account cannot be renamed'
          : `no account "${accountId}" for bridge "${bridgeId}"`,
      );
    }
    const updated = { ...existing, label: clean };
    this.accounts.set(`${bridgeId}:${accountId}`, updated);
    return updated;
  }

  /**
   * Remove an account's registry entry. The machine-default account is
   * UNREMOVABLE (throws). Returns the removed account so the caller can
   * apply the config-dir policy (delete only when createdByUs AND the
   * caller explicitly asked). Also clears a user-default pointing at it.
   */
  remove(bridgeId: CliBridgeId, accountId: string): BridgeAccount {
    if (accountId === DEFAULT_BRIDGE_ACCOUNT_ID) {
      throw new Error('the machine-default account cannot be removed');
    }
    const existing = this.accounts.get(`${bridgeId}:${accountId}`);
    if (!existing) throw new Error(`no account "${accountId}" for bridge "${bridgeId}"`);
    this.accounts.delete(`${bridgeId}:${accountId}`);
    if (this.userDefaults.get(bridgeId) === accountId) this.userDefaults.delete(bridgeId);
    return existing;
  }

  /** The user's default account choice for a bridge (undefined = machine default). */
  userDefaultId(bridgeId: CliBridgeId): string | undefined {
    const id = this.userDefaults.get(bridgeId);
    if (id === undefined) return undefined;
    // A stale choice (account removed) silently falls back to machine default.
    return this.get(bridgeId, id) ? id : undefined;
  }

  /** Set (or clear, with 'default'/undefined) the user's default account for a bridge. */
  setUserDefault(bridgeId: CliBridgeId, accountId: string | undefined): void {
    if (accountId === undefined || accountId === DEFAULT_BRIDGE_ACCOUNT_ID) {
      this.userDefaults.delete(bridgeId);
      return;
    }
    if (!this.get(bridgeId, accountId)) {
      throw new Error(`no account "${accountId}" for bridge "${bridgeId}"`);
    }
    this.userDefaults.set(bridgeId, accountId);
  }

  serialize(): BridgeAccountStoreData {
    return {
      accounts: this.listStored().map((a) => ({ ...a })),
      userDefaults: Object.fromEntries(this.userDefaults),
    };
  }
}

// ---------------------------------------------------------------------------
// Process-wide store (late binding, mirroring the cooldown registry):
// the API layer loads it from <dataDir>/bridge-accounts.json; the
// runtime and cli-auth routes read it from here.
// ---------------------------------------------------------------------------

let sharedStore: BridgeAccountStore | undefined;

export function getBridgeAccountStore(): BridgeAccountStore {
  if (!sharedStore) sharedStore = new BridgeAccountStore();
  return sharedStore;
}

/** Replace the process-wide store (API boot load / tests). */
export function setBridgeAccountStore(store: BridgeAccountStore): void {
  sharedStore = store;
}

/** Test helper: drop the process-wide store back to empty. */
export function resetBridgeAccountStore(): void {
  sharedStore = undefined;
}

// ---------------------------------------------------------------------------
// Selection: which account a bot's turn on a bridge runs under.
// ---------------------------------------------------------------------------

/** The account id a bot names for a bridge, if any (bridgeAccounts wins; legacy claude profile next). */
export function botConfiguredAccountId(
  bot: Pick<BotConfig, 'accountProfile' | 'bridgeAccounts'>,
  bridgeId: CliBridgeId,
): string | undefined {
  const perBridge = bot.bridgeAccounts?.[bridgeId];
  if (typeof perBridge === 'string' && perBridge.trim()) return perBridge.trim();
  // Legacy ENGINES-pack field: a Claude-only profile id.
  if (bridgeId === 'claude' && typeof bot.accountProfile === 'string' && bot.accountProfile.trim()) {
    return bot.accountProfile.trim();
  }
  return undefined;
}

/**
 * Resolve the account a turn runs under, by precedence:
 * bot's configured account → user's default choice → machine default.
 * Unknown ids fall DOWN the chain (never fail a turn over a stale pick).
 */
export function resolveBridgeAccount(
  bot: Pick<BotConfig, 'accountProfile' | 'bridgeAccounts'>,
  bridgeId: CliBridgeId,
  store: BridgeAccountStore = getBridgeAccountStore(),
): BridgeAccount {
  const botPick = botConfiguredAccountId(bot, bridgeId);
  if (botPick) {
    const found = store.get(bridgeId, botPick);
    if (found) return found;
  }
  const userDefault = store.userDefaultId(bridgeId);
  if (userDefault) {
    const found = store.get(bridgeId, userDefault);
    if (found) return found;
  }
  return machineDefaultAccount(bridgeId);
}

/** Account-id-only convenience over resolveBridgeAccount. */
export function resolveBridgeAccountId(
  bot: Pick<BotConfig, 'accountProfile' | 'bridgeAccounts'>,
  bridgeId: CliBridgeId,
  store: BridgeAccountStore = getBridgeAccountStore(),
): string {
  return resolveBridgeAccount(bot, bridgeId, store).id;
}

/** Spawn env for the account a bot's turn on a bridge resolves to ({} = machine default). */
export function bridgeSpawnEnvForBot(
  bot: Pick<BotConfig, 'accountProfile' | 'bridgeAccounts'>,
  bridgeId: CliBridgeId,
  store: BridgeAccountStore = getBridgeAccountStore(),
): Record<string, string> {
  return bridgeAccountSpawnEnv(resolveBridgeAccount(bot, bridgeId, store));
}

// ---------------------------------------------------------------------------
// Sibling accounts as swap candidates (A6 §3).
// ---------------------------------------------------------------------------

/** Minimal cooldown view (structural — cli-cooldown's registry satisfies it). */
export interface AccountCooldownView {
  check(bridgeId: CliBridgeId, accountId: string): { active: boolean };
}

/**
 * A healthy SIBLING account of the same bridge: a different account that
 * is not in active cooldown. One account's cooldown never blocks its
 * siblings — state is keyed per (bridge, account) since A1 — so on AUTO
 * lanes a quota death on account A may continue on sibling B of the SAME
 * bridge. Explicit selections never use this (selection integrity: the
 * caller gates on the lane; see cli-swap's decideBridgeSwap).
 * Half-open siblings count as healthy (the turn becomes their probe).
 */
export function findHealthySiblingAccount(
  store: BridgeAccountStore,
  cooldowns: AccountCooldownView,
  bridgeId: CliBridgeId,
  excludeAccountId: string,
): BridgeAccount | undefined {
  for (const account of store.list(bridgeId)) {
    if (account.id === excludeAccountId) continue;
    if (!cooldowns.check(bridgeId, account.id).active) return account;
  }
  return undefined;
}
