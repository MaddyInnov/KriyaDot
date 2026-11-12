// SPDX-License-Identifier: Apache-2.0
// PluginManager: install / uninstall / enable / disable / load, with state
// persisted to a JSON store under an injected data directory.
//
// Layout under <dataDir>:
//   plugins-state.json     the store: { version, plugins: [record, ...] }
//   plugins/<id>/          the installed plugin directory (plugin.json, ...)
//
// Install sources: a local directory, a local .zip file, a signed .kdpkg
// package file (A9 — same ZIP container, signature enforced), or an
// http(s) URL (fetched through an injectable fetch — tests never touch
// the network).
//
// Approval: EVERY install must pass the `approveInstall` hook. The hook
// receives the parsed manifest + source description and returns (or
// resolves) true to allow. No hook configured → installs are refused
// (deny-by-default, same posture as the marketplace MCP installer); a hook
// returning false → PluginInstallDenied. The API layer wires the hook to
// governance approvals; tests pass a stub.
//
// Signatures (A9, package.ts): DISTRIBUTABLE packages (zip / package /
// url sources, and any source carrying a signature.json) are verified
// against the host's trusted publisher keys BEFORE approval. A verified
// package proceeds to the ordinary approval hook — signing never skips
// governance. An unsigned, untrusted-key or invalid package is REFUSED
// unless the host configured the separate `approveUntrustedInstall` hook
// and it approves: that hook is the explicit, labelled "install anyway"
// decision (the API wires it to a governance approval whose payload
// states the signature status in plain words), and the installed record
// permanently carries the unverified status so the UI/API label it
// forever. Local DIRECTORY installs are the developer's own files already
// on disk (no distribution boundary is crossed — the user could copy them
// into plugins/ by hand), so they keep the approval-only flow and are
// recorded as signature status "local-directory"; a directory that DOES
// carry a signature.json is verified like a package.
//
// Hot install: install/uninstall/enable/disable mutate the in-memory
// records immediately — a running host sees the plugin (its tools, hooks,
// channels, provider declaration) on the very next call, with no restart
// and no reload step. Hosts that mirror plugin state into other
// registries (the API's tool registry / provider registry) re-sync on
// the mutation routes; the manager itself is always live.
//
// Staging: sources are first materialized into a staging dir and the
// manifest + referenced files validated there; only approved, valid
// plugins are moved into plugins/<id>/.

import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseManifest, validateManifest, EXECUTABLE_KINDS, type PluginManifest } from './manifest.js';
import { extractZipToDir } from './zip.js';
import {
  PLUGIN_SIGNATURE_FILE,
  PluginTrustStore,
  resolveTrustedPluginKeys,
  verifyPackageFiles,
  type PackageFileEntry,
  type PluginSignatureStatus,
} from './package.js';
import {
  callPluginTool,
  createPluginChannelProvider,
  invokePluginHook,
  listPluginTools,
  pluginProviderDescriptor,
  pluginSkillDescriptor,
  pluginUiDescriptor,
  type DeclarativeProviderDescriptor,
  type PluginMessageProvider,
  type PluginSkillDescriptor,
  type PluginToolDefinition,
  type PluginUiDescriptor,
} from './runtime.js';
import type { InvokeOptions } from './rpc.js';

export type PluginInstallSource =
  | { type: 'dir'; path: string }
  | { type: 'zip'; path: string }
  /** A9: a signed plugin package (.kdpkg — ZIP container, signature verified). */
  | { type: 'package'; path: string }
  | { type: 'url'; url: string };

/**
 * Signature provenance recorded at install and surfaced forever after in
 * the API/UI. `local-directory` = developer's own on-disk directory (no
 * package, nothing to verify); `unrecorded` = installed before A9 kept
 * provenance. Every other value is the package verification outcome.
 */
export interface PluginSignatureInfo {
  status: PluginSignatureStatus | 'local-directory' | 'unrecorded';
  /** Signing key fingerprint (kdkey_…), when a signature was present. */
  keyId?: string;
  /** Signer's presented public key (informational), when present. */
  signerPublicKey?: string;
}

export interface PluginInstallSourceInfo {
  type: PluginInstallSource['type'];
  /** Origin description shown to the approver (path or URL, no contents). */
  origin: string;
  /** A9: signature verification outcome, present when one was performed. */
  signature?: PluginSignatureInfo;
}

export type ApproveInstallHook = (
  manifest: PluginManifest,
  source: PluginInstallSourceInfo,
) => boolean | Promise<boolean>;

/**
 * A9: the explicit "install anyway" decision for a package whose
 * signature is NOT verified (unsigned / untrusted-key / invalid). The
 * host wires this to governance with the status labelled in plain words.
 * It REPLACES the ordinary approval hook for such packages (the untrusted
 * decision is the stronger one and must not be diluted into a routine
 * approval). Absent hook → unverified packages are refused, always.
 */
