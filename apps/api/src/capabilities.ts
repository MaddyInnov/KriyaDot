// SPDX-License-Identifier: Apache-2.0
// Capability Awareness Layer (closure addendum ADD-2): a GENERATED,
// product-wide capability registry for KriyaDot.
//
// Requirement (Ashutosh, 2026-10-30): every agent/feature must be AWARE of
// what exists in KriyaDot and what can be done by which feature, so agents
// and tools can be called seamlessly with minimal user instruction.
// Per-bot tool/skill awareness already existed; what was missing is this
// single product-wide map covering FEATURES (Workflows, Marketplace,
// Fusion, Lightning cloud + placement + anchors, Feed, Pages, federation…)
// alongside the live catalogs.
//
// GENERATED, never hand-maintained: bot, tool, skill, workflow, plugin and
// channel entries are enumerated from the real registries the host passes
// in (roster, shared tool registry, skill catalog, workflow list, plugin
// manager, channel providers). Only the product-FEATURE entries are a
// curated descriptor table (features have no catalog), and every one of
// them references a real tool name or route verified in this codebase.
//
// Consumption paths:
//   - buildCapabilitySummary() → compact, token-bounded one-liners for
//     system-prompt injection (Chief + Universal anchor; see
//     buildCapabilityPromptSection + the provider wired in chief-wiring.ts).
//   - searchCapabilities() → deterministic plain-language ranking behind
//     the `discover_capabilities` tool (capability-tools.ts) and
//     GET /api/capabilities?q= (capabilities-routes.ts).
//   - suggestCapabilityHandoffs() → structured "start that flow in place"
//     suggestions when a request belongs to another feature.
//
// HOST WIRING (index.ts — see the WIRING note in the build report):
//   const capabilityService = createCapabilityService({
//     bots: () => seed.bots,
//     tools: () => [...toolRegistry.values()],
//     skills: () => skillSummaries,            // SkillLoader/UserSkillStore
//     workflows: () => seed.workflows,
//     plugins: () => pluginManager.list(),
//     channels: () => listChannelIds().map((id) => ({ id })),
//   });
//   registerCapabilityTools({ registry: toolRegistry, service: capabilityService });
//   grantCapabilityToolsToBots(seed.bots);
//   app.use('/api/capabilities', createCapabilitiesRouter({ service: capabilityService }));
//   // + capabilityToolsPolicyRules() prepended to the global policy, and
//   // registerChiefToolsWiring({ ..., capabilityService }) for the prompt
//   // section (chief-wiring builds a bots+tools default when not passed).

import { ftsTerms } from '@mvp/agent-runtime';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CapabilityKind =
  | 'bot'
  | 'tool'
  | 'skill'
  | 'workflow'
  | 'plugin'
  | 'channel'
  | 'feature';

/** How a capability is invoked: hand a bot the work, call a tool, or start a flow. */
export interface CapabilityInvoke {
  type: 'bot' | 'tool' | 'flow';
  /** For type 'bot': the roster bot id. */
  botId?: string;
  /** For type 'tool': the exact tool name in the shared registry. */
  toolName?: string;
  /** For type 'flow': the real route the flow starts at, when it has one. */
  route?: string;
  /** Human-readable how-to, safe to show an agent or the user. */
  description: string;
}

export interface CapabilityEntry {
  /** Stable id: `<kind>:<slug>` (tool entries keep the exact tool name). */
  id: string;
  name: string;
  whatItDoes: string;
  whenToUse: string;
  howToInvoke: CapabilityInvoke;
  kind: CapabilityKind;
  /** Grouping label for the summary (tool category, 'Bots', 'Features', …). */
  group: string;
  /** Extra search phrases (plain language users actually type). */
  keywords: string[];
  /**
   * When set, this capability can be handed a request that starts in chat:
   * suggestCapabilityHandoffs() surfaces it as a structured action.
   */
  handoffLabel?: string;
}

export interface CapabilityRegistry {
  entries: CapabilityEntry[];
  generatedAt: string;
  counts: Record<CapabilityKind, number>;
}

/** Structural inputs — the host adapts its real catalog objects to these. */
export interface CapabilityBotInput {
  id: string;
  name: string;
  description?: string;
  routeKeywords?: string[];
  chiefOfStaff?: boolean;
}
export interface CapabilityToolInput {
  name: string;
  description: string;
  mutating?: boolean;
}
export interface CapabilitySkillInput {
  name: string;
  description: string;
}
export interface CapabilityWorkflowInput {
  id: string;
  name: string;
  description?: string;
}
export interface CapabilityPluginInput {
  id: string;
  name?: string;
  description?: string;
  enabled: boolean;
  kinds?: string[];
}
export interface CapabilityChannelInput {
  id: string;
  name?: string;
}

