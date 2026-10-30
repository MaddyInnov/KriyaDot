<!-- SPDX-License-Identifier: Apache-2.0 -->
# KriyaDot Agent SDK — Embed & Hosting Guide (CA-20)

The public SDK surface of `@mvp/agent-runtime` lives in **one module**:
`src/sdk.ts` (compiled to `dist/sdk.js`). It carries a versioned
contract (`SDK_API_VERSION = '1'`, `SDK_VERSION = '1.0.0'`): anything
exported from that module is supported; everything else in the package
is internal and may change without a version bump.

> Coordinator note: adding `"./sdk": { "types": "./dist/sdk.d.ts",
> "default": "./dist/sdk.js" }` to this package's `exports` map makes
> the entrypoint importable as `@kriyadot/agent-runtime/sdk`. Until
> then, monorepo consumers import the built file path directly.
> Nothing is published to any registry by this build.

## Quick start (embed in your process)

```ts
import {
  createSdkAgent, defineSdkTool, MockProvider, // MockProvider is for tests
} from '@kriyadot/agent-runtime/sdk';

const weather = defineSdkTool({
  name: 'get_weather',
  description: 'Current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  handler: async (args) => ({ city: args.city, tempC: 21 }),
});

const agent = createSdkAgent({
  provider,                    // any LLMProvider implementation
  tools: [weather],
  // storage: omitted → built-in SQLite store, in-memory
});

const result = await agent.runTurn({
  bot,                         // a BotConfig (id, systemPrompt, model, tools…)
  message: 'Weather in Pune?',
  onEvent: (e) => { /* typed StreamEvent: token | tool_call | tool_result | done … */ },
});
console.log(result.content, result.sessionId);
```

## External session storage

Sessions persist through the `SdkSessionStorage` contract
(`createSession` / `getSession` / `appendMessage` / `getMessages` /
`listSessions`, sync or async). Implement it over your own store
(Redis, Postgres, an existing chat-history service…) and pass it as
`storage:` — the agent reads and writes history ONLY through your
adapter. `BuiltinSessionStorage` (SQLite via `SessionStore`, with
compaction + full-text search) is the default implementation:

```ts
const agent = createSdkAgent({
  provider,
  storage: new BuiltinSessionStorage('/var/lib/myapp/sessions.db'),
});
```

Contract notes: messages are stored verbatim in insertion order;
implementations must tolerate concurrent calls for different
sessions. Same-session calls are serialized by the agent.

## Custom tools — plain and in-process MCP

Plain `defineSdkTool` definitions dispatch in-process with zero
protocol overhead. When tools must behave exactly like an external
MCP server's tools (wire serialization, schema handling), serve them
through the in-process MCP path instead:

```ts
import { createInProcessMcpTools } from '@kriyadot/agent-runtime/sdk';

const { tools, facade } = await createInProcessMcpTools([weather], {
  serverInfo: { name: 'my-tools', version: '1.0.0' },
});
const agent = createSdkAgent({ provider, tools });
// …later: await facade.close();
```

The definitions cross real MCP `tools/list` / `tools/call` JSON-RPC
frames over a loopback transport (the `mcp-facade.ts` substrate);
returned tool names match the input definitions exactly.

## Governance

Mutating tools (`mutating: true`) never run by default. Supply an
`approveToolCall` gate that returns `true` for the specific call, or
set `allowMutatingTools: true` as an explicit policy decision in your
own code. Read-only tools run without a gate. Nothing in the SDK
bypasses the hosted runtime's governance gateway — embedders using
`AgentRuntime` directly wire the full `GovernanceGateway` as before.

## Hosting / deployment topologies

1. **In-process embed (library mode).** The SDK runs inside your
   Node ≥ 22 service. Session storage is your adapter or a SQLite
   file on local disk. Scale by sharding bots/sessions across
   processes; the built-in store is single-writer per file.
2. **Sidecar / service mode.** Run the full KriyaDot API
   (`apps/api`) and talk to it over HTTP/SSE; use the SDK in the
   client for typed events and custom-tool definitions. MCP servers
   (stdio/HTTP) attach at the API layer as usual.
3. **Advanced hosts.** `AgentRuntime` is re-exported from the SDK
   entrypoint for hosts that need the complete runtime (governance
   gateway, skill loader, subagents, hooks). Its options are the
   internal `AgentRuntimeOptions` — powerful, but outside the
   versioned SDK contract.

Operational notes:

- Provider keys stay in YOUR process environment / vault; the SDK
  never persists credentials in session storage.
- The built-in SQLite store needs a writable directory; for
  containers, mount a volume at the DB path or supply your own
  adapter backed by your platform database.
- Stream events are typed (`StreamEvent`); forward `token` events to
  your UI for streaming, and treat `done` as the turn boundary.

## MCP channels

`McpChannelHub` (CA-25) is exported from the SDK entrypoint: an MCP
server's event channel can inject events into a bound live session,
behind a governance gate and a per-channel rate limit. See
`src/mcp-channels.ts` for the wire shape and the fail-closed gate
contract (no gate configured = nothing injects).
