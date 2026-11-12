// SPDX-License-Identifier: Apache-2.0
// Plugin system routes (Octop parity §2.17 plugins + §2.7 plugin channels).
//
//   GET    /plugins                  installed plugins + state
//   POST   /plugins/install          { source: 'dir'|'zip'|'url', path }
//   DELETE /plugins/:id              uninstall
//   POST   /plugins/:id/enable       enable
//   POST   /plugins/:id/disable      disable
//   GET    /plugins/:id/ui/*         static UI assets, sandboxed headers
//
// HOST WIRING (index.ts / routes.ts — one import + one use):
//   import { createPluginRouter, buildPluginTools, registerPluginHooks, registerPluginChannels } from './plugin-routes.js';
//   import { PluginManager } from '@mvp/plugins';
//   const pluginManager = new PluginManager({
//     dataDir: config.dataDir,
//     // Governance-backed install approval: raises a require-approval card
//     // and only allows the install when it is approved (deny-by-default).
//     approveInstall: async (manifest) => { /* host governance wiring */ },
//   });
//   pluginManager.loadAll();
//   app.use('/api', createPluginRouter({ manager: pluginManager, audit: (a, f) => governance.audit(a, f) }));
//   void registerPluginChannels(pluginManager); // bridges channel plugins into messaging.ts
//   registerPluginHooks(pluginManager, hookBus); // when a HookBus is in scope
//
// TOOL REGISTRY MERGE (tool-registry.ts — one line inside buildToolRegistry,
// after the registry Map is created, with pluginManager in scope):
//   for (const t of await buildPluginTools(pluginManager)) registry.set(t.name, t);
//
// Install approval lives in the PluginManager's approveInstall hook (the
// host passes governance there); this router never bypasses it.

import express, { type Router } from 'express';
import { existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import {
  PluginApprovalRequired,
  PluginInstallDenied,
  PluginManifestError,
  PluginNotFoundError,
  PluginSignatureError,
  ZipError,
  pluginKeyId,
  pluginSandboxStatusSync,
  type InstalledPlugin,
  type PluginInstallSource,
  type PluginManager,
  type PluginTrustStore,
} from '@mvp/plugins';
import { syncPluginProviders } from './plugin-providers.js';
import type { HookBus, HookEventName, ToolDefinition } from '@mvp/agent-runtime';
import { registerMessageProvider } from './messaging.js';
import * as hooksConfig from './hooks-config.js';

interface ApiError {
  error: string;
  detail?: string;
}

function errorBody(error: string, detail?: string): ApiError {
  return detail ? { error, detail } : { error };
}

export interface PluginRouterDeps {
  manager: PluginManager;
  /** A9: the user's publisher trust store, when the host configured one (enables the /plugins/trust routes). */
  trustStore?: PluginTrustStore;
  /**
   * A9: called after any install/uninstall/enable/disable mutation so the
   * host can re-sync mirrored state (the API's chat tool registry — the
   * provider registry is synced by this router itself). Best-effort: a
   * throwing hook is logged, never fails the mutation.
   */
  onPluginsChanged?: () => void | Promise<void>;
  audit?: (
    action: string,
    fields: { actor?: string; sessionId?: string; decision?: string; detail?: unknown },
  ) => void;
}

export function serializeInstalledPlugin(p: InstalledPlugin): Record<string, unknown> {
  return {
    id: p.id,
    name: p.manifest.name,
    version: p.manifest.version,
    description: p.manifest.description,
    kinds: p.manifest.kinds,
    permissions: p.manifest.permissions ?? {},
    ...(p.manifest.ui ? { ui: p.manifest.ui } : {}),
    ...(p.manifest.publisher ? { publisher: p.manifest.publisher } : {}),
    // A9: declared secret NAMES (never values) + signature provenance.
    // `signature.status` is the label the UI must show verbatim: only
    // "verified" means a trusted publisher signed these exact bytes, and
    // even that proves origin, not behaviour (OPEN-2 sandbox is the
    // behaviour control).
    ...(p.manifest.secrets ? { secrets: p.manifest.secrets } : {}),
    signature: p.signature ?? { status: 'unrecorded' },
    ...(p.manifest.provider ? { provider: p.manifest.provider } : {}),
    enabled: p.enabled,
    installedAt: p.installedAt,
    sourceType: p.source.type,
  };
}

function actorOf(req: express.Request): string {
  const body = (req.body ?? {}) as { actor?: unknown };
  return typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim().slice(0, 64) : 'user';
}

function mapError(err: unknown, res: express.Response, action: string): void {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof PluginNotFoundError) {
    res.status(404).json(errorBody(message));
    return;
  }
  if (err instanceof PluginApprovalRequired || err instanceof PluginInstallDenied || err instanceof PluginSignatureError) {
    res.status(403).json(errorBody(message));
    return;
  }
  if (err instanceof PluginManifestError || err instanceof ZipError || /not found|no plugin\.json|invalid plugin package/.test(message)) {
    res.status(400).json(errorBody(message));
    return;
  }
  res.status(500).json(errorBody(`Failed to ${action}`, message));
}