export interface CapabilityRegistryDeps {
  bots?: () => CapabilityBotInput[];
  tools?: () => CapabilityToolInput[];
  skills?: () => CapabilitySkillInput[];
  workflows?: () => CapabilityWorkflowInput[];
  plugins?: () => CapabilityPluginInput[];
  channels?: () => CapabilityChannelInput[];
  /** Override the curated feature table (tests); default PRODUCT_FEATURES. */
  features?: ProductFeatureDescriptor[];
  now?: () => Date;
}

export interface ProductFeatureDescriptor {
  slug: string;
  name: string;
  whatItDoes: string;
  whenToUse: string;
  invoke: CapabilityInvoke;
  keywords: string[];
  handoffLabel?: string;
}

// ---------------------------------------------------------------------------
// Product feature descriptors (curated — features have no catalog).
// Every tool name / route below is real in this codebase:
//   schedule_task (schedule-tools.ts), publish_page (publish-tools.ts),
//   coordinate_bots (agent-runtime tools/chief.ts), computer_screenshot
//   (agent-runtime tools/computer.ts), list_pending_approvals
//   (permissions-tools.ts), POST /api/universal/chat (universal-routes.ts),
//   POST /api/fusion/runs (fusion-routes.ts), POST /api/workflows/:id/run
//   (routes.ts), POST /api/marketplace/:id/install (marketplace.ts),
//   /api/cloud/lightning/* (cloud-routes.ts), /api/placement
//   (placement.ts createPlacementRouter), /api/sync/* (sync-routes.ts),
//   /api/federation/* (federation-routes.ts), POST /api/voice/calls
//   (voice-call-routes.ts), Feed (muse-modules.ts feed router).
// ---------------------------------------------------------------------------

