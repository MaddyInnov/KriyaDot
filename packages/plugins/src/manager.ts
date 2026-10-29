// SPDX-License-Identifier: Apache-2.0
// PluginManager: install / uninstall / enable / disable / load, with state
// persisted to a JSON store under an injected data directory.
//
// Layout under <dataDir>:
//   plugins-state.json     the store: { version, plugins: [record, ...] }
//   plugins/<id>/          the installed plugin directory (plugin.json, ...)
//
// Install sources: a local directory, a local .zip file, or an http(s) URL
// (fetched through an injectable fetch — tests never touch the network).
//
// Approval: EVERY install must pass the `approveInstall` hook. The hook
// receives the parsed manifest + source description and returns (or
// resolves) true to allow. No hook configured → installs are refused
// (deny-by-default, same posture as the marketplace MCP installer); a hook
// returning false → PluginInstallDenied. The API layer wires the hook to
// governance approvals; tests pass a stub.
//
// Staging: sources are first materialized into a staging dir and the
// manifest + referenced files validated there; only approved, valid
// plugins are moved into plugins/<id>/.

import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseManifest, validateManifest, EXECUTABLE_KINDS, type PluginManifest } from './manifest.js';
import { extractZipToDir } from './zip.js';
import {
  callPluginTool,
  createPluginChannelProvider,
  invokePluginHook,
  listPluginTools,
  pluginSkillDescriptor,
  pluginUiDescriptor,
  type PluginMessageProvider,
  type PluginSkillDescriptor,
  type PluginToolDefinition,
  type PluginUiDescriptor,
} from './runtime.js';
import type { InvokeOptions } from './rpc.js';

export type PluginInstallSource =
  | { type: 'dir'; path: string }
  | { type: 'zip'; path: string }
  | { type: 'url'; url: string };

export interface PluginInstallSourceInfo {
  type: PluginInstallSource['type'];
  /** Origin description shown to the approver (path or URL, no contents). */
  origin: string;
}

export type ApproveInstallHook = (
  manifest: PluginManifest,
  source: PluginInstallSourceInfo,
) => boolean | Promise<boolean>;

export class PluginApprovalRequired extends Error {
  constructor() {
    super('plugin install requires an approveInstall hook, and none is configured (deny-by-default)');
    this.name = 'PluginApprovalRequired';
  }
}

export class PluginInstallDenied extends Error {
  readonly pluginId: string;
  constructor(pluginId: string) {
    super(`plugin install denied by the approval hook: ${pluginId}`);
    this.name = 'PluginInstallDenied';
    this.pluginId = pluginId;
  }
}

export class PluginNotFoundError extends Error {
  constructor(id: string) {
    super(`plugin not installed: ${id}`);
    this.name = 'PluginNotFoundError';
  }
}

export interface InstalledPlugin {
  id: string;
  manifest: PluginManifest;
  /** Absolute install directory. */
  dir: string;
  enabled: boolean;
  installedAt: number;
  source: PluginInstallSourceInfo;
}

interface StoreFile {
  version: 1;
  plugins: InstalledPlugin[];
}

export interface PluginManagerOptions {
  /** Directory holding plugins-state.json and the plugins/ install root. Injected (tests use a temp dir). */
  dataDir: string;
  approveInstall?: ApproveInstallHook;
  /** Injectable fetch for URL installs. Defaults to the global fetch. */
  fetchFn?: (url: string) => Promise<{ ok: boolean; status?: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  /** Per-invocation RPC timeout for this manager's runtime calls. */
  rpcTimeoutMs?: number;
  now?: () => number;
}

export interface PluginLoadReport {
  loaded: InstalledPlugin[];
  failed: Array<{ id: string; dir: string; error: string }>;
}

const STORE_FILE = 'plugins-state.json';

export class PluginManager {
  private readonly dataDir: string;
  private readonly installRoot: string;
  private readonly storePath: string;
  private readonly approveInstall?: ApproveInstallHook;
  private readonly fetchFn: NonNullable<PluginManagerOptions['fetchFn']>;
  private readonly rpcOpts: InvokeOptions;
  private readonly now: () => number;
  private records = new Map<string, InstalledPlugin>();

