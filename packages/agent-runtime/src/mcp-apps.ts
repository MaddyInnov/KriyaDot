// SPDX-License-Identifier: Apache-2.0
// MCP Apps support (OpenMausBot §1.4 parity): MCP servers can ship small
// HTML UIs ("apps") that render sandboxed inside chat.
//
// Wire conventions implemented here (protocol facts of the MCP Apps
// extension, implemented from scratch):
//   - A UI resource is an MCP resource whose URI uses the `ui://` scheme
//     and whose mimeType is `text/html;profile=mcp-app`.
//   - A tool result links to its app via `_meta.ui.resourceUri` on the
//     result (or on an individual content item), or by embedding a
//     resource / resource_link content item pointing at the UI resource.
//
// Security model: the app HTML is served by the API in a sandboxed iframe
// (allow-scripts only, CSP connect-src 'none'), so the app cannot reach
// the network itself. Every interaction crosses a postMessage bridge to
// the host, which relays JSON-RPC to the API bridge endpoint; tool calls
// from the bridge go through the SAME governance evaluation as native
// tool calls. A per-render nonce (issued when the widget is created,
// stored in McpAppNonceStore) binds the bridge session to one
// (serverId, resourceUri) render and expires after a TTL.

import { randomBytes } from 'node:crypto';

/** MIME type (with profile) that marks an MCP resource as an app UI. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** URI scheme for MCP App UI resources. */
export const MCP_APP_URI_SCHEME = 'ui://';

export interface McpAppResource {
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface McpAppLink {
  resourceUri: string;
  /** Display title when the server provided one. */
  title?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when a resources/list entry describes an MCP App UI resource. */
export function isMcpAppResource(resource: McpAppResource): boolean {
  if (!resource || typeof resource.uri !== 'string') return false;
  if (!resource.uri.startsWith(MCP_APP_URI_SCHEME)) return false;
  const mime = typeof resource.mimeType === 'string' ? resource.mimeType : '';
  // Accept the profile form and a bare text/html on a ui:// URI.
  return mime === '' || mime.startsWith('text/html');
}

/** Filter a resources/list result down to app UI resources. */
export function filterMcpAppResources(resources: McpAppResource[]): McpAppResource[] {
  return resources.filter(isMcpAppResource);
}

function uiMetaUri(meta: unknown): string | undefined {
  if (!isRecord(meta)) return undefined;
  const ui = meta.ui;
  if (isRecord(ui)) {
    const uri = ui.resourceUri ?? ui.resource_uri ?? ui.uri;
    if (typeof uri === 'string' && uri.startsWith(MCP_APP_URI_SCHEME)) return uri;
  }
  const flat = meta['ui/resourceUri'];
  if (typeof flat === 'string' && flat.startsWith(MCP_APP_URI_SCHEME)) return flat;
  return undefined;
}

function uiMetaTitle(meta: unknown): string | undefined {
  if (!isRecord(meta)) return undefined;
  const ui = meta.ui;
  if (isRecord(ui) && typeof ui.title === 'string' && ui.title) return ui.title;
  return undefined;
}

/**
 * Extract an MCP App link from a tool-call result. Checks, in order:
 *   1. result._meta.ui.resourceUri
 *   2. each content item's _meta.ui.resourceUri
 *   3. embedded resource content items whose resource is a UI resource
 *   4. resource_link content items with a ui:// URI
 * Returns undefined when the result carries no app link (never throws).
 */
export function extractMcpAppLink(result: unknown): McpAppLink | undefined {
  if (!isRecord(result)) return undefined;
  const top = uiMetaUri(result._meta);
  if (top) return { resourceUri: top, title: uiMetaTitle(result._meta) };
  const content = result.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isRecord(item)) continue;
      const fromMeta = uiMetaUri(item._meta);
      if (fromMeta) return { resourceUri: fromMeta, title: uiMetaTitle(item._meta) };
      if (item.type === 'resource' && isRecord(item.resource)) {
        const res = item.resource as unknown as McpAppResource;
        if (isMcpAppResource(res)) {
          return { resourceUri: res.uri, title: typeof res.name === 'string' ? res.name : undefined };
        }
      }
      if (
        item.type === 'resource_link' &&
        typeof item.uri === 'string' &&
        item.uri.startsWith(MCP_APP_URI_SCHEME)
      ) {
        return {
          resourceUri: item.uri,
          title: typeof item.name === 'string' ? item.name : undefined,
        };
      }
    }
  }
  return undefined;
}

/** Parse the server segment out of a registered MCP tool name `mcp:<server>:<tool>`. */
export function mcpServerIdFromToolName(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp:')) return undefined;
  const rest = toolName.slice('mcp:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return undefined; // legacy mcp:<tool> shape has no server segment
  return rest.slice(0, sep);
}

// ---------------------------------------------------------------------------
// Per-render nonces
// ---------------------------------------------------------------------------

export interface McpAppNonceRecord {
  nonce: string;
  serverId: string;
  resourceUri: string;
  issuedAt: number;
  expiresAt: number;
}

/** Default bridge-session lifetime: 30 minutes per render. */
export const MCP_APP_NONCE_TTL_MS = 30 * 60 * 1000;

/**
 * In-memory store of per-render bridge nonces. The runtime issues a nonce
 * when it raises an mcp-app widget; the API bridge verifies it on every
 * relayed message. Nonces are bound to (serverId, resourceUri), are NOT
 * single-use (a render legitimately makes many bridge calls), and expire
 * after the TTL — `verify` fails closed on unknown/expired/mismatched
 * nonces. Single-process by design: the API and runtime share a process
 * in this deployment, and `defaultMcpAppNonceStore` is the shared
 * instance both sides use unless a test injects its own.
 */
export class McpAppNonceStore {
  private readonly records = new Map<string, McpAppNonceRecord>();
  private readonly ttlMs: number;

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? MCP_APP_NONCE_TTL_MS;
  }

  issue(serverId: string, resourceUri: string, now = Date.now()): McpAppNonceRecord {
    this.sweep(now);
    const record: McpAppNonceRecord = {
      nonce: randomBytes(24).toString('base64url'),
      serverId,
      resourceUri,
      issuedAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.records.set(record.nonce, record);
    return record;
  }

  /** True only for a live nonce bound to exactly this server + resource. */
  verify(nonce: string, serverId: string, resourceUri?: string, now = Date.now()): boolean {
    if (typeof nonce !== 'string' || !nonce) return false;
    const rec = this.records.get(nonce);
    if (!rec) return false;
    if (rec.expiresAt <= now) {
      this.records.delete(nonce);
      return false;
    }
    if (rec.serverId !== serverId) return false;
    if (resourceUri !== undefined && rec.resourceUri !== resourceUri) return false;
    return true;
  }

  get(nonce: string): McpAppNonceRecord | undefined {
    return this.records.get(nonce);
  }

  revoke(nonce: string): void {
    this.records.delete(nonce);
  }

  sweep(now = Date.now()): void {
    for (const [nonce, rec] of this.records) {
      if (rec.expiresAt <= now) this.records.delete(nonce);
    }
  }

  get size(): number {
    return this.records.size;
  }
}

/** Process-wide store shared by the runtime (issue) and the API (verify). */
export const defaultMcpAppNonceStore = new McpAppNonceStore();