export const PRODUCT_FEATURES: ProductFeatureDescriptor[] = [
  {
    slug: 'universal-chat',
    name: 'Universal Chat',
    whatItDoes:
      'The bot-less front door: the user just types, and each message is routed automatically — answered directly by the anchor bot, handed to a specialist bot, or split across bots by Fusion.',
    whenToUse: 'When the user wants help without choosing a bot or a screen first.',
    invoke: {
      type: 'flow',
      route: 'POST /api/universal/chat',
      description: 'The user talks in Universal Chat; routing (@mention, keyword score, split detection) picks who executes.',
    },
    keywords: ['chat', 'front door', 'routing', 'just ask', 'no bot selection', 'universal'],
  },
  {
    slug: 'fusion',
    name: 'Fusion (parallel split execution)',
    whatItDoes:
      'Decomposes a multi-part request into subtasks, runs them in parallel with different bots/models, and synthesizes one answer.',
    whenToUse: 'When one request clearly contains several independent parts that should run in parallel.',
    invoke: {
      type: 'flow',
      route: 'POST /api/fusion/runs',
      description: 'Start a Fusion run, or let Universal Chat take its split path for a clearly multi-part message.',
    },
    keywords: ['parallel', 'split', 'multi-part', 'decompose', 'several things at once', 'synthesize'],
  },
  {
    slug: 'chief-of-staff',
    name: 'Chief of Staff coordination',
    whatItDoes:
      'The chief bot coordinates the whole roster: it delegates work to specialist bots, proposes team setups, and escalates to the user only when a decision is genuinely needed.',
    whenToUse: 'When a request spans several bots or nobody obvious owns it — let the chief route and coordinate.',
    invoke: {
      type: 'tool',
      toolName: 'coordinate_bots',
      description: 'The chief calls coordinate_bots (chief-only tool) to delegate to roster bots and collect results.',
    },
    keywords: ['coordinate', 'delegate', 'team', 'orchestrate', 'chief', 'manager bot'],
  },
  {
    slug: 'workflows',
    name: 'Workflows',
    whatItDoes:
      'The workflow engine runs saved multi-step workflows (nodes, branches, triggers, budgets) deterministically, the same way every time.',
    whenToUse: 'When the user wants a repeatable multi-step process run exactly as defined, or wants one defined for reuse.',
    invoke: {
      type: 'flow',
      route: 'POST /api/workflows/:id/run',
      description: 'Run a defined workflow via POST /api/workflows/:id/run; workflows are defined in the Workflows surface.',
    },
    keywords: ['workflow', 'pipeline', 'multi-step process', 'repeatable process', 'automation flow'],
    handoffLabel: 'Run or create a workflow',
  },
  {
    slug: 'automations',
    name: 'Schedules, routines & recurring jobs',
    whatItDoes:
      'Turns any bot task into a scheduled or recurring job (routines): daily digests, periodic checks, monitors and reminders that fire on their own.',
    whenToUse: 'When the user says "every day", "keep an eye on", "remind me", or wants anything to happen repeatedly without asking again.',
    invoke: {
      type: 'tool',
      toolName: 'schedule_task',
      description: 'Call the schedule_task tool with the task and its schedule; list_schedules / cancel_schedule manage existing jobs.',
    },
    keywords: ['recurring job', 'schedule', 'every day', 'daily', 'weekly', 'cron', 'routine', 'repeat', 'monitor', 'remind me', 'keep checking'],
    handoffLabel: 'Schedule it as a recurring job',
  },
  {
    slug: 'marketplace-store',
    name: 'Marketplace / Store',
    whatItDoes:
      'One storefront for everything installable: plugins, skills, bots, workflows and MCP servers, each installed through its existing governance flow.',
    whenToUse: 'When the user wants a capability KriyaDot does not have yet, or wants to browse/install something new.',
    invoke: {
      type: 'flow',
      route: 'POST /api/marketplace/:id/install',
      description: 'Find the item in the Store (Marketplace surface) and install it; installs stay approval-gated per kind.',
    },
    keywords: ['install', 'marketplace', 'store', 'plugin', 'add a skill', 'get a new bot', 'browse catalog', 'mcp server'],
    handoffLabel: 'Find and install it from the Store',
  },
  {
    slug: 'pages-publishing',
    name: 'Pages publishing',
    whatItDoes:
      'Publishes content as public web pages (hosted pages with shareable links), and unpublishes them again.',
    whenToUse: 'When the user wants a document, report or page published as a link someone else can open.',
    invoke: {
      type: 'tool',
      toolName: 'publish_page',
      description: 'Call the publish_page tool (approval-gated); page_publication_status checks a page, unpublish_page takes it down.',
    },
    keywords: ['publish', 'public page', 'share a link', 'web page', 'host this', 'landing page'],
    handoffLabel: 'Publish it as a page',
  },
  {
    slug: 'lightning-cloud',
    name: 'Lightning cloud',
    whatItDoes:
      'Connects this local instance to the user\'s hosted cloud instance, so work can run in the cloud and be reached from anywhere through the front door.',
    whenToUse: 'When the user wants their KriyaDot reachable or running while their own machine is off or away.',
    invoke: {
      type: 'flow',
      route: 'POST /api/cloud/lightning/connect',
      description: 'Connect via POST /api/cloud/lightning/connect; status at GET /api/cloud/lightning/status.',
    },
    keywords: ['cloud', 'lightning', 'hosted', 'remote', 'access from anywhere', 'pc is off', 'machine off'],
    handoffLabel: 'Connect Lightning cloud',
  },
  {
    slug: 'execution-placement',
    name: 'Execution placement',
    whatItDoes:
      'Per-bot placement chooses where work executes: on this device, in the cloud with results reported back, or cloud-only — independent of where the chat happens.',
    whenToUse: 'When the user cares WHERE a bot or job runs (this device vs the cloud), not just what it does.',
    invoke: {
      type: 'flow',
      route: '/api/placement',
      description: 'Placement is read and set through the placement API (/api/placement, PUT /api/placement/default) and the bot placement settings.',
    },
    keywords: ['placement', 'run in the cloud', 'run locally', 'where does it run', 'cloud only', 'report back'],
    handoffLabel: 'Change where this runs',
  },
  {
    slug: 'automation-anchors',
    name: 'Automation anchors (runs while your PC is off)',
    whatItDoes:
      'Scheduled automations are anchored to the cloud by default when a cloud instance is connected, so they fire on time even while the local PC is off, and report back instantly plus in a daily digest.',
    whenToUse: 'When a recurring job must fire while the user\'s computer is off, asleep, or closed — anchor it to the cloud, never to the local machine.',
    invoke: {
      type: 'flow',
      route: '/api/placement',
      description: 'Anchor resolution lives with placement (apps/api placement: resolveRoutineAnchor); a connected cloud instance makes cloud the default anchor for time-based routines.',
    },
    keywords: ['run while the pc is off', 'computer is off', 'while my pc is off', 'machine off', 'offline', 'unattended', 'fires anyway', 'cloud anchored', 'anchor'],
    handoffLabel: 'Anchor it to the cloud',
  },
  {
    slug: 'device-sync',
    name: 'Cross-device sync',
    whatItDoes:
      'Chat history and synced routines/bots sync between the user\'s devices through their own cloud instance as the sync hub; each bot can be marked local-only.',
    whenToUse: 'When the user works across devices and wants the same history and automations everywhere.',
    invoke: {
      type: 'flow',
      route: 'POST /api/sync/push',
      description: 'Sync runs through /api/sync/* (link-token, push, pull) against the user\'s own instance; it is append-only by message id.',
    },
    keywords: ['sync', 'across devices', 'same history everywhere', 'phone and pc', 'sync hub'],
  },
  {
    slug: 'feed',
    name: 'Feed',
    whatItDoes:
      'A generated content feed tuned to the user\'s taste: items are produced on a schedule (the muse-feed-dispatch workflow) and refreshed against learned preferences.',
    whenToUse: 'When the user wants a steady, personalized stream of generated content rather than one-off answers.',
    invoke: {
      type: 'flow',
      description: 'Open the Feed surface; feed generation is scheduled as the muse-feed-dispatch workflow and taste is refreshed from the Feed controls.',
    },
    keywords: ['feed', 'content stream', 'daily digest content', 'personalized feed', 'taste'],
  },
  {
    slug: 'federation',
    name: 'Federation (peer instances & experts)',
    whatItDoes:
      'Links KriyaDot instances as peers: invite, accept, and consult expert bots on another instance as if they were on the roster.',
    whenToUse: 'When the expertise lives on someone else\'s instance, or the user wants to share a bot with a peer.',
    invoke: {
      type: 'flow',
      route: 'GET /api/federation/peers',
      description: 'Peers are managed under /api/federation/* (identity, invites, peers, per-peer experts).',
    },
    keywords: ['federation', 'peer', 'another instance', 'remote expert', 'invite', 'share a bot'],
  },
  {
    slug: 'computer-use',
    name: 'Computer use (real desktop control)',
    whatItDoes:
      'Bots can see and operate the user\'s real desktop: screenshots, mouse clicks, typing, hotkeys, opening apps and filling forms — every mutating action approval-gated.',
    whenToUse: 'When a task can only be done in a real app or GUI (no API): open an app, fill a form, click through a native program.',
    invoke: {
      type: 'tool',
      toolName: 'computer_screenshot',
      description: 'The computer_* tool family (computer_screenshot, computer_click, computer_type, computer_key, computer_open_app, …) on the calling bot\'s own computer surface.',
    },
    keywords: ['computer use', 'desktop', 'click', 'type for me', 'open the app', 'gui', 'screen', 'fill the form', 'real machine', 'mouse'],
  },
  {
    slug: 'voice-calls',
    name: 'Voice calls',
    whatItDoes:
      'Places and manages real voice calls with a bot talking: call providers are configured once, then a call is started with a bot and a number.',
    whenToUse: 'When the user wants a bot to actually phone someone (or take a call), not send text.',
    invoke: {
      type: 'flow',
      route: 'POST /api/voice/calls',
      description: 'Start a call via POST /api/voice/calls (providers at GET /api/voice/call-providers); end it via POST /api/voice/calls/:id/end.',
    },
    keywords: ['voice call', 'phone call', 'call someone', 'ring', 'dial', 'talk on the phone'],
  },
  {
    slug: 'messaging-channels',
    name: 'Messaging channels',
    whatItDoes:
      'Bots converse with users where they already are — WhatsApp, Telegram, Discord, Slack and webhooks — each channel with its own instructions and responder rules.',
    whenToUse: 'When the user wants to reach someone, or be reached by a bot, on a messaging app instead of inside KriyaDot.',
    invoke: {
      type: 'flow',
      route: '/api/messaging/channels',
      description: 'Channels are configured under /api/messaging/channels; channel turns run the configured responder bot. See the per-channel entries in this registry for what is connected.',
    },
    keywords: ['whatsapp', 'telegram', 'discord', 'slack', 'message someone', 'send a message', 'channel', 'chat app'],
  },
  {
    slug: 'approvals-governance',
    name: 'Approvals & permissions',
    whatItDoes:
      'Every state-changing action passes governance: approvals the user decides, lasting "always allow" grants, and per-target allowances — all inspectable and revocable by the user.',
    whenToUse: 'When the user asks what is waiting on them, what a bot is allowed to do, or wants a risky action checked first.',
    invoke: {
      type: 'tool',
      toolName: 'list_pending_approvals',
      description: 'list_pending_approvals / list_active_grants / list_allowances are read-only inspection tools; grants change only in the Permissions pane, by the user.',
    },
    keywords: ['approval', 'permission', 'waiting on me', 'allowed to', 'grant', 'safety', 'pending'],
  },
  {
    slug: 'capability-discovery',
    name: 'Capability discovery',
    whatItDoes:
      'This registry, queryable in plain language: any bot can ask what in KriyaDot can do something and get back the exact bot, tool or flow — instead of failing or asking the user to navigate.',
    whenToUse: 'Whenever you are unsure which feature, bot or tool handles a need — ask discovery first.',
    invoke: {
      type: 'tool',
      toolName: 'discover_capabilities',
      description: 'Call discover_capabilities with a plain-language query; discover_specialists ranks bots for an intent.',
    },
    keywords: ['discover', 'what can do', 'is there a way', 'which bot', 'which feature', 'find a capability'],
  },
];

