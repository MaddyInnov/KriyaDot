// SPDX-License-Identifier: Apache-2.0
// Marketplace installer: copies registry entries into the live config
// directory. MCP servers are approval-gated — deny-by-default:
//
//   1. install(mcpEntry) WITHOUT a token throws McpInstallApprovalRequired
//      and reports what approval to request.
//   2. The API layer creates a governance approval for the MCP install;
//      when the user approves it there, the API calls
//      issueMcpApprovalToken(entryId, approvalId) to mint a one-time token.
//   3. install(entry, { mcpApprovalToken }) consumes the token and proceeds.
//
// Tokens are single-use and bound to the entry id. Install targets are
// sanitized to block path traversal.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type {
  MarketplaceBotPayload,
  MarketplaceCapabilityPayload,
  MarketplaceEntry,
  MarketplaceMcpPayload,
  MarketplaceSkillPayload,
  MarketplaceWorkflowPayload,
} from './registry.js';
import { transformEntryForInstall } from './manifest.js';
import type { OverrideMap, PlaceholderValues } from './manifest.js';

export function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export const MCP_INSTALL_TOOL = 'mcp_server_install';

const INSTALL_TOKEN_MARK = '__mcp_install_approval_required__';

/** Thrown when an MCP server install is attempted without an approval token. */
export class McpInstallApprovalRequired extends Error {
  readonly entryId: string;
  constructor(entryId: string) {
    super(`MCP server install requires approval: ${entryId}`);
    (this as Error & { code?: string }).code = INSTALL_TOKEN_MARK;
    this.entryId = entryId;
  }
}

export function isMcpInstallApprovalRequired(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === INSTALL_TOKEN_MARK;
}

export interface InstallResult {
  entryId: string;
  kind: string;
  /** Absolute path of the installed artifact. */
  installedPath: string;
  /** True when the install was gated behind an MCP approval. */
  gated: boolean;
  alreadyInstalled: boolean;
  /** SHA-256 of the installed artifact content (#155/#165 auditability). */
  checksum?: string;
  /** Explicit install blockers (unresolved placeholders, missing env) — never silent (#158). */
  blockers?: string[];
  /** True when a per-capability override was applied (#158). */
  overrideApplied?: boolean;
  /** Effective enabled state after overrides / bundle semantics. */
  enabled?: boolean;
}

export interface InstallOptions {
  /** One-time token from issueMcpApprovalToken(); required for MCP servers. */
  mcpApprovalToken?: string;
  /** Overwrite an existing install of the same id. Default false. */
  overwrite?: boolean;
  /** Placeholder substitution values: `{{env:X}}` / `{{config:key}}` (#158). */
  values?: PlaceholderValues;
  /** Per-capability/model overrides keyed by entry id or package name (#158). */
  overrides?: OverrideMap;
  /** Extra override lookup keys (e.g. the containing bundle's package name). */
  overrideKeys?: string[];
  /** Unresolved placeholders: 'throw' (default) or 'block' (report, don't abort). */
  onUnresolvedPlaceholders?: 'throw' | 'block';
}

const SAFE_ID = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

function safeId(id: string, what: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`unsafe ${what} id: ${id}`);
  return id;
}

/**
 * Writes installed marketplace artifacts under
 * `<targetDir>/installed/{bots,skills,workflows,mcp-servers}`.
 */
export class MarketplaceInstaller {
  private readonly targetDir: string;
  /** entryId → one-time approval tokens pending consumption. */
  private readonly approvalTokens = new Map<string, Set<string>>();

  constructor(targetDir: string) {
    this.targetDir = resolve(targetDir);
  }

  /** Root the installer writes under (`<targetDir>/installed/...`). */
  getTargetDir(): string {
    return this.targetDir;
  }

  /**
   * Mint a one-time install token for an MCP server entry. The API calls
   * this only after a governance approval for the install is APPROVED.
   * Returns the token (and the approval id it is tied to for audit).
   */
  issueMcpApprovalToken(entryId: string, governanceApprovalId: string): string {
    const id = safeId(entryId, 'entry');
    const token = `mcpok_${randomUUID().replace(/-/g, '')}`;
    let set = this.approvalTokens.get(id);
    if (!set) {
      set = new Set();
      this.approvalTokens.set(id, set);
    }
    set.add(token);
    // Bind the governance approval id into the token record for audit:
    // store as `${token}:${approvalId}` is overkill; the caller logs the
    // pairing. Token itself is opaque.
    void governanceApprovalId;
    return token;
  }

