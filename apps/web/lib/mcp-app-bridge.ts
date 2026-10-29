// SPDX-License-Identifier: Apache-2.0
// MCP App bridge relay (web side).
//
// The sandboxed app iframe cannot reach the network (API serves it with
// CSP connect-src 'none'). It talks JSON-RPC over window.postMessage to
// this parent-side relay, which forwards each request to the API bridge
// endpoint (authed, nonce-bound) and posts the response back into the
// frame. This module holds the pure, testable logic — origin/source
// validation, message parsing, and request/response correlation — while
// the widget component wires it to real window events.

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface BridgeFrameEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

/** Origins a bridge message may come from: the API origin serving the app. */
export function isAllowedBridgeOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.includes(origin);
}

/**
 * Validate an inbound postMessage event as an app→host bridge request.
 * Returns the parsed request, or null when the event must be ignored
 * (wrong origin, wrong source window, or not a JSON-RPC request).
 */
export function parseBridgeRequest(
  event: BridgeFrameEvent,
  opts: { allowedOrigins: readonly string[]; frameSource: unknown },
): JsonRpcMessage | null {
  if (!isAllowedBridgeOrigin(event.origin, opts.allowedOrigins)) return null;
  if (opts.frameSource != null && event.source !== opts.frameSource) return null;
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const msg = data as JsonRpcMessage;
  if (typeof msg.method !== 'string' || !msg.method) return null;
  return msg;
}

/** Build the JSON-RPC response to post back into the frame. */
export function buildBridgeResponse(
  request: JsonRpcMessage,
  outcome: { result?: unknown; error?: { code: number; message: string } },
): JsonRpcMessage {
  const base: JsonRpcMessage = { jsonrpc: '2.0', id: request.id ?? null };
  if (outcome.error) return { ...base, error: outcome.error };
  return { ...base, result: outcome.result ?? null };
}

export interface McpAppBridgeDeps {
  /** POST one JSON-RPC message to the API bridge; resolves with its reply. */
  postToBridge: (message: JsonRpcMessage) => Promise<JsonRpcMessage>;
  /** Deliver a message into the app frame. */
  postToFrame: (message: JsonRpcMessage) => void;
  allowedOrigins: readonly string[];
  /** The iframe's contentWindow (source validation). */
  getFrameSource: () => unknown;
}

/**
 * Stateful relay: correlates responses to requests by id (responses are
 * built from the API reply but re-stamped with the frame's request id, so
 * correlation holds even if the API echoes a different id), and drops
 * anything that fails validation.
 */
export class McpAppBridgeRelay {
  private readonly deps: McpAppBridgeDeps;
  private inFlight = 0;

  constructor(deps: McpAppBridgeDeps) {
    this.deps = deps;
  }

  get pendingCount(): number {
    return this.inFlight;
  }

  /** Handle one message event. Returns true when it was a bridge request. */
  async handleEvent(event: BridgeFrameEvent): Promise<boolean> {
    const request = parseBridgeRequest(event, {
      allowedOrigins: this.deps.allowedOrigins,
      frameSource: this.deps.getFrameSource(),
    });
    if (!request) return false;
    this.inFlight++;
    try {
      const reply = await this.deps.postToBridge(request);
      const response = buildBridgeResponse(request, {
        result: reply.result,
        error: reply.error,
      });
      this.deps.postToFrame(response);
    } catch (err) {
      this.deps.postToFrame(
        buildBridgeResponse(request, {
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : 'bridge request failed',
          },
        }),
      );
    } finally {
      this.inFlight--;
    }
    return true;
  }
}

/**
 * Default postToBridge: POST { nonce, message } to the API bridge
 * endpoint through the app's authed fetch.
 */
export function createBridgePoster(opts: {
  serverId: string;
  nonce: string;
  authedFetch: (path: string, init?: RequestInit) => Promise<Response>;
}): (message: JsonRpcMessage) => Promise<JsonRpcMessage> {
  return async (message) => {
    const res = await opts.authedFetch(
      `/api/mcp-apps/${encodeURIComponent(opts.serverId)}/bridge`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: opts.nonce, message }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as JsonRpcMessage;
    if (!res.ok && !body.error) {
      return {
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: -32603, message: `bridge HTTP ${res.status}` },
      };
    }
    return body;
  };
}

/** Serve URL for an app render (iframe src). The nonce travels as a query param. */
export function mcpAppServeUrl(opts: {
  apiBase: string;
  serverId: string;
  resourceUri: string;
  nonce: string;
}): string {
  return (
    `${opts.apiBase}/api/mcp-apps/${encodeURIComponent(opts.serverId)}/` +
    `${encodeURIComponent(opts.resourceUri)}?nonce=${encodeURIComponent(opts.nonce)}`
  );
}