// ---------------------------------------------------------------------------
// Tool categorization (the shared registry carries no category field, so
// the group is derived deterministically from the tool name — MCP tools
// group by their server, everything else by its tool family).
// ---------------------------------------------------------------------------

const CODING_TOOLS = new Set([
  'read_file', 'write_file', 'edit', 'edit_file', 'patch', 'glob', 'grep',
  'lsp_definition', 'lsp_hover', 'search_code_semantic', 'run_command',
]);

export function categorizeTool(name: string): string {
  if (name.startsWith('mcp:')) {
    const server = name.split(':')[1];
    return server ? `MCP · ${server}` : 'MCP tools';
  }
  if (name.startsWith('computer_')) return 'Computer use';
  if (name.startsWith('phone_')) return 'Phone control';
  if (name.startsWith('git_') || CODING_TOOLS.has(name) || name.startsWith('lsp_')) return 'Files & code';
  if (name === 'web_search' || name === 'web_fetch' || name.startsWith('browser_')) return 'Web & browser';
  if (name.includes('memory') || name.startsWith('recall_')) return 'Memory';
  if (name.includes('schedule') || name.includes('monitor') || name.includes('trigger')) return 'Scheduling';
  if (name.includes('skill')) return 'Skills';
  if (
    name === 'delegate' || name.startsWith('delegate_') || name === 'ask_bot' ||
    name === 'message_bot' || name === 'coordinate_bots' || name.startsWith('spawn_') ||
    name.includes('subagent') || name === 'discover_specialists'
  ) return 'Delegation & teams';
  if (name.startsWith('composio_')) return 'Connected apps';
  if (name.includes('workflow')) return 'Workflows';
  if (name.includes('publish') || name.includes('page')) return 'Publishing';
  if (name.includes('purchase')) return 'Purchasing';
  if (name.includes('voice') || name.includes('call')) return 'Voice';
  if (name.includes('permission') || name.includes('approval') || name.includes('allowance')) return 'Permissions';
  return 'General';
}