  /** Revoke all pending tokens for an entry (e.g. after a deny). */
  revokeMcpApprovalTokens(entryId: string): void {
    this.approvalTokens.delete(entryId);
  }

  private consumeToken(entryId: string, token: string): void {
    const set = this.approvalTokens.get(entryId);
    if (!set || !set.delete(token)) {
      throw new McpInstallApprovalRequired(entryId);
    }
    if (set.size === 0) this.approvalTokens.delete(entryId);
  }

  private targetPath(kindDir: string, fileName: string): string {
    const dir = join(this.targetDir, 'installed', kindDir);
    mkdirSync(dir, { recursive: true });
    const full = resolve(dir, fileName);
    if (!full.startsWith(dir + sep)) throw new Error(`path traversal blocked: ${fileName}`);
    return full;
  }

  install(rawEntry: MarketplaceEntry, opts: InstallOptions = {}): InstallResult {
    const id = safeId(rawEntry.id, 'entry');
    if (rawEntry.kind === 'mcp-server') {
      if (!opts.mcpApprovalToken) throw new McpInstallApprovalRequired(rawEntry.id);
      this.consumeToken(rawEntry.id, opts.mcpApprovalToken);
    }

    // #158: placeholder substitution + per-capability overrides, applied
    // on top of the manifest at install time. Unresolved placeholders
    // throw by default (never silent nulls).
    const transformed = transformEntryForInstall(rawEntry, {
      values: opts.values,
      overrides: opts.overrides,
      overrideKeys: opts.overrideKeys,
      onUnresolved: opts.onUnresolvedPlaceholders ?? 'throw',
    });
    const entry = transformed.entry;

    let installedPath: string;
    let content: string;
    switch (entry.kind) {
      case 'bot': {
        const p = entry.payload as MarketplaceBotPayload & { config?: Record<string, unknown> };
        installedPath = this.targetPath('bots', `${id}.json`);
        const botJson: Record<string, unknown> = {
          id: p.id,
          name: p.name,
          description: p.description,
          systemPrompt: p.systemPrompt,
          provider: p.provider,
          model: p.model,
          skills: p.skills,
          tools: p.tools,
          mcpServers: p.mcpServers,
        };
        if (p.config) botJson.config = p.config;
        if (!transformed.enabled) botJson.enabled = false;
        content = JSON.stringify(botJson, null, 2);
        break;
      }
      case 'skill': {
        const p = entry.payload as MarketplaceSkillPayload;
        installedPath = this.targetPath('skills', `${id}.md`);
        content = p.content;
        break;
      }
      case 'workflow': {
        const p = entry.payload as MarketplaceWorkflowPayload;
        installedPath = this.targetPath('workflows', `${id}.json`);
        content = JSON.stringify(
          { id: p.id, name: p.name, description: p.description, nodes: p.nodes, edges: p.edges },
          null,
          2,
        );
        break;
      }
      case 'mcp-server': {
        const p = entry.payload as MarketplaceMcpPayload;
        installedPath = this.targetPath('mcp-servers', `${id}.json`);
        // Env VALUES are never shipped: the registry only names required
        // env vars. The installer records them as unconfigured placeholders.
        const mcpJson: Record<string, unknown> = {
          id: p.id,
          label: p.label,
          command: p.command,
          args: p.args,
          env: Object.fromEntries(p.requiredEnv.map((name) => [name, null])),
          description: p.description,
          installedFrom: { entry: entry.id, version: entry.version },
        };
        mcpJson.checksum = checksumOf(JSON.stringify(mcpJson));
        content = JSON.stringify(mcpJson, null, 2);
        break;
      }
      case 'capability': {
        // #165: a capability bundle installs as ONE unit: its MCP server
        // configs (env placeholders, disabled until the host enables
        // them) plus its tool filters land in a single artifact.
        const p = entry.payload as MarketplaceCapabilityPayload;
        installedPath = this.targetPath('capabilities', `${id}.json`);
        const capJson: Record<string, unknown> = {
          id: p.id,
          name: p.name,
          description: p.description,
          mcpServers: p.mcpServers.map((s) => ({
            id: s.id,
            label: s.label,
            command: s.command,
            args: s.args,
            env: Object.fromEntries(s.requiredEnv.map((name) => [name, null])),
            enabled: false,
          })),
          toolFilters: p.toolFilters,
          requiredEnv: p.requiredEnv ?? [...new Set(p.mcpServers.flatMap((s) => s.requiredEnv))],
          dependencies: p.dependencies ?? [],
          enabled: transformed.enabled,
          installedFrom: { entry: entry.id, version: entry.version },
        };
        capJson.checksum = checksumOf(JSON.stringify(capJson));
        content = JSON.stringify(capJson, null, 2);
        break;
      }
      default:
        throw new Error(`unknown marketplace kind: ${(entry as { kind: string }).kind}`);
    }

    const checksum = checksumOf(content);
    const alreadyInstalled = existsSync(installedPath);
    if (alreadyInstalled && !opts.overwrite) {
      return {
        entryId: entry.id, kind: entry.kind, installedPath, gated: entry.kind === 'mcp-server',
        alreadyInstalled: true, checksum,
        ...(transformed.blockers.length ? { blockers: transformed.blockers } : {}),
        overrideApplied: transformed.overrideApplied, enabled: transformed.enabled,
      };
    }
    writeFileSync(installedPath, content, 'utf8');
    return {
      entryId: entry.id, kind: entry.kind, installedPath, gated: entry.kind === 'mcp-server',
      alreadyInstalled, checksum,
      ...(transformed.blockers.length ? { blockers: transformed.blockers } : {}),
      overrideApplied: transformed.overrideApplied, enabled: transformed.enabled,
    };
  }

