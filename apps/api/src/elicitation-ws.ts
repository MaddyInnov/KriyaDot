// SPDX-License-Identifier: Apache-2.0
/**
 * Elicitation over the companion WebSocket surface (Octomind parity #51).
 *
 * The runtime now has an ElicitationRouter (ar/mcp.ts): hosts register
 * one handler per surface ('chat' | 'cli' | 'ws' | 'acp'). The chat
 * surface was already served by the widget route; this module is the
 * WS-owner surface:
 *
 *  - `createWsElicitationBridge(push)` returns { handler, resolve }.
 *    handler pushes an `elicitation` frame to the connected companion
 *    client(s) and awaits the owner's answer; resolve() is what the
 *    companion hub calls when a client sends
 *    { t:'elicitation_response', id, action, content }.
 *  - `registerCompanionElicitationSurface(router, bridge)` registers
 *    the handler under the 'ws' surface and returns the unregister fn.
 *
 * No answer within the timeout → decline (fail-closed, the router's
 * contract). No connected client → decline immediately.
 *
 * HOST WIRING (parent, index.ts):
 *   const elicitationBridge = createWsElicitationBridge((frame) => companionHub.broadcast(frame as never));
 *   registerCompanionElicitationSurface(defaultElicitationRouter, elicitationBridge);
 *   // and pass elicitationResolve: elicitationBridge.resolveByFrame into
 *   // the CompanionHub options so client answers complete the round-trip,
 *   // plus elicitationRouter: defaultElicitationRouter where MCPClients
 *   // are constructed (tool-registry).
 */

import { randomUUID } from 'node:crypto';
import type { ElicitationHandler, ElicitationRequest, ElicitationResult, ElicitationRouter } from '@mvp/agent-runtime';

export interface WsElicitationFrame {
  type: 'elicitation';
  id: string;
  message: string;
  requestedSchema: Record<string, unknown>;
}

export interface WsElicitationBridge {
  handler: ElicitationHandler;
  /** Complete a pending request from a client frame. Returns false when the id is unknown. */
  resolve: (id: string, result: ElicitationResult) => boolean;
  /** Frame-shaped resolver for the companion hub: accepts the raw client message object. */
  resolveByFrame: (frame: Record<string, unknown>) => boolean;
  pendingCount: () => number;
}

export function createWsElicitationBridge(
  push: (frame: WsElicitationFrame) => boolean | void,
  opts: { timeoutMs?: number } = {},
): WsElicitationBridge {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pending = new Map<string, { resolve: (r: ElicitationResult) => void; timer: ReturnType<typeof setTimeout> }>();

  const handler: ElicitationHandler = async (req: ElicitationRequest) => {
    const id = randomUUID();
    const delivered = push({ type: 'elicitation', id, message: req.message, requestedSchema: req.requestedSchema });
    if (delivered === false) return { action: 'decline' };
    return new Promise<ElicitationResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ action: 'decline' });
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      pending.set(id, { resolve, timer });
    });
  };

  const resolve = (id: string, result: ElicitationResult): boolean => {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(result);
    return true;
  };

  const resolveByFrame = (frame: Record<string, unknown>): boolean => {
    const id = typeof frame.id === 'string' ? frame.id : '';
    if (!id) return false;
    const action = frame.action;
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') return false;
    return resolve(id, {
      action,
      ...(frame.content && typeof frame.content === 'object' ? { content: frame.content as Record<string, unknown> } : {}),
    });
  };

  return { handler, resolve, resolveByFrame, pendingCount: () => pending.size };
}

/** Register the bridge as the router's 'ws' surface. Returns the unregister function. */
export function registerCompanionElicitationSurface(router: ElicitationRouter, bridge: WsElicitationBridge): () => void {
  return router.register('ws', bridge.handler);
}