// ---------------------------------------------------------------------------
// Registry generation
// ---------------------------------------------------------------------------

function firstSentences(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (sentenceEnd > 40 ? cut.slice(0, sentenceEnd + 1) : `${cut.trimEnd()}…`).trim();
}

function tokensOf(text: string): string[] {
  return ftsTerms(text.toLowerCase());
}

function uniqueTokens(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const tok of tokensOf(t)) out.add(tok);
  return [...out];
}

export function buildCapabilityRegistry(deps: CapabilityRegistryDeps): CapabilityRegistry {
  const entries: CapabilityEntry[] = [];
  const generatedAt = (deps.now ? deps.now() : new Date()).toISOString();

  // Bots — enumerated from the live roster.
  for (const bot of deps.bots?.() ?? []) {
    const domains = (bot.routeKeywords ?? []).filter((k) => typeof k === 'string' && k.trim());
    entries.push({
      id: `bot:${bot.id}`,
      name: bot.name,
      whatItDoes: firstSentences(bot.description || `${bot.name} — a KriyaDot bot.`, 240),
      whenToUse: domains.length > 0
        ? `When the request concerns ${domains.slice(0, 6).join(', ')}.`
        : `When the request fits this bot's role${bot.chiefOfStaff ? ' (it is the Chief of Staff / Universal anchor)' : ''}.`,
      howToInvoke: {
        type: 'bot',
        botId: bot.id,
        description: `Mention @${bot.name} in Universal Chat, open a chat with ${bot.name}, or (chief/delegation paths) delegate to bot id "${bot.id}".`,
      },
      kind: 'bot',
      group: 'Bots',
      keywords: uniqueTokens([bot.name, bot.id, ...domains]),
    });
  }

  // Tools — enumerated from the shared tool registry, grouped by category.
  for (const tool of deps.tools?.() ?? []) {
    const group = categorizeTool(tool.name);
    entries.push({
      id: `tool:${tool.name}`,
      name: tool.name,
      whatItDoes: firstSentences(tool.description || tool.name, 240),
      whenToUse: `When a task needs the "${tool.name}" action${tool.mutating ? ' (state-changing — governance applies)' : ''}.`,
      howToInvoke: {
        type: 'tool',
        toolName: tool.name,
        description: `Call the ${tool.name} tool directly (subject to the calling bot's tool allowlist and governance).`,
      },
      kind: 'tool',
      group,
      keywords: uniqueTokens([tool.name.replace(/_/g, ' '), group]),
    });
  }

  // Skills — enumerated from the skill catalog (SkillLoader / skill store).
  for (const skill of deps.skills?.() ?? []) {
    entries.push({
      id: `skill:${skill.name}`,
      name: skill.name,
      whatItDoes: firstSentences(skill.description || skill.name, 240),
      whenToUse: 'When a task matches this skill — load its full instructions with read_skill before relying on it.',
      howToInvoke: {
        type: 'tool',
        toolName: 'read_skill',
        description: `Call read_skill with the skill name "${skill.name}" to load its full instructions.`,
      },
      kind: 'skill',
      group: 'Skills',
      keywords: uniqueTokens([skill.name.replace(/[-_]/g, ' '), skill.description]),
    });
  }

  // Workflows — one entry per defined workflow (the engine itself is the
  // 'workflows' feature entry, whose text carries the live count).
  const workflows = deps.workflows?.() ?? [];
  for (const wf of workflows) {
    entries.push({
      id: `workflow:${wf.id}`,
      name: wf.name,
      whatItDoes: firstSentences(wf.description || `Runs the "${wf.name}" workflow.`, 240),
      whenToUse: 'When the user wants this exact saved process run as defined.',
      howToInvoke: {
        type: 'flow',
        route: 'POST /api/workflows/:id/run',
        description: `Run it via POST /api/workflows/${wf.id}/run (workflow id "${wf.id}").`,
      },
      kind: 'workflow',
      group: 'Workflows',
      keywords: uniqueTokens([wf.name, wf.id]),
    });
  }

  // Plugins — enumerated from the plugin manager's installed list.
  for (const plugin of deps.plugins?.() ?? []) {
    const kinds = plugin.kinds ?? [];
    entries.push({
      id: `plugin:${plugin.id}`,
      name: plugin.name || plugin.id,
      whatItDoes: firstSentences(
        plugin.description || `Installed plugin "${plugin.id}"${kinds.length ? ` (contributes: ${kinds.join(', ')})` : ''}.`,
        240,
      ),
      whenToUse: plugin.enabled
        ? 'When what this plugin contributes is relevant — its tools appear in the tool catalog above.'
        : 'Currently disabled — the user can enable it in the Plugins surface.',
      howToInvoke: {
        type: 'flow',
        description: `Plugin "${plugin.id}" is ${plugin.enabled ? 'enabled' : 'installed but disabled'}; manage it in the Plugins surface.`,
      },
      kind: 'plugin',
      group: 'Plugins',
      keywords: uniqueTokens([plugin.id, plugin.name ?? '', ...kinds]),
    });
  }

  // Channels — enumerated from the registered message providers.
  for (const channel of deps.channels?.() ?? []) {
    const label = channel.name || channel.id.charAt(0).toUpperCase() + channel.id.slice(1);
    entries.push({
      id: `channel:${channel.id}`,
      name: label,
      whatItDoes: `Messaging channel: bots send and receive messages with users on ${label}.`,
      whenToUse: `When the user wants to reach someone (or be reached by a bot) on ${label}.`,
      howToInvoke: {
        type: 'flow',
        route: '/api/messaging/channels',
        description: `Channel "${channel.id}" is configured under /api/messaging/channels; channel turns run its responder bot, and replies go back out on ${label}.`,
      },
      kind: 'channel',
      group: 'Channels',
      keywords: uniqueTokens([label, channel.id, 'send message', 'messaging', 'chat']),
    });
  }

  // Product features — curated descriptors (no catalog exists for them).
  for (const feature of deps.features ?? PRODUCT_FEATURES) {
    const whatItDoes = feature.slug === 'workflows' && deps.workflows
      ? `${feature.whatItDoes} (${workflows.length} workflow${workflows.length === 1 ? '' : 's'} currently defined.)`
      : feature.whatItDoes;
    entries.push({
      id: `feature:${feature.slug}`,
      name: feature.name,
      whatItDoes,
      whenToUse: feature.whenToUse,
      howToInvoke: feature.invoke,
      kind: 'feature',
      group: 'Features',
      keywords: uniqueTokens([feature.name, ...feature.keywords]),
      ...(feature.handoffLabel ? { handoffLabel: feature.handoffLabel } : {}),
    });
  }

  const counts: Record<CapabilityKind, number> = {
    bot: 0, tool: 0, skill: 0, workflow: 0, plugin: 0, channel: 0, feature: 0,
  };
  for (const e of entries) counts[e.kind] += 1;
  return { entries, generatedAt, counts };
}

