// SPDX-License-Identifier: Apache-2.0
/**
 * CA-25 — host-side MCP channel hub holder.
 *
 * The hub itself lives in @mvp/agent-runtime (mcp-channels.ts): channel
 * registration, session binding, a FAIL-CLOSED governance gate, and a
 * per-channel rate limiter in front of session injection. This module
 * is only the host's single shared instance slot: index.ts constructs
 * the hub with the real injector (AgentRuntime.enqueueSteer) and the
 * governance classifier gate, and any API-side transport that receives
 * channel events (webhooks today; MCPClient factories once threaded)
 * delivers them through `deliverChannelEvent`.
 */
import type { McpChannelHub } from '@mvp/agent-runtime';

let hub: McpChannelHub | null = null;

export function setMcpChannelHub(instance: McpChannelHub): void {
  hub = instance;
}

export function getMcpChannelHub(): McpChannelHub | null {
  return hub;
}