  constructor(opts: PluginManagerOptions) {
    this.dataDir = resolve(opts.dataDir);
    this.installRoot = join(this.dataDir, 'plugins');
    this.storePath = join(this.dataDir, STORE_FILE);
    this.approveInstall = opts.approveInstall;
    this.fetchFn = opts.fetchFn ?? ((url: string) => fetch(url));
    this.rpcOpts = opts.rpcTimeoutMs ? { timeoutMs: opts.rpcTimeoutMs } : {};
    this.now = opts.now ?? (() => Date.now());
    mkdirSync(this.installRoot, { recursive: true });
    this.records = new Map(this.readStore().plugins.map((p) => [p.id, p]));
  }

  // ---- persistence --------------------------------------------------------

  private readStore(): StoreFile {
    try {
      const parsed = JSON.parse(readFileSync(this.storePath, 'utf8')) as StoreFile;
      if (parsed && Array.isArray(parsed.plugins)) return { version: 1, plugins: parsed.plugins };
    } catch {
      // missing/corrupt store → empty (loadAll reports broken dirs)
    }
    return { version: 1, plugins: [] };
  }

  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = this.storePath + '.tmp';
    const file: StoreFile = { version: 1, plugins: [...this.records.values()] };
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    renameSync(tmp, this.storePath);
  }

  // ---- queries --------------------------------------------------------------

  list(): InstalledPlugin[] {
    return [...this.records.values()].map((p) => ({ ...p }));
  }

  get(id: string): InstalledPlugin | undefined {
    const rec = this.records.get(id);
    return rec ? { ...rec } : undefined;
  }

  /** Target for runtime adapters; throws when missing or disabled. */
  private enabledTarget(id: string): InstalledPlugin {
    const rec = this.records.get(id);
    if (!rec) throw new PluginNotFoundError(id);
    if (!rec.enabled) throw new Error(`plugin "${id}" is disabled`);
    return rec;
  }

  // ---- install / uninstall ---------------------------------------------------

  private stageDir(source: PluginInstallSource): { staging: string; info: PluginInstallSourceInfo } {
    const staging = join(this.installRoot, `.staging-${randomUUID()}`);
    mkdirSync(staging, { recursive: true });
    return { staging, info: { type: source.type, origin: '' } };
  }

