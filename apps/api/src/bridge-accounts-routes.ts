// SPDX-License-Identifier: Apache-2.0
// Bridge accounts API (Timon parity A6): multiple sign-ins per CLI bridge.
//
//   GET    /api/bridge-accounts                          → { ok, bridges: [...] } (labels + paths + flags ONLY)
//   POST   /api/bridge-accounts                          → add an account { bridgeId, label, configDir? }
//   PATCH  /api/bridge-accounts/:bridgeId/:accountId     → rename { label }
//   POST   /api/bridge-accounts/:bridgeId/:accountId/default → make it the user's default for the bridge
//   DELETE /api/bridge-accounts/:bridgeId/:accountId?deleteConfigDir=1 → remove (see semantics below)
//   GET    /api/bridge-accounts/resolve/:botId/:bridgeId → the account + spawn env a bot runs under
//
// Sign-in itself runs through the existing cli-auth flow
// (POST /api/cli-auth/:cliId/login with { accountId }) — the login child
// is spawned under the account's config-dir env, so signing into a
// second account never disturbs the first.
//
// HARD RULES:
// - Responses carry labels, paths and booleans only — never credential
//   file contents (sign-in state is a boolean shape probe).
// - The machine-default account ('default') is built in: it cannot be
//   created, renamed, or removed — it IS the machine's existing sign-in.
// - Removal deletes OUR registry entry. The account's config directory
//   is deleted ONLY when the caller passes deleteConfigDir=1 AND the
//   directory is one KriyaDot created under its managed root
//   (<dataDir>/bridge-accounts/…). A user-supplied external directory is
//   never deleted; the response says exactly what happened.
//
// Persistence: <dataDir>/bridge-accounts.json (the runtime's process-wide
// BridgeAccountStore is kept in sync on every load/save).
//
// HOST WIRING (index.ts):
//   app.use('/api', createBridgeAccountsRouter({ dataDir: config.dataDir, bots: seed.bots, audit }));

import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import {
  BRIDGE_ACCOUNT_BRIDGES,
  BRIDGE_ISOLATION,
  BridgeAccountStore,
  bridgeAccountCredentialsPath,
  bridgeAccountSignedIn,
  bridgeAccountSpawnEnv,
  bridgeAccountsManagedRoot,
  getBridgeAccountStore,
  isBridgeAccountBridge,
  managedAccountConfigDir,
  publicBridgeAccount,
  resolveBridgeAccount,
  setBridgeAccountStore,
  validateBridgeAccount,
  type BotConfig,
  type BridgeAccount,
  type CliBridgeId,
} from '@mvp/agent-runtime';

const ACCOUNTS_FILE = 'bridge-accounts.json';

export function bridgeAccountsPath(dataDir: string): string {
  return path.join(dataDir, ACCOUNTS_FILE);
}

/** Load the persisted store and make it the runtime's process-wide store. */
export function loadBridgeAccountStore(dataDir: string, homeDir?: string): BridgeAccountStore {
  let store = new BridgeAccountStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(bridgeAccountsPath(dataDir), 'utf8')) as {
      accounts?: unknown[];
      userDefaults?: Record<string, string>;
    };
    const accounts: BridgeAccount[] = [];
    for (const entry of parsed.accounts ?? []) {
      try {
        accounts.push(
          validateBridgeAccount(entry, { managedRoot: bridgeAccountsManagedRoot(dataDir), homeDir }),
        );
      } catch {
        // skip malformed stored entries — never fatal
      }
    }
    store = new BridgeAccountStore({ accounts, userDefaults: parsed.userDefaults ?? {} });
  } catch {
    // missing/corrupt file → empty store (machine defaults only)
  }
  setBridgeAccountStore(store);
  return store;
}

export function saveBridgeAccountStore(dataDir: string, store: BridgeAccountStore): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = bridgeAccountsPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store.serialize(), null, 2), 'utf8');
  fs.renameSync(tmp, file);
  setBridgeAccountStore(store);
}