// ---------------------------------------------------------------------------
// Search — deterministic lexical ranking (tokenized with the platform's
// ftsTerms, the same tokenizer the hybrid search uses). No embeddings, no
// LLM, no paid APIs: same query + same registry → same ranking, always.
// ---------------------------------------------------------------------------

export interface CapabilitySearchHit {
  entry: CapabilityEntry;
  score: number;
}

const KIND_TIE_ORDER: Record<CapabilityKind, number> = {
  bot: 0, channel: 1, feature: 2, tool: 3, workflow: 4, skill: 5, plugin: 6,
};

/** Light singular/plural tolerance: 'jobs' matches 'job', 'runs' matches 'run'. */
function termHits(fieldTokens: Set<string>, term: string): boolean {
  if (fieldTokens.has(term)) return true;
  if (term.length > 3 && term.endsWith('s') && fieldTokens.has(term.slice(0, -1))) return true;
  if (fieldTokens.has(`${term}s`)) return true;
  return false;
}

export function searchCapabilities(
  registry: CapabilityRegistry,
  query: string,
  opts: { limit?: number; kinds?: CapabilityKind[] } = {},
): CapabilitySearchHit[] {
  const terms = tokensOf(query ?? '');
  if (terms.length === 0) return [];
  const phrase = (query ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const limit = Math.max(1, Math.min(25, opts.limit ?? 5));
  const hits: CapabilitySearchHit[] = [];

  for (const entry of registry.entries) {
    if (opts.kinds && !opts.kinds.includes(entry.kind)) continue;
    const nameTokens = new Set(tokensOf(entry.name));
    const keywordTokens = new Set(entry.keywords);
    const invokeTokens = new Set(tokensOf(
      `${entry.howToInvoke.description} ${entry.howToInvoke.toolName ?? ''} ${entry.howToInvoke.botId ?? ''} ${entry.howToInvoke.route ?? ''}`,
    ));
    const whenTokens = new Set(tokensOf(entry.whenToUse));
    const whatTokens = new Set(tokensOf(entry.whatItDoes));
    const groupTokens = new Set(tokensOf(entry.group));

    let score = 0;
    for (const term of terms) {
      if (termHits(nameTokens, term)) score += 6;
      if (termHits(keywordTokens, term)) score += 5;
      if (termHits(invokeTokens, term)) score += 4;
      if (termHits(whenTokens, term)) score += 3;
      if (termHits(whatTokens, term)) score += 3;
      if (termHits(groupTokens, term)) score += 2;
    }
    if (phrase.length >= 4) {
      if (entry.name.toLowerCase().includes(phrase)) score += 12;
      else if (entry.keywords.some((k) => k.length >= 4 && phrase.includes(k))) score += 8;
      if (entry.whatItDoes.toLowerCase().includes(phrase)) score += 4;
      if (entry.whenToUse.toLowerCase().includes(phrase)) score += 4;
    }
    if (score > 0) hits.push({ entry, score });
  }

  hits.sort((a, b) =>
    b.score - a.score ||
    KIND_TIE_ORDER[a.entry.kind] - KIND_TIE_ORDER[b.entry.kind] ||
    a.entry.name.localeCompare(b.entry.name),
  );
  return hits.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Cross-feature handoff: when a request belongs to another feature, the
// agent gets a structured suggestion it can act on in place.
// ---------------------------------------------------------------------------

export interface CapabilityHandoff {
  capabilityId: string;
  name: string;
  /** What to do, in plain words (shown to the user as the proposal). */
  label: string;
  /** The structured action: call this tool / start this flow. */
  action: CapabilityInvoke;
  note: string;
}

export function suggestCapabilityHandoffs(
  registry: CapabilityRegistry,
  text: string,
  opts: { limit?: number } = {},
): CapabilityHandoff[] {
  const limit = Math.max(1, Math.min(5, opts.limit ?? 3));
  return searchCapabilities(registry, text, { limit: 10 })
    .filter((h) => h.entry.handoffLabel)
    .slice(0, limit)
    .map((h) => ({
      capabilityId: h.entry.id,
      name: h.entry.name,
      label: h.entry.handoffLabel!,
      action: h.entry.howToInvoke,
      note: 'Propose this to the user in place, then invoke it — do not ask the user to navigate to another screen.',
    }));
}

// ---------------------------------------------------------------------------
// Compact summary for system-prompt injection. Token-bounded: rendered at
// the richest detail level that fits the budget (≈4 chars/token), then
// degraded deterministically. Always ends with the discovery hint.
// ---------------------------------------------------------------------------

export interface CapabilitySummaryOptions {
  /** Approximate token budget for the whole summary (default 1200). */
  maxApproxTokens?: number;
}

export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const DISCOVERY_HINT =
  'For anything not listed, call discover_capabilities("<the need in plain words>") to get the exact bot, tool or flow.';

function renderSummary(registry: CapabilityRegistry, level: 0 | 1 | 2 | 3): string {
  const { counts } = registry;
  const byKind = (kind: CapabilityKind) => registry.entries.filter((e) => e.kind === kind);
  const lines: string[] = [];
  lines.push(
    `KriyaDot capability map (generated ${registry.generatedAt}; ${registry.entries.length} capabilities: ` +
    `${counts.bot} bots, ${counts.tool} tools, ${counts.skill} skills, ${counts.workflow} workflows, ` +
    `${counts.plugin} plugins, ${counts.channel} channels, ${counts.feature} features).`,
  );

  const features = byKind('feature');
  if (features.length > 0) {
    lines.push('Features:');
    for (const f of features) {
      if (level >= 2) lines.push(`- ${f.name}: ${firstSentences(f.whatItDoes, 110)} Invoke: ${firstSentences(f.howToInvoke.description, 90)}`);
      else if (level === 1) lines.push(`- ${f.name}: ${firstSentences(f.whatItDoes, 60)}`);
      else lines.push(`- ${f.name}`);
    }
  }

  const bots = byKind('bot');
  if (bots.length > 0) {
    if (level === 0) lines.push(`Bots: ${bots.map((b) => b.name).join(', ')}.`);
    else {
      lines.push('Bots:');
      for (const b of bots) {
        lines.push(level >= 2
          ? `- ${b.name}: ${firstSentences(b.whatItDoes, 100)} (${b.whenToUse.replace(/^When /, 'when ')})`
          : `- ${b.name}: ${firstSentences(b.whatItDoes, 60)}`);
      }
    }
  }

  const tools = byKind('tool');
  if (tools.length > 0) {
    const groups = new Map<string, CapabilityEntry[]>();
    for (const t of tools) {
      const list = groups.get(t.group) ?? [];
      list.push(t);
      groups.set(t.group, list);
    }
    if (level === 0) {
      lines.push(`Tools by category: ${[...groups.entries()].map(([g, ts]) => `${g} (${ts.length})`).join('; ')}.`);
    } else {
      lines.push('Tools by category:');
      const perGroup = level >= 3 ? 14 : level === 2 ? 10 : 6;
      for (const [group, ts] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const names = ts.slice(0, perGroup).map((t) => t.name).join(', ');
        const more = ts.length > perGroup ? `, +${ts.length - perGroup} more` : '';
        lines.push(`- ${group}: ${names}${more}`);
      }
    }
  }

  const skills = byKind('skill');
  if (skills.length > 0) {
    lines.push(level === 0
      ? `Skills (${skills.length}): load with read_skill.`
      : `Skills: ${skills.slice(0, level >= 2 ? 20 : 8).map((s) => s.name).join(', ')}${skills.length > (level >= 2 ? 20 : 8) ? `, +${skills.length - (level >= 2 ? 20 : 8)} more` : ''} (load with read_skill).`);
  }

  const workflows = byKind('workflow');
  if (workflows.length > 0) {
    lines.push(level === 0
      ? `Workflows defined: ${workflows.length}.`
      : `Workflows defined: ${workflows.slice(0, 10).map((w) => w.name).join(', ')}${workflows.length > 10 ? `, +${workflows.length - 10} more` : ''}.`);
  }

  const plugins = byKind('plugin');
  if (plugins.length > 0) {
    lines.push(`Plugins installed: ${plugins.map((p) => p.name).join(', ')}.`);
  }

  const channels = byKind('channel');
  if (channels.length > 0) {
    lines.push(`Channels connected: ${channels.map((c) => c.name).join(', ')}.`);
  }

  lines.push(DISCOVERY_HINT);
  return lines.join('\n');
}

export function buildCapabilitySummary(
  registry: CapabilityRegistry,
  opts: CapabilitySummaryOptions = {},
): string {
  const maxApproxTokens = Math.max(100, opts.maxApproxTokens ?? 1200);
  for (const level of [3, 2, 1, 0] as const) {
    const text = renderSummary(registry, level);
    if (approxTokens(text) <= maxApproxTokens) return text;
  }
  // Level 0 still over budget (huge catalog): hard-truncate on a line
  // boundary and keep the discovery hint as the last line.
  const lines = renderSummary(registry, 0).split('\n');
  const kept: string[] = [];
  let chars = DISCOVERY_HINT.length + 1;
  for (const line of lines.slice(0, -1)) {
    if (chars + line.length + 1 > maxApproxTokens * 4) break;
    kept.push(line);
    chars += line.length + 1;
  }
  kept.push(DISCOVERY_HINT);
  return kept.join('\n');
}

/** The fenced system-prompt section for the Chief / Universal anchor. */
export function buildCapabilityPromptSection(
  registry: CapabilityRegistry,
  opts: CapabilitySummaryOptions = {},
): string {
  return [
    '# What KriyaDot can do (capability map — auto-generated, always current)',
    buildCapabilitySummary(registry, opts),
    'When a request belongs to another feature (a workflow, a scheduled or cloud-anchored automation, a Store install, a published page…), do not ask the user to navigate: use discover_capabilities to get the handoff and start that flow in place.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Service: TTL-cached registry so prompt assembly refreshes cheaply.
// ---------------------------------------------------------------------------

export interface CapabilityService {
  getRegistry(): CapabilityRegistry;
  search(query: string, opts?: { limit?: number; kinds?: CapabilityKind[] }): CapabilitySearchHit[];
  summary(opts?: CapabilitySummaryOptions): string;
  promptSection(opts?: CapabilitySummaryOptions): string;
  suggestHandoffs(text: string, opts?: { limit?: number }): CapabilityHandoff[];
  invalidate(): void;
}

export const DEFAULT_CAPABILITY_TTL_MS = 30_000;

export function createCapabilityService(
  deps: CapabilityRegistryDeps,
  opts: { ttlMs?: number; nowMs?: () => number } = {},
): CapabilityService {
  const ttlMs = Math.max(0, opts.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS);
  const nowMs = opts.nowMs ?? (() => Date.now());
  let cache: { registry: CapabilityRegistry; builtAtMs: number } | undefined;

  const getRegistry = (): CapabilityRegistry => {
    const t = nowMs();
    if (cache && t - cache.builtAtMs < ttlMs) return cache.registry;
    const registry = buildCapabilityRegistry(deps);
    cache = { registry, builtAtMs: t };
    return registry;
  };

  return {
    getRegistry,
    search: (query, searchOpts) => searchCapabilities(getRegistry(), query, searchOpts),
    summary: (summaryOpts) => buildCapabilitySummary(getRegistry(), summaryOpts),
    promptSection: (summaryOpts) => buildCapabilityPromptSection(getRegistry(), summaryOpts),
    suggestHandoffs: (text, handoffOpts) => suggestCapabilityHandoffs(getRegistry(), text, handoffOpts),
    invalidate: () => {
      cache = undefined;
    },
  };
}