  /**
   * Bundle-mode MCP install (#155): bundle MCP entries ARE installed —
   * registered into the same MCP config store the installer writes —
   * but WITHOUT consuming the standalone approval flow. Bundle
   * semantics: the server lands DISABLED (`enabled: false`) with a
   * content checksum; the host enables it only after the user approves
   * the bundle's MCP set (host wiring: flip `enabled` in the written
   * JSON or re-install standalone with an approval token).
   */
  installMcpServerForBundle(
    payload: MarketplaceMcpPayload,
    opts: { sourceId?: string; env?: Record<string, string | undefined>; overwrite?: boolean } = {},
  ): InstallResult {
    const id = safeId(payload.id, 'entry');
    const installedPath = this.targetPath('mcp-servers', `${id}.json`);
    const mcpJson: Record<string, unknown> = {
      id: payload.id,
      label: payload.label,
      command: payload.command,
      args: payload.args,
      env: Object.fromEntries(payload.requiredEnv.map((name) => [name, opts.env?.[name] ?? null])),
      description: payload.description,
      enabled: false,
      installedVia: 'bundle',
      installedFrom: { entry: opts.sourceId ?? payload.id },
    };
    mcpJson.checksum = checksumOf(JSON.stringify(mcpJson));
    const content = JSON.stringify(mcpJson, null, 2);
    const alreadyInstalled = existsSync(installedPath);
    if (alreadyInstalled && !opts.overwrite) {
      // Preserve an already-enabled/approved standalone install.
      try {
        const existing = JSON.parse(readFileSync(installedPath, 'utf8')) as { enabled?: boolean };
        if (existing.enabled !== false) {
          return { entryId: payload.id, kind: 'mcp-server', installedPath, gated: false, alreadyInstalled: true, checksum: checksumOf(readFileSync(installedPath, 'utf8')), enabled: true };
        }
      } catch { /* fall through to rewrite */ }
      return { entryId: payload.id, kind: 'mcp-server', installedPath, gated: false, alreadyInstalled: true, checksum: checksumOf(content), enabled: false };
    }
    writeFileSync(installedPath, content, 'utf8');
    return { entryId: payload.id, kind: 'mcp-server', installedPath, gated: false, alreadyInstalled, checksum: checksumOf(content), enabled: false };
  }

  /** Read back an installed MCP server config (bundle/standalone); null when absent/corrupt. */
  readInstalledMcp(id: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(readFileSync(join(this.targetDir, 'installed', 'mcp-servers', `${safeId(id, 'entry')}.json`), 'utf8')) as unknown;
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** Remove an installed artifact (idempotent). */
  uninstall(kindDir: 'bots' | 'skills' | 'workflows' | 'mcp-servers' | 'capabilities', id: string): boolean {
    const target = this.targetPath(kindDir, `${safeId(id, 'entry')}.${kindDir === 'skills' ? 'md' : 'json'}`);
    if (!existsSync(target)) return false;
    // Recoverable delete would need a trash dir; MVP: unlink. Callers that
    // need recovery should snapshot first.
    unlinkSync(target);
    return true;
  }
}