/** Slugify a label into an account id base ('Work Login' → 'work-login'). */
function slugBase(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'account';
}

/** First free account id for a bridge: base, base-2, base-3, … */
function freeAccountId(store: BridgeAccountStore, bridgeId: CliBridgeId, label: string): string {
  const base = slugBase(label);
  if (!store.get(bridgeId, base)) return base;
  for (let n = 2; n < 1000; n++) {
    const id = `${base}-${n}`;
    if (!store.get(bridgeId, id)) return id;
  }
  throw new Error('could not allocate an account id');
}

export interface BridgeAccountsDeps {
  dataDir: string;
  bots?: readonly BotConfig[];
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  homeDir?: string;
}

function errorBody(message: string): Record<string, unknown> {
  return { ok: false, error: message };
}

export function createBridgeAccountsRouter(deps: BridgeAccountsDeps): Router {
  const router = express.Router();
  const managedRoot = bridgeAccountsManagedRoot(deps.dataDir);
  const load = (): BridgeAccountStore => loadBridgeAccountStore(deps.dataDir, deps.homeDir);

  const publicAccount = (store: BridgeAccountStore, account: BridgeAccount) => ({
    ...publicBridgeAccount(account),
    isUserDefault: store.userDefaultId(account.bridgeId) === account.id,
    signedIn: bridgeAccountSignedIn(account, deps.homeDir),
    credentialsPath: bridgeAccountCredentialsPath(account, deps.homeDir),
  });

  router.get('/bridge-accounts', (_req, res) => {
    const store = load();
    res.json({
      ok: true,
      bridges: BRIDGE_ACCOUNT_BRIDGES.map((bridgeId) => ({
        bridgeId,
        isolatable: BRIDGE_ISOLATION[bridgeId].isolatable,
        isolationNote: BRIDGE_ISOLATION[bridgeId].note,
        accounts: store.list(bridgeId).map((a) => publicAccount(store, a)),
      })),
    });
  });

  router.post('/bridge-accounts', (req, res) => {
    try {
      const body = (req.body ?? {}) as { bridgeId?: unknown; label?: unknown; configDir?: unknown };
      if (!isBridgeAccountBridge(body.bridgeId)) {
        res.status(400).json(errorBody(`bridgeId must be one of ${BRIDGE_ACCOUNT_BRIDGES.join(', ')}.`));
        return;
      }
      const bridgeId = body.bridgeId;
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      if (!label) {
        res.status(400).json(errorBody('An account label is required.'));
        return;
      }
      const store = load();
      const id = freeAccountId(store, bridgeId, label);
      const configDir =
        typeof body.configDir === 'string' && body.configDir.trim()
          ? body.configDir.trim()
          : managedAccountConfigDir(deps.dataDir, bridgeId, id);
      const account = validateBridgeAccount(
        { id, bridgeId, label, configDir },
        { managedRoot, homeDir: deps.homeDir },
      );
      // Create the dir (plus OpenCode's subdirs) so the CLI's sign-in
      // flow can write into it immediately.
      fs.mkdirSync(account.configDir!, { recursive: true });
      if (bridgeId === 'opencode') {
        for (const sub of ['config', 'data', 'state', 'cache']) {
          fs.mkdirSync(path.join(account.configDir!, sub), { recursive: true });
        }
      }
      store.upsert(account);
      saveBridgeAccountStore(deps.dataDir, store);
      deps.audit?.('bridge_accounts.created', { actor: 'user', detail: { bridgeId, account: id } });
      res.status(201).json({ ok: true, account: publicAccount(store, account) });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'invalid account'));
    }
  });

  router.patch('/bridge-accounts/:bridgeId/:accountId', (req, res) => {
    const { bridgeId, accountId } = req.params;
    if (!isBridgeAccountBridge(bridgeId)) {
      res.status(400).json(errorBody(`Unknown bridge "${bridgeId}".`));
      return;
    }
    try {
      const store = load();
      const label = (req.body as { label?: unknown } | undefined)?.label;
      const account = store.rename(bridgeId, accountId, typeof label === 'string' ? label : '');
      saveBridgeAccountStore(deps.dataDir, store);
      deps.audit?.('bridge_accounts.renamed', { actor: 'user', detail: { bridgeId, account: accountId } });
      res.json({ ok: true, account: publicAccount(store, account) });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'rename failed'));
    }
  });

  router.post('/bridge-accounts/:bridgeId/:accountId/default', (req, res) => {
    const { bridgeId, accountId } = req.params;
    if (!isBridgeAccountBridge(bridgeId)) {
      res.status(400).json(errorBody(`Unknown bridge "${bridgeId}".`));
      return;
    }
    try {
      const store = load();
      store.setUserDefault(bridgeId, accountId);
      saveBridgeAccountStore(deps.dataDir, store);
      deps.audit?.('bridge_accounts.default_set', { actor: 'user', detail: { bridgeId, account: accountId } });
      res.json({ ok: true, userDefault: store.userDefaultId(bridgeId) ?? 'default' });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'set-default failed'));
    }
  });

  router.delete('/bridge-accounts/:bridgeId/:accountId', (req, res) => {
    const { bridgeId, accountId } = req.params;
    if (!isBridgeAccountBridge(bridgeId)) {
      res.status(400).json(errorBody(`Unknown bridge "${bridgeId}".`));
      return;
    }
    try {
      const store = load();
      const removed = store.remove(bridgeId, accountId);
      // Config-dir policy: delete ONLY on explicit request AND only a
      // dir we created under our managed root. Anything else is left
      // exactly where it was, and the response says so.
      const wantsDelete = req.query.deleteConfigDir === '1' || req.query.deleteConfigDir === 'true';
      let configDirDeleted = false;
      if (wantsDelete && removed.createdByUs && removed.configDir) {
        const target = path.resolve(removed.configDir);
        if (target.startsWith(path.resolve(managedRoot) + path.sep)) {
          fs.rmSync(target, { recursive: true, force: true });
          configDirDeleted = true;
        }
      }
      saveBridgeAccountStore(deps.dataDir, store);
      deps.audit?.('bridge_accounts.removed', {
        actor: 'user',
        detail: { bridgeId, account: accountId, configDirDeleted },
      });
      res.json({
        ok: true,
        removed: accountId,
        configDir: removed.configDir ?? null,
        configDirDeleted,
        configDirNote: configDirDeleted
          ? 'The account was removed and the config directory KriyaDot created for it was deleted.'
          : removed.configDir
            ? `The account was removed from KriyaDot. Its config directory (${removed.configDir}) was NOT deleted${removed.createdByUs ? ' — pass deleteConfigDir=1 to delete a directory KriyaDot created' : ' — it is a directory you supplied, and KriyaDot never deletes those'}. Sign-in data inside it is untouched.`
            : 'The account was removed.',
      });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : 'remove failed'));
    }
  });

  router.get('/bridge-accounts/resolve/:botId/:bridgeId', (req, res) => {
    const { botId, bridgeId } = req.params;
    if (!isBridgeAccountBridge(bridgeId)) {
      res.status(400).json(errorBody(`Unknown bridge "${bridgeId}".`));
      return;
    }
    const bot = deps.bots?.find((b) => b.id === botId);
    if (!bot) {
      res.status(404).json(errorBody(`Unknown bot "${botId}".`));
      return;
    }
    const store = load();
    const account = resolveBridgeAccount(bot, bridgeId, store);
    res.json({
      ok: true,
      botId,
      bridgeId,
      account: publicAccount(store, account),
      spawnEnv: bridgeAccountSpawnEnv(account),
    });
  });

  return router;
}

/** Re-export for hosts that prefer importing the shared store getter here. */
export { getBridgeAccountStore };
