// SPDX-License-Identifier: Apache-2.0
// "Where is everything" feature map data (2026-11-10 findability
// pass), rendered by the User Guide page. Kept out of the page file:
// Next.js page modules may only export the route component.

export interface FeatureMapEntry {
  name: string;
  where: string;
  href?: string;
  settingsSection?: string;
}

export const FEATURE_MAP: FeatureMapEntry[] = [
  { name: 'Workflow canvas — the n8n-style graph editor', where: 'Workflows → Open workflow canvas. Drag nodes (trigger, agent, tool, http, approval, if, code), connect them, run or export — including n8n JSON import/export on the Workflows page.', href: '/workflows/canvas' },
  { name: 'Workflow definitions & runs', where: 'Workflows destination: every registered workflow, dry-run plans, run history and per-run health diagnosis.', href: '/workflows' },
  { name: 'Routines & scheduled automations', where: 'Bots → open any bot → Routines tab. Schedules, triggers and automation starters run from each bot — they are per-bot, not on the Workflows page.', href: '/bots' },
  { name: 'Connected Apps — Notion, Gmail, Slack, Canva & 1,000+ apps', where: 'Settings window → Connected Apps (or the Accounts page): connect Notion and other apps, browse automation starters, manage the vault and saved logins.', settingsSection: '/accounts' },
  { name: 'Pages — Notion-like documents', where: 'Pages surface: documents your bots can read and write, alongside Notes and Tasks in the Workspace family.', href: '/pages' },
  { name: 'Notes & Tasks', where: 'Workspace tabs — also direct routes: Notes for free-form notes, Tasks for the shared task list bots work from.', href: '/notes' },
  { name: 'Knowledge graph', where: 'Knowledge destination: the linked graph of what your bots know, separate from document files.', href: '/knowledge' },
  { name: 'Knowledge Base — ask your documents (RAG)', where: 'Modules hub → Knowledge Base: add documents and get cited answers from them, no API key needed.', href: '/modules/kb' },
  { name: 'Library — everything KriyaDot made for you', where: 'Workspace → Library: artifacts, decks, generated media and workspace files in one searchable place.', href: '/workspace/library' },
  { name: 'Memory — what your bots remember', where: 'Workspace → Memory tab. Per-bot memory also lives inside each bot on the Bots page.', href: '/workspace' },
  { name: 'Bots', where: 'Bots destination: create and configure agents — model, tools, computer use, memory and routines are tabs inside each bot.', href: '/bots' },
  { name: 'Marketplace', where: 'Marketplace destination: install bots, skills, plugins and ready-made workflows.', href: '/marketplace' },
  { name: 'Providers, API keys & CLI subscription logins', where: 'Settings window → Providers & models: paste API keys, or connect your Claude Code, Codex (ChatGPT) and OpenCode CLI logins — the model you pick is the model that answers.', settingsSection: '/providers' },
  { name: 'Messaging channels', where: 'Settings window → Messaging: WhatsApp, Telegram, Slack and Discord, with approvals mirrored into chat.', settingsSection: '/messaging' },
  { name: 'Activity — approvals, runs, audit & costs', where: 'Activity destination: Work, Approvals, Runs, Briefing and (under More sections) audit log, routing, health and cost.', href: '/activity' },
  { name: 'Modules — Feed, Goals, Research, Artifacts & more', where: 'Modules hub (Settings window → Modules hub): every KriyaDot module with live counts and its own page.', href: '/more' },
  { name: 'Terminal & Teams', where: 'More destinations in the sidebar: a built-in Terminal, and Teams for multi-bot collaboration spaces.', href: '/terminal' },
  { name: 'Settings', where: 'The sidebar Settings button now opens Settings as a window over whatever you are doing — Connected Apps, Providers, Messaging, Usage, Permissions, Preferences and the Modules hub.', settingsSection: '/accounts' },
];