export type ApproveUntrustedInstallHook = (
  manifest: PluginManifest,
  source: PluginInstallSourceInfo & { signature: PluginSignatureInfo },
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

/**
 * A9: a distributable package whose signature is not verified, with no
 * untrusted-install approval configured (or needed context missing).
 * Refusal is the default posture — this error is the "no silent bypass"
 * guarantee made concrete.
 */
export class PluginSignatureError extends Error {
  readonly pluginId: string;
  readonly signature: PluginSignatureInfo;
  constructor(pluginId: string, signature: PluginSignatureInfo) {
    super(
      `plugin package signature is "${signature.status}" and no untrusted-install approval is configured — refusing to install: ${pluginId}`,
    );
    this.name = 'PluginSignatureError';
    this.pluginId = pluginId;
    this.signature = signature;
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
  /** A9: signature provenance (see PluginSignatureInfo). */
  signature: PluginSignatureInfo;
}

interface StoreFile {
  version: 1;
  plugins: InstalledPlugin[];
}

export interface PluginManagerOptions {
  /** Directory holding plugins-state.json and the plugins/ install root. Injected (tests use a temp dir). */
  dataDir: string;
  approveInstall?: ApproveInstallHook;
  /**
   * A9: explicit approval for packages whose signature is NOT verified.
   * Wired by the host to governance with the signature status labelled;
   * absent → unverified packages are refused (PluginSignatureError).
   */
  approveUntrustedInstall?: ApproveUntrustedInstallHook;
  /**
   * A9: extra trusted publisher keys (SPKI base64) beyond the built-in
   * root + KRIYADOT_PLUGIN_TRUSTED_KEYS env root. The trust store's keys
   * are added on top when `trustStore` is given.
   */
  trustedPublisherKeys?: string[];
  /** A9: the user's publisher trust store (keys they explicitly trusted). */
  trustStore?: PluginTrustStore;
  /**
   * A9: resolve a declared secret NAME to its value at invocation time
   * (host secret store / environment). Values are injected into the
   * plugin child's scrubbed env under the declared name only, and are
   * never persisted or logged. Absent → declared secrets stay unset.
   */
  resolveSecret?: (name: string) => string | undefined;
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
  private readonly approveUntrustedInstall?: ApproveUntrustedInstallHook;
  private readonly trustedPublisherKeys: string[];
  private readonly trustStore?: PluginTrustStore;
  private readonly resolveSecret?: (name: string) => string | undefined;
  private readonly fetchFn: NonNullable<PluginManagerOptions['fetchFn']>;
  private readonly rpcOpts: InvokeOptions;
  private readonly now: () => number;
  private records = new Map<string, InstalledPlugin>();

  constructor(opts: PluginManagerOptions) {
    this.dataDir = resolve(opts.dataDir);
    this.installRoot = join(this.dataDir, 'plugins');
    this.storePath = join(this.dataDir, STORE_FILE);
    this.approveInstall = opts.approveInstall;
    this.approveUntrustedInstall = opts.approveUntrustedInstall;
    this.trustedPublisherKeys = opts.trustedPublisherKeys ?? [];
    this.trustStore = opts.trustStore;
    this.resolveSecret = opts.resolveSecret;
    this.fetchFn = opts.fetchFn ?? ((url: string) => fetch(url));
    this.rpcOpts = opts.rpcTimeoutMs ? { timeoutMs: opts.rpcTimeoutMs } : {};
    this.now = opts.now ?? (() => Date.now());
    mkdirSync(this.installRoot, { recursive: true });
    this.records = new Map(
      this.readStore().plugins.map((p) => [
        p.id,
        // Records persisted before A9 carry no signature provenance.
        { ...p, signature: p.signature ?? { status: 'unrecorded' as const } },
      ]),
    );
  }

  /** The host's full trusted publisher key set (built-in + env + configured + user trust store). */
  trustedKeys(): string[] {
    return resolveTrustedPluginKeys([...this.trustedPublisherKeys, ...(this.trustStore?.publicKeys() ?? [])]);
  }

  /** Per-invocation RPC options for one plugin, with its declared secrets resolved fresh (values never cached or persisted). */
  private invokeOpts(rec: InstalledPlugin): InvokeOptions {
    if (!this.resolveSecret || !(rec.manifest.secrets?.length)) return this.rpcOpts;
    const secretValues: Record<string, string> = {};
    for (const name of rec.manifest.secrets) {
      const value = this.resolveSecret(name);
      if (typeof value === 'string') secretValues[name] = value;
    }
    return Object.keys(secretValues).length > 0 ? { ...this.rpcOpts, secretValues } : this.rpcOpts;
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
    if (source.type === 'zip' || source.type === 'package') {
      const src = resolve(source.path);
      if (!existsSync(src)) throw new Error(`plugin ${source.type} not found: ${source.path}`);
      extractZipToDir(readFileSync(src), staging);
      return { type: source.type, origin: src };
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

  /** All files under a staged plugin dir as package entries (POSIX names), for signature verification. */
  private collectStagedFiles(staging: string): PackageFileEntry[] {
    const out: PackageFileEntry[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile()) {
          out.push({ name: relative(staging, abs).split(sep).join('/'), data: readFileSync(abs) });
        }
      }
    };
    walk(staging);
    return out;
  }

  /**
   * Install from a directory, a .zip/.kdpkg package file, or a URL. The
   * manifest is parsed and validated BEFORE the approval hook runs (the
   * approver sees exactly what would be installed); on approval the staged
   * tree is moved into plugins/<id>/ and state is persisted. Reinstalling
   * an existing id replaces it (recorded as a fresh install). The plugin
   * is live in this manager the moment install() resolves — no restart.
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

      // A9 signature gate (see the file header for the scoping rules).
      // Verification runs over the STAGED files — exactly the bytes that
      // would be installed — before any approval hook sees the package.
      const stagedFiles = this.collectStagedFiles(staging);
      const carriesSignature = stagedFiles.some((f) => f.name === PLUGIN_SIGNATURE_FILE);
      const isPackageSource = source.type !== 'dir';
      let signature: PluginSignatureInfo;
      if (carriesSignature || isPackageSource) {
        const verification = verifyPackageFiles(stagedFiles, this.trustedKeys());
        signature = {
          status: verification.status,
          ...(verification.keyId ? { keyId: verification.keyId } : {}),
          ...(verification.signerPublicKey ? { signerPublicKey: verification.signerPublicKey } : {}),
        };
        info.signature = signature;
        if (verification.status !== 'verified') {
          // Refused by default. The ONLY way in is the separate,
          // explicitly labelled untrusted-install approval, which
          // replaces the ordinary approval for this install (documented
          // on ApproveUntrustedInstallHook).
          if (!this.approveUntrustedInstall) throw new PluginSignatureError(manifest.id, signature);
          const untrustedApproved = await this.approveUntrustedInstall(manifest, { ...info, signature });
          if (!untrustedApproved) throw new PluginInstallDenied(manifest.id);
          return this.finalizeInstall(staging, manifest, info, signature);
        }
      } else {
        signature = { status: 'local-directory' };
      }

      if (!this.approveInstall) throw new PluginApprovalRequired();
      const approved = await this.approveInstall(manifest, info);
      if (!approved) throw new PluginInstallDenied(manifest.id);

      return this.finalizeInstall(staging, manifest, info, signature);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }
  }

  /** Move an approved staged tree into plugins/<id>/ and persist its record (hot: live in this manager from this line on). */
  private finalizeInstall(
    staging: string,
    manifest: PluginManifest,
    info: PluginInstallSourceInfo,
    signature: PluginSignatureInfo,
  ): InstalledPlugin {
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
      signature,
    };
    this.records.set(manifest.id, record);
    this.persist();
    return { ...record };
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
    this.records = new Map(
      this.readStore().plugins.map((p) => [p.id, { ...p, signature: p.signature ?? { status: 'unrecorded' as const } }]),
    );
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
      try {
        out.push(...(await listPluginTools(rec, this.invokeOpts(rec))));
      } catch (err) {
        // Isolation (QA ws-d): one plugin that crashes/hangs on
        // tools/list must not poison the aggregate listing — the boot
        // path (buildPluginTools) awaits this unwrapped, so a throw
        // here previously lost EVERY plugin's tools and could abort
        // server startup after a full RPC timeout. Skip + warn.
        console.warn(
          `[plugins] skipping tools from plugin "${rec.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return out;
  }

  async callTool(id: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const rec = this.enabledTarget(id);
    return callPluginTool(rec, tool, args, this.invokeOpts(rec));
  }

  async invokeHook(id: string, event: string, payload: unknown) {
    const rec = this.enabledTarget(id);
    return invokePluginHook(rec, event, payload, this.invokeOpts(rec));
  }

  /** All enabled hook plugins, for HookBus registration by the host. */
  hookTargets(): InstalledPlugin[] {
    return this.list().filter((p) => p.enabled && p.manifest.kinds.includes('hook'));
  }

  channelProvider(id: string): PluginMessageProvider {
    const rec = this.enabledTarget(id);
    return createPluginChannelProvider(rec, this.invokeOpts(rec));
  }

  channelProviders(): PluginMessageProvider[] {
    return this.list()
      .filter((p) => p.enabled && p.manifest.kinds.includes('channel'))
      .map((p) => createPluginChannelProvider(p, this.invokeOpts(p)));
  }

  /** A9: descriptor for one enabled declarative-provider plugin. */
  providerDescriptor(id: string): DeclarativeProviderDescriptor {
    return pluginProviderDescriptor(this.enabledTarget(id));
  }

  /**
   * A9: descriptors for every enabled provider plugin — the host's
   * provider registry syncs from this list (install/uninstall/enable/
   * disable are reflected on the next call; there is no cached copy).
   */
  providerDescriptors(): DeclarativeProviderDescriptor[] {
    const out: DeclarativeProviderDescriptor[] = [];
    for (const rec of this.records.values()) {
      if (!rec.enabled || !rec.manifest.kinds.includes('provider')) continue;
      try {
        out.push(pluginProviderDescriptor(rec));
      } catch (err) {
        console.warn(
          `[plugins] skipping provider from plugin "${rec.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return out;
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