// ---------------------------------------------------------------------------
// UI asset serving
// ---------------------------------------------------------------------------

const UI_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * Sandboxed serving headers for plugin UI assets: the panel can load its
 * own scripts/styles/images but cannot reach the host origin's APIs with
 * ambient authority beyond same-origin fetch, and the `sandbox` CSP token
 * forces a unique origin for the framed document.
 */
export const PLUGIN_UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; sandbox allow-scripts";

export function createPluginRouter(deps: PluginRouterDeps): Router {
  const router = express.Router();
  const { manager } = deps;
  const audit = deps.audit ?? (() => {});

  // A9 hot-install bookkeeping: after every mutation, re-sync the
  // provider registry from the manager's live records and notify the
  // host (tool registry mirror). Both are best-effort mirrors — the
  // manager itself is already live, so a mirror failure must not fail
  // the mutation that already succeeded.
  const afterMutation = async (): Promise<void> => {
    try {
      syncPluginProviders(manager);
    } catch (err) {
      console.warn(`[plugins] provider sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await deps.onPluginsChanged?.();
    } catch (err) {
      console.warn(`[plugins] onPluginsChanged failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  router.get('/plugins', (_req, res) => {
    // OPEN-2: surface the host's plugin-sandbox capability honestly.
    // `backend` names the kernel backend for this platform; enforcement
    // is per-invocation — a restrictive plugin whose declarations cannot
    // be enforced on this host is refused at invoke time, never run
    // unconfined (see @mvp/plugins plugin-sandbox.ts).
    res.json({ ok: true, sandbox: pluginSandboxStatusSync(), plugins: manager.list().map(serializeInstalledPlugin) });
  });

  // A9: publisher trust listing. Registered BEFORE /plugins/:id so the
  // literal "trust" segment wins over the :id parameter.
  router.get('/plugins/trust', (_req, res) => {
    res.json({
      ok: true,
      trustedKeys: manager
        .trustedKeys()
        .map((publicKey) => ({ keyId: pluginKeyId(publicKey), publicKey })),
      userKeys: deps.trustStore ? deps.trustStore.list() : [],
    });
  });

  router.get('/plugins/:id', (req, res) => {
    const rec = manager.get(req.params.id);
    if (!rec) {
      res.status(404).json(errorBody(`plugin not installed: ${req.params.id}`));
      return;
    }
    const detail: Record<string, unknown> = { ...serializeInstalledPlugin(rec) };
    try {
      if (rec.enabled && rec.manifest.kinds.includes('skill')) detail.skill = manager.skillDescriptor(rec.id);
    } catch {
      // descriptor problems surface on use, not on listing
    }
    try {
      if (rec.enabled && rec.manifest.kinds.includes('ui')) detail.uiDescriptor = manager.uiDescriptor(rec.id);
    } catch {
      // as above
    }
    res.json({ ok: true, plugin: detail });
  });

  router.post('/plugins/install', async (req, res) => {
    const body = (req.body ?? {}) as { source?: unknown; path?: unknown; url?: unknown };
    const sourceKind = body.source;
    const path = typeof body.path === 'string' ? body.path : typeof body.url === 'string' ? body.url : '';
    if (sourceKind !== 'dir' && sourceKind !== 'zip' && sourceKind !== 'package' && sourceKind !== 'url') {
      res.status(400).json(errorBody('source must be one of: dir, zip, package, url'));
      return;
    }
    if (!path) {
      res.status(400).json(errorBody('path is required (directory path, zip/.kdpkg path, or URL for source "url")'));
      return;
    }
    const source: PluginInstallSource =
      sourceKind === 'url' ? { type: 'url', url: path } : { type: sourceKind, path };
    try {
      const rec = await manager.install(source);
      audit('plugin.installed', {
        actor: actorOf(req),
        decision: 'installed',
        detail: { id: rec.id, source: sourceKind, signature: rec.signature.status },
      });
      await afterMutation();
      res.status(201).json({ ok: true, plugin: serializeInstalledPlugin(rec) });
    } catch (err) {
      mapError(err, res, 'install plugin');
    }
  });

  router.delete('/plugins/:id', async (req, res) => {
    try {
      manager.uninstall(req.params.id);
      audit('plugin.uninstalled', { actor: actorOf(req), detail: { id: req.params.id } });
      await afterMutation();
      res.json({ ok: true, deleted: req.params.id });
    } catch (err) {
      mapError(err, res, 'uninstall plugin');
    }
  });

  // A9 publisher trust mutations (the GET lives above /plugins/:id so
  // "trust" is not swallowed by the :id parameter). ADDING a key is a
  // durable trust decision (future packages from that key verify), so it
  // is audit-logged like every other trust action. Removing a key stops
  // future installs from that publisher verifying; installed plugins are
  // unaffected.
  router.post('/plugins/trust', (req, res) => {
    if (!deps.trustStore) {
      res.status(501).json(errorBody('no publisher trust store is configured on this host'));
      return;
    }
    const body = (req.body ?? {}) as { publicKey?: unknown; label?: unknown };
    if (typeof body.publicKey !== 'string' || typeof body.label !== 'string' || !body.label.trim()) {
      res.status(400).json(errorBody('publicKey (SPKI base64) and a non-empty label are required'));
      return;
    }
    try {
      const record = deps.trustStore.add(body.publicKey, body.label.trim().slice(0, 120));
      audit('plugin.publisher_trusted', { actor: actorOf(req), decision: 'trusted', detail: { keyId: record.keyId } });
      res.status(201).json({ ok: true, trusted: record });
    } catch (err) {
      res.status(400).json(errorBody(err instanceof Error ? err.message : String(err)));
    }
  });

  router.delete('/plugins/trust/:keyId', (req, res) => {
    if (!deps.trustStore) {
      res.status(501).json(errorBody('no publisher trust store is configured on this host'));
      return;
    }
    const removed = deps.trustStore.remove(req.params.keyId);
    if (!removed) {
      res.status(404).json(errorBody(`trusted key not found: ${req.params.keyId}`));
      return;
    }
    audit('plugin.publisher_untrusted', { actor: actorOf(req), decision: 'untrusted', detail: { keyId: req.params.keyId } });
    res.json({ ok: true, removed: req.params.keyId });
  });

  router.post('/plugins/:id/enable', async (req, res) => {
    try {
      const rec = manager.setEnabled(req.params.id, true);
      audit('plugin.enabled', { actor: actorOf(req), decision: 'enabled', detail: { id: rec.id } });
      await afterMutation();
      res.json({ ok: true, plugin: serializeInstalledPlugin(rec) });
    } catch (err) {
      mapError(err, res, 'enable plugin');
    }
  });

  router.post('/plugins/:id/disable', async (req, res) => {
    try {
      const rec = manager.setEnabled(req.params.id, false);
      audit('plugin.disabled', { actor: actorOf(req), decision: 'disabled', detail: { id: rec.id } });
      await afterMutation();
      res.json({ ok: true, plugin: serializeInstalledPlugin(rec) });
    } catch (err) {
      mapError(err, res, 'disable plugin');
    }
  });

  // Static UI assets. Registered for both the bare path and the wildcard;
  // express strips nothing, so the asset path is params[0] on the wildcard.
  const serveUi: express.RequestHandler = (req, res) => {
    const rec = manager.get(req.params.id);
    if (!rec) {
      res.status(404).json(errorBody(`plugin not installed: ${req.params.id}`));
      return;
    }
    if (!rec.enabled) {
      res.status(403).json(errorBody(`plugin "${rec.id}" is disabled`));
      return;
    }
    let descriptor;
    try {
      descriptor = manager.uiDescriptor(rec.id);
    } catch (err) {
      res.status(404).json(errorBody(err instanceof Error ? err.message : String(err)));
      return;
    }
    const rawAsset = typeof req.params[0] === 'string' ? req.params[0] : '';
    let asset: string;
    try {
      asset = decodeURIComponent(rawAsset);
    } catch {
      res.status(400).json(errorBody('bad asset path'));
      return;
    }
    const rel = asset.replace(/^\/+/, '') || 'index.html';
    const abs = resolve(descriptor.dir, rel);
    if (abs !== descriptor.dir && !abs.startsWith(descriptor.dir + sep)) {
      res.status(400).json(errorBody('asset path escapes the plugin UI directory'));
      return;
    }
    const type = UI_CONTENT_TYPES[extname(abs).toLowerCase()];
    if (!type) {
      res.status(404).json(errorBody('unsupported asset type'));
      return;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      res.status(404).json(errorBody('asset not found'));
      return;
    }
    res.setHeader('Content-Security-Policy', PLUGIN_UI_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    res.type(type);
    res.sendFile(abs);
  };
  router.get('/plugins/:id/ui', serveUi);
  router.get('/plugins/:id/ui/*', serveUi);

  return router;
}

// ---------------------------------------------------------------------------
// Host integration helpers
// ---------------------------------------------------------------------------

/**
 * ToolDefinitions for every enabled tool plugin, ready to merge into the
 * tool registry Map (see the one-line merge note in the file header).
 */
export async function buildPluginTools(manager: PluginManager): Promise<ToolDefinition[]> {
  const tools = await manager.tools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    ...(t.mutating ? { mutating: true } : {}),
    handler: async (args: Record<string, unknown>, ctx: { sessionId: string; botId: string }) =>
      t.handler(args, { sessionId: ctx.sessionId, botId: ctx.botId }),
  }));
}

const HOOK_EVENTS: readonly HookEventName[] = [
  'session.created',
  'tool.before',
  'tool.after',
  'turn.ending',
  'input.transform',
];

/**
 * Register every enabled hook plugin on the host HookBus, for every known
 * event (plugins return no result for events they do not handle). Returns
 * unsubscribe functions. Handler errors are collected by the bus itself.
 */
export function registerPluginHooks(manager: PluginManager, bus: HookBus): Array<() => void> {
  const unsubs: Array<() => void> = [];
  for (const rec of manager.hookTargets()) {
    for (const event of HOOK_EVENTS) {
      unsubs.push(
        bus.on(event, async (payload: unknown) => manager.invokeHook(rec.id, event, payload)),
      );
    }
  }
  return unsubs;
}

/**
 * Bridge every enabled channel plugin into the messaging provider registry
 * (registerMessageProvider from messaging.ts), under the provider id
 * `plugin-<pluginId>`. Returns the registered provider ids. Inbound
 * delivery is pull-based: the host polls provider.poll() (see the poll
 * model documented in @mvp/plugins runtime.ts).
 */
/**
 * Script-hook host wiring (#67): register `hooks: [{kind:'script', ...}]`
 * entries from bot/workspace config onto the host HookBus. Call at bot
 * setup for each configured bot; returns all unsubscribers + errors.
 */
export function registerScriptHooksFromConfigs(
  bus: HookBus,
  configs: Array<{ id?: string; hooks?: unknown }>,
): { unsubs: Array<() => void>; errors: string[]; registered: number } {
  const { installBotScriptHooks } = hooksConfig;
  const unsubs: Array<() => void> = [];
  const errors: string[] = [];
  let registered = 0;
  for (const cfg of configs) {
    const r = installBotScriptHooks(bus, cfg);
    unsubs.push(...r.unsubs);
    errors.push(...r.errors);
    registered += r.registered;
  }
  return { unsubs, errors, registered };
}

export function registerPluginChannels(manager: PluginManager): string[] {
  const ids: string[] = [];
  for (const provider of manager.channelProviders()) {
    registerMessageProvider(provider.id, () => provider);
    ids.push(provider.id);
  }
  return ids;
}