  private async materialize(source: PluginInstallSource, staging: string): Promise<PluginInstallSourceInfo> {
    if (source.type === 'dir') {
      const src = resolve(source.path);
      if (!existsSync(src) || !statSync(src).isDirectory()) {
        throw new Error(`plugin source directory not found: ${source.path}`);
      }
      cpSync(src, staging, { recursive: true });
      return { type: 'dir', origin: src };
    }
    if (source.type === 'zip') {
      const src = resolve(source.path);
      if (!existsSync(src)) throw new Error(`plugin zip not found: ${source.path}`);
      extractZipToDir(readFileSync(src), staging);
      return { type: 'zip', origin: src };
    }
    // url
    const res = await this.fetchFn(source.url);
    if (!res.ok) throw new Error(`plugin download failed: HTTP ${res.status ?? 'unknown'} for ${source.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    extractZipToDir(buf, staging);
    return { type: 'url', origin: source.url };
  }

  /** Files the manifest points at must exist inside the staged plugin dir. */
  private validateFiles(dir: string, manifest: PluginManifest): void {
    const problems: string[] = [];
    if (manifest.entry) {
      const entryAbs = resolve(dir, manifest.entry);
      if (!entryAbs.startsWith(resolve(dir) + sep) || !existsSync(entryAbs)) {
        problems.push(`entry file not found: ${manifest.entry}`);
      }
    }
    if (manifest.kinds.includes('skill') && !existsSync(join(dir, 'SKILL.md'))) {
      problems.push('skill plugins must contain a SKILL.md at the plugin root');
    }
    if (manifest.ui) {
      const uiAbs = resolve(dir, manifest.ui.dir);
      if (!uiAbs.startsWith(resolve(dir) + sep) || !existsSync(uiAbs) || !statSync(uiAbs).isDirectory()) {
        problems.push(`ui.dir not found: ${manifest.ui.dir}`);
      }
    }
    if (problems.length > 0) throw new Error(`invalid plugin package: ${problems.join('; ')}`);
  }

  /**
   * Install from a directory, a .zip file, or a URL. The manifest is parsed
   * and validated BEFORE the approval hook runs (the approver sees exactly
   * what would be installed); on approval the staged tree is moved into
   * plugins/<id>/ and state is persisted. Reinstalling an existing id
   * replaces it (recorded as a fresh install).
   */
  async install(source: PluginInstallSource): Promise<InstalledPlugin> {
    const { staging } = this.stageDir(source);
    try {
      const info = await this.materialize(source, staging);
      const manifestPath = join(staging, 'plugin.json');
      if (!existsSync(manifestPath)) throw new Error('plugin package has no plugin.json at its root');
      const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
      // Re-validate the normalized manifest (defense in depth) + files.
      validateManifest(manifest);
      this.validateFiles(staging, manifest);

      if (!this.approveInstall) throw new PluginApprovalRequired();
      const approved = await this.approveInstall(manifest, info);
      if (!approved) throw new PluginInstallDenied(manifest.id);

      const dest = join(this.installRoot, manifest.id);
      rmSync(dest, { recursive: true, force: true });
      renameSync(staging, dest);
      const record: InstalledPlugin = {
        id: manifest.id,
        manifest,
        dir: dest,
        enabled: true,
        installedAt: this.now(),
        source: info,
      };
      this.records.set(manifest.id, record);
      this.persist();
      return { ...record };
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
  }

  /** Remove the plugin directory and its state record. */
  uninstall(id: string): void {
    const rec = this.records.get(id);
    if (!rec) throw new PluginNotFoundError(id);
    rmSync(rec.dir, { recursive: true, force: true });
    this.records.delete(id);
    this.persist();
  }

  setEnabled(id: string, enabled: boolean): InstalledPlugin {
    const rec = this.records.get(id);
    if (!rec) throw new PluginNotFoundError(id);
    rec.enabled = enabled;
    this.persist();
    return { ...rec };
  }

  /**
   * Startup load: re-validate every persisted record against its on-disk
   * manifest. Broken entries are reported (never thrown) so one corrupt
   * plugin cannot block boot — same posture as agent-runtime loadPlugins.
   */
  loadAll(): PluginLoadReport {
    this.records = new Map(this.readStore().plugins.map((p) => [p.id, p]));
    const report: PluginLoadReport = { loaded: [], failed: [] };
    for (const rec of this.records.values()) {
      try {
        const manifestPath = join(rec.dir, 'plugin.json');
        if (!existsSync(manifestPath)) throw new Error('plugin.json missing');
        const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
        if (manifest.id !== rec.id) throw new Error(`plugin.json id "${manifest.id}" != installed id "${rec.id}"`);
        this.validateFiles(rec.dir, manifest);
        rec.manifest = manifest;
        report.loaded.push({ ...rec });
      } catch (err) {
        report.failed.push({ id: rec.id, dir: rec.dir, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  }

  // ---- runtime surfaces (enabled plugins only) -------------------------------

  /** All tools from enabled tool plugins (ToolDefinition-shaped). */
  async tools(): Promise<PluginToolDefinition[]> {
    const out: PluginToolDefinition[] = [];
    for (const rec of this.records.values()) {
      if (!rec.enabled || !rec.manifest.kinds.includes('tool')) continue;
      out.push(...(await listPluginTools(rec, this.rpcOpts)));
    }
    return out;
  }

  async callTool(id: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    return callPluginTool(this.enabledTarget(id), tool, args, this.rpcOpts);
  }

  async invokeHook(id: string, event: string, payload: unknown) {
    return invokePluginHook(this.enabledTarget(id), event, payload, this.rpcOpts);
  }

  /** All enabled hook plugins, for HookBus registration by the host. */
  hookTargets(): InstalledPlugin[] {
    return this.list().filter((p) => p.enabled && p.manifest.kinds.includes('hook'));
  }

  channelProvider(id: string): PluginMessageProvider {
    return createPluginChannelProvider(this.enabledTarget(id), this.rpcOpts);
  }

  channelProviders(): PluginMessageProvider[] {
    return this.list()
      .filter((p) => p.enabled && p.manifest.kinds.includes('channel'))
      .map((p) => createPluginChannelProvider(p, this.rpcOpts));
  }

  skillDescriptor(id: string): PluginSkillDescriptor {
    return pluginSkillDescriptor(this.enabledTarget(id));
  }

  skillDescriptors(): PluginSkillDescriptor[] {
    return this.list()
      .filter((p) => p.enabled && p.manifest.kinds.includes('skill'))
      .map((p) => pluginSkillDescriptor(p));
  }

  uiDescriptor(id: string): PluginUiDescriptor {
    return pluginUiDescriptor(this.enabledTarget(id));
  }

  uiDescriptors(): PluginUiDescriptor[] {
    return this.list()
      .filter((p) => p.enabled && p.manifest.kinds.includes('ui') && p.manifest.ui)
      .map((p) => pluginUiDescriptor(p));
  }
}

export { EXECUTABLE_KINDS };
