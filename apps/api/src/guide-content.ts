// SPDX-License-Identifier: Apache-2.0
/**
 * In-app User Guide — content model (closure addendum ADD-3).
 *
 * Task-based walkthroughs as structured data. The copy is authored
 * against the shipped product: every step names a real screen, button
 * or label in the web app (Universal Chat's composer, Bots → "✨ Set me
 * up", Workflows → Run / Dry-run, Preferences → "Cloud sync & website",
 * the routine anchor section's "Runs where (anchor)" radios, …).
 *
 * Each article lists `relatedCapabilities`: the capability ids it
 * covers, using the ADD-2 capability registry's PRODUCT_FEATURES slugs
 * (universal-chat, workflows, lightning-cloud, automation-anchors, …).
 * Registry entries carry ids of the form `feature:<slug>`; the guide
 * names the bare slug, and guide-routes matches on the slug suffix.
 *
 * This module is pure data + pure search helpers — no I/O, no LLM —
 * so it is trivially testable and safe to import anywhere.
 */

export interface GuideDeepLink {
  label: string;
  /** In-app route (Next.js path) the link opens — the exact screen. */
  href: string;
}

export interface GuideStep {
  title: string;
  body: string;
  deepLink?: GuideDeepLink;
}

export interface GuideArticle {
  id: string;
  title: string;
  /** Grouping label shown on the Guide home (Getting started, Chat, …). */
  theme: string;
  /** Who the walkthrough is written for, in plain words. */
  audience: string;
  summary: string;
  steps: GuideStep[];
  /** ADD-2 capability ids this article covers. */
  relatedCapabilities: string[];
  /** Extra search terms a user might type ("offline", "wake", …). */
  keywords: string[];
}

/** Theme display order on the Guide home. */
export const GUIDE_THEMES: string[] = [
  'Getting started',
  'Chat & bots',
  'Automation',
  'Cloud & devices',
  'Safety & control',
  'Discover & extend',
];

export const GUIDE_ARTICLES: GuideArticle[] = [
  {
    id: 'first-setup',
    title: 'First setup: from install to your first answer',
    theme: 'Getting started',
    audience: 'Anyone opening KriyaDot for the first time',
    summary:
      'KriyaDot works out of the box with a built-in keyless free lane — no account and no API key are needed for local use. This walkthrough gets you from a fresh install to a first routed answer, then shows the two optional upgrades: your own provider keys, and a cloud workspace.',
    steps: [
      {
        title: 'Open Chat and just ask something',
        body: 'KriyaDot opens on Universal Chat. The composer reads "Ask anything — routed automatically…". Type a plain question and send it — the built-in keyless free lane answers with zero setup, so you can try everything before configuring anything.',
        deepLink: { label: 'Open Universal Chat', href: '/' },
      },
      {
        title: 'Check who answered',
        body: 'Every answer in Universal Chat carries a routing chip such as "✦ Handled by Scout". That chip is how you always know which bot did the work — you never have to guess or pick a bot first.',
        deepLink: { label: 'Open Universal Chat', href: '/' },
      },
      {
        title: '(Optional) Add your own provider keys',
        body: 'For higher limits and more models, open Settings → "Accounts & API keys" to store a provider key in your instance vault, and "Providers & models" to choose which models your bots use. Keys never leave your instance.',
        deepLink: { label: 'Open Accounts & API keys', href: '/accounts' },
      },
      {
        title: '(Optional) Connect a cloud workspace',
        body: 'If you want your team reachable from other devices and working while this PC is off, connect your own Lightning cloud — see the "Connecting Lightning cloud" article. Local use never requires it.',
        deepLink: { label: 'Open Preferences', href: '/preferences' },
      },
      {
        title: 'Take the tour and keep this Guide handy',
        body: 'The Guide lives under More → Modules hub → User Guide. Replay the first-run tour from the top of the Guide page any time, and use the "How do I…?" box there to ask in plain words.',
        deepLink: { label: 'Open the User Guide', href: '/more/guide' },
      },
    ],
    relatedCapabilities: ['universal-chat', 'lightning-cloud'],
    keywords: ['install', 'begin', 'start', 'onboarding', 'api key', 'free lane', 'no account', 'setup'],
  },
  {
    id: 'universal-chat-routing',
    title: 'Universal Chat: how routing decides who answers',
    theme: 'Chat & bots',
    audience: 'Anyone chatting with the team',
    summary:
      'You never pick a bot in Universal Chat. Each message is routed one of three ways — direct, specialist, or split — by rules (no extra model call), and the routing chip on the answer shows the decision.',
    steps: [
      {
        title: 'Direct: everyday questions are answered in place',
        body: 'Ask a general question in the composer ("Ask anything — routed automatically…"). When nothing clearly belongs to a specialist, the anchor bot — your Chief of Staff — answers directly in the same thread.',
        deepLink: { label: 'Open Universal Chat', href: '/' },
      },
      {
        title: 'Specialist: clear topics go to the bot that owns them',
        body: 'When a message clearly matches one bot\'s domain — code to Coder, research to Scout, data to Data Analyst — it is routed to that specialist. The answer appears in the same thread with a chip like "✦ Handled by Coder", and the conversation with that specialist is kept in its own session behind the thread.',
        deepLink: { label: 'See the bot roster', href: '/bots' },
      },
      {
        title: 'Split: multi-part asks run in parallel, then fuse',
        body: 'A message with clear multi-part structure — several questions, a list of tasks, "and then" steps — is split into sub-tasks that run in parallel, then fused into one synthesized answer. You get one reply, not fragments.',
        deepLink: { label: 'Open Universal Chat', href: '/' },
      },
      {
        title: 'Override with @mention when you want a specific bot',
        body: 'Type @ followed by a bot name in the composer (for example "@Data Analyst") to force that bot to handle the message, whatever the rules would have chosen. Mentioning the anchor bot itself answers directly.',
        deepLink: { label: 'Open Universal Chat', href: '/' },
      },
      {
        title: 'When unsure, it answers directly — on purpose',
        body: 'Routing is deliberately conservative: a weak or ambiguous match stays direct instead of guessing a specialist. If an answer went to the wrong place, resend with an @mention to pin it.',
        deepLink: { label: 'Open Universal Chat', href: '/' },
      },
    ],
    relatedCapabilities: ['universal-chat', 'fusion', 'chief-of-staff'],
    keywords: ['route', 'routing', 'which bot', 'mention', '@', 'split', 'specialist', 'direct', 'chip', 'anchor'],
  },
  {
    id: 'creating-bots',
    title: 'Creating a bot and shaping how it works',
    theme: 'Chat & bots',
    audience: 'Anyone who wants a specialist of their own',
    summary:
      'Bots are the specialists on your team. Create one with the guided setup, then tune its persona, model, tools and policy — each bot has its own workspace and its own governance rules.',
    steps: [
      {
        title: 'Start from Bots → "✨ Set me up"',
        body: 'Open Bots and choose "✨ Set me up" in the roster column. The setup panel walks you through naming the bot and describing what it is for, then adds it to the roster.',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
      {
        title: 'Give it a persona and a workspace',
        body: 'Select the bot and use its tabs: the persona picker sets how it talks and what it is expert in, and the workspace picker gives it its own folder so bots working at once do not collide on files. Leave the workspace empty to share the default one.',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
      {
        title: 'Pick its model and voice',
        body: 'In the bot\'s model tab you can change which model it runs on and its voice settings, independently of every other bot.',
        deepLink: { label: 'Open Providers & models', href: '/providers' },
      },
      {
        title: 'Set its policy and approval mode',
        body: 'The policy tab holds the bot\'s placement, approval mode and custom rules. Start strict: a bot that must ask before consequential actions is easy to loosen later from the Permissions pane.',
        deepLink: { label: 'Open Permissions', href: '/permissions' },
      },
      {
        title: 'Talk to it',
        body: 'Your new bot joins Universal Chat routing automatically — mention it with @name to use it directly, or let routing send matching work its way.',
        deepLink: { label: 'Open Universal Chat', href: '/' },
      },
    ],
    relatedCapabilities: ['chief-of-staff'],
    keywords: ['create bot', 'new bot', 'set me up', 'persona', 'roster', 'specialist', 'team'],
  },
  {
    id: 'workflows',
    title: 'Workflows: reusable multi-step automations',
    theme: 'Automation',
    audience: 'Anyone repeating the same multi-step job',
    summary:
      'A workflow is a saved, repeatable sequence of steps that bots can run — and call — as one job. Build one on the canvas or run a registered definition, dry-run it first, and read every run\'s health afterwards.',
    steps: [
      {
        title: 'Browse what exists on the Workflows page',
        body: 'Workflows lists every registered definition as a card with its node count, plus a Runs table with status and health for past runs. If the list is empty ("No workflow definitions registered."), import or install one first — see the next steps.',
        deepLink: { label: 'Open Workflows', href: '/workflows' },
      },
      {
        title: 'Draw one on the canvas, or import one',
        body: 'The workflow canvas is where you draw steps visually. On the Workflows page you can also import a standard n8n export ("Import n8n JSON") or a kriyadot.workflow file (JSON or TOML); unmapped n8n nodes are reported, never silently dropped. Ready-made workflows also install from the Marketplace.',
        deepLink: { label: 'Open the workflow canvas', href: '/workflows/canvas' },
      },
      {
        title: 'Dry-run before the first real run',
        body: 'Choose "Dry-run" on a workflow card: you get the validation result and the execution plan — steps, skips, and any reported cost — while spawning nothing and costing nothing.',
        deepLink: { label: 'Open Workflows', href: '/workflows' },
      },
      {
        title: 'Run it, with input if it takes any',
        body: 'Fill the optional "Input JSON" (and an idempotency key if a duplicate run would be a problem), then choose "Run". Bots can also call workflows as steps in a larger job — just ask in Chat.',
        deepLink: { label: 'Open Workflows', href: '/workflows' },
      },
      {
        title: 'Read the run afterwards',
        body: 'Every run lands in the Runs table with a status and a health chip. Open the health chip for a diagnosis with suggested fixes, or open the run itself to step through what happened.',
        deepLink: { label: 'Open Activity', href: '/activity' },
      },
    ],
    relatedCapabilities: ['workflows', 'automations', 'marketplace-store'],
    keywords: ['workflow', 'automation', 'canvas', 'n8n', 'import', 'dry run', 'run', 'steps', 'nodes'],
  },
  {
    id: 'connecting-lightning-cloud',
    title: 'Connecting Lightning cloud: your workspace, in your cloud',
    theme: 'Cloud & devices',
    audience: 'Anyone who wants the team reachable anywhere',
    summary:
      'KriyaDot never runs on KriyaDot servers. Connecting Lightning deploys your workspace into your own Lightning AI account, so your bots live in your cloud, billed (if at all) by Lightning to you.',
    steps: [
      {
        title: 'Start at the website and sign in with Google',
        body: 'On the KriyaDot website choose "Create your workspace" and sign in with Google. The site remembers only who you are and your workspace address — it never carries your chat traffic.',
      },
      {
        title: 'Connect your Lightning account',
        body: 'Lightning AI is where your cloud workspace will live. It uses the same Google login, so connecting is a single tap — no new password and no keys to copy around.',
      },
      {
        title: 'Let the workspace deploy, then launch it',
        body: 'KriyaDot deploys into your Lightning account. After that, launching from the website hands your browser off to your own instance, and the browser talks to that instance directly.',
      },
      {
        title: 'Know the free-tier behaviour',
        body: 'On Lightning\'s free tier your workspace sleeps when idle and wakes when you visit — reachable and self-healing, with a possible wake delay on the first request. An always-on workspace comes with your own Lightning plan, paid by you directly to Lightning.',
      },
      {
        title: 'Site down does not mean workspace down',
        body: 'Your instance runs independently of the website. Bookmark your instance address (or use the desktop app) and you can always reach your team directly.',
        deepLink: { label: 'Open Preferences', href: '/preferences' },
      },
    ],
    relatedCapabilities: ['lightning-cloud', 'device-sync'],
    keywords: ['lightning', 'cloud', 'connect', 'deploy', 'workspace', 'google sign in', 'free tier', 'sleep', 'website'],
  },
  {
    id: 'placement-and-anchors',
    title: 'Placement & automation anchors: work that runs while your PC is off',
    theme: 'Cloud & devices',
    audience: 'Anyone scheduling routines or moving bots to the cloud',
    summary:
      'Placement decides where a bot runs; anchors decide where a scheduled routine fires. Time-based automations anchor to your cloud by default whenever one is connected — in plain words, "Runs in your cloud — fires even while your PC is off".',
    steps: [
      {
        title: 'Choose where a bot runs (placement)',
        body: 'Open a bot on the Bots page and use its policy tab: the placement panel offers "This device (fully local)", "Cloud, report back", and "Cloud only". Cloud options unlock once sync with your cloud instance is configured. A per-bot "local only" switch keeps that bot\'s history on this device and out of sync entirely.',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
      {
        title: 'Set a task\'s placement from the composer',
        body: 'In Universal Chat, the composer pill sets where the task you are about to send runs. If a task is set to run in your cloud while no cloud is connected, KriyaDot tells you so and offers the fix instead of failing silently.',
        deepLink: { label: 'Open Universal Chat', href: '/' },
      },
      {
        title: 'Understand the anchor rule for routines',
        body: 'In a bot\'s Routines panel, the "Runs where (anchor)" control offers Automatic, This device, and Cloud. Automatic means: time-based schedules anchor to the cloud when one is connected (so they fire on time), and everything else stays local.',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
      {
        title: 'Read the resolved anchor in plain words',
        body: 'Under the anchor control, KriyaDot always shows the resolved result — for example "Runs in your cloud — fires even while your PC is off" or "Runs on this device". If a local time-based routine has no cloud to anchor to, you get a warning: "This schedule only fires while this PC is on", plus the connecting-cloud fix.',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
      {
        title: 'Remember the free-tier wake caveat',
        body: 'A cloud-anchored, time-critical routine on Lightning\'s free tier can see a wake delay because the Studio sleeps when idle. The anchor section says so plainly when it applies; Lightning Pro removes the sleep restriction.',
        deepLink: { label: 'Open Preferences', href: '/preferences' },
      },
    ],
    relatedCapabilities: ['execution-placement', 'automation-anchors', 'automations', 'lightning-cloud'],
    keywords: ['placement', 'anchor', 'runs while', 'pc off', 'off', 'cloud only', 'report back', 'this device', 'schedule fires', 'wake'],
  },
  {
    id: 'reporting',
    title: 'Run reporting: instant, daily digest, or both',
    theme: 'Cloud & devices',
    audience: 'Anyone with routines or cloud work running unattended',
    summary:
      'When work runs without you watching — a cloud-anchored routine, a cloud bot — reporting decides how you hear about it: an instant report per run, a daily digest, both, with quiet hours for the noisy parts of the day.',
    steps: [
      {
        title: 'Open the routine\'s anchor & reporting section',
        body: 'On the Bots page, select the bot and open its Routines panel. Each routine\'s anchor section carries the "Reporting" control right under "Runs where (anchor)".',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
      {
        title: 'Pick a mode: Instant, Daily digest, or Both',
        body: '"Instant" reports each finished run as it lands. "Daily digest" batches the day\'s runs into one summary. "Both" does exactly that — instant for the run, digest for the record.',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
      {
        title: 'Set quiet hours if you want a silent window',
        body: 'Optional quiet-hours start and end times hold instant reports back during that window; the daily digest still covers everything that happened.',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
      {
        title: 'Save with "Save anchor & reporting"',
        body: 'The anchor and reporting choices save together. The saved line under the control confirms the resolved anchor, so what you read is where the next run will actually fire.',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
      {
        title: 'Catch up in Activity',
        body: 'Whatever the reporting mode, every run is recorded in Activity with its approvals and outcome — reporting changes how you are told, never what is logged.',
        deepLink: { label: 'Open Activity', href: '/activity' },
      },
    ],
    relatedCapabilities: ['automation-anchors', 'automations', 'execution-placement'],
    keywords: ['reporting', 'report', 'instant', 'daily', 'digest', 'both', 'quiet hours', 'notify', 'notification'],
  },
  {
    id: 'approvals-and-safety',
    title: 'Approvals & safety: nothing consequential runs silently',
    theme: 'Safety & control',
    audience: 'Everyone — read this before giving bots real work',
    summary:
      'Bots can do real things, so consequential actions pause for your explicit approval, catastrophic commands are hard-denied rather than warned about, and everything is audit-logged. This article shows where each fence lives.',
    steps: [
      {
        title: 'Approve or deny from the prompt — or from Activity',
        body: 'When a bot needs approval, the request appears in chat and on the Approvals screen. Nothing sensitive runs in the background while it waits; deny it and the bot is told, not retried around you.',
        deepLink: { label: 'Open Approvals', href: '/approvals' },
      },
      {
        title: 'Know the hard denials',
        body: 'Catastrophic commands are denied outright by policy — there is no "are you sure?" dialog and no override in the pane. Purchases are likewise always approved individually, never auto-allowed.',
        deepLink: { label: 'Open Permissions', href: '/permissions' },
      },
      {
        title: 'Tune per-bot approval modes',
        body: 'Each bot\'s policy tab has its approval mode and custom rules, plus a policy simulator so you can test what a hypothetical tool call would do — allow, ask, or deny — before it ever happens for real.',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
      {
        title: 'Let learned preferences help, carefully',
        body: 'Preferences → "Learned preferences" shows the patterns KriyaDot has learned from your decisions: deny a tool 3 times and it is auto-denied; approve it 5 times and it is auto-approved. Remove a preference there to reset it. Privileged tools (purchases, shell, file writes) are excluded from auto-allow.',
        deepLink: { label: 'Open Preferences', href: '/preferences' },
      },
      {
        title: 'Audit everything afterwards',
        body: 'Activity holds the full trail — routing decisions, tool calls, approvals and denials — so if a bot did it, you can see what, when, and under whose approval.',
        deepLink: { label: 'Open Activity', href: '/activity' },
      },
    ],
    relatedCapabilities: ['approvals-governance'],
    keywords: ['approval', 'approve', 'deny', 'safety', 'safe', 'hard denial', 'sandbox', 'audit', 'permission'],
  },
  {
    id: 'marketplace-store-installs',
    title: 'Marketplace & the Store: installing bots, skills, MCP servers and plugins',
    theme: 'Discover & extend',
    audience: 'Anyone extending what their team can do',
    summary:
      'The Marketplace is where ready-made capability installs from: bots and workflows on Browse, skills, MCP servers, and plugins, each with its own tab — and installs always route through the safety flow for that kind.',
    steps: [
      {
        title: 'Browse the catalog and pick a tab',
        body: 'Open Marketplace. "Browse" lists installable bots and workflows, "Skills" the skill catalog, "MCP" the MCP server directory, "Plugins" the plugin section, and "Revenue" tracks what your published items earn.',
        deepLink: { label: 'Open Marketplace', href: '/marketplace' },
      },
      {
        title: 'Install a bot, workflow or skill',
        body: 'Choose "Install" on a Browse card and the item joins your roster or workflow list at the shown version. Skills install from their tab the same way and become available to your bots.',
        deepLink: { label: 'Open Marketplace', href: '/marketplace' },
      },
      {
        title: 'MCP servers install by approval',
        body: 'An MCP card\'s button reads "Request install (approval)" — an MCP server is code that will run with tool access, so it goes through a governance approval before it is usable. That pause is the point.',
        deepLink: { label: 'Open Approvals', href: '/approvals' },
      },
      {
        title: 'Plugins stay deny-by-default',
        body: 'Plugins install under the same deny-by-default governance: a plugin gets only the permissions its approval grants, and the Permissions pane shows what each surface and connector may do.',
        deepLink: { label: 'Open Permissions', href: '/permissions' },
      },
      {
        title: 'Publish your own',
        body: 'Anything you package — a bot, a skill, a workflow — can be shared back through the same catalog machinery, and the Revenue tab tracks installs of what you publish.',
        deepLink: { label: 'Open Marketplace', href: '/marketplace' },
      },
    ],
    relatedCapabilities: ['marketplace-store', 'approvals-governance'],
    keywords: ['marketplace', 'store', 'install', 'skill', 'mcp', 'plugin', 'browse', 'publish', 'revenue'],
  },
  {
    id: 'sync-across-devices',
    title: 'Sync across devices: one history, through your own instance',
    theme: 'Cloud & devices',
    audience: 'Anyone using KriyaDot on more than one device',
    summary:
      'Your local app syncs history up to your own cloud instance, which acts as the sync hub — never a KriyaDot server. Every signed-in device sees one history, an offline outbox drains loss-free when you reconnect, and any bot can be marked local-only.',
    steps: [
      {
        title: 'Open Preferences → "Cloud sync & website"',
        body: 'That section shows sync status: the configured instance, last push and last pull, the pending outbox count, and the last error if there is one.',
        deepLink: { label: 'Open Preferences', href: '/preferences' },
      },
      {
        title: 'Connect a sync target',
        body: 'Either link this instance to your KriyaDot website account from that panel (the website then launches your workspace), or set a manual sync target: your instance URL plus a link token. Saving the target starts sync.',
        deepLink: { label: 'Open Preferences', href: '/preferences' },
      },
      {
        title: 'Link another device with a link token',
        body: 'Mint a link token in the same panel and use it on the other device or app to point it at the same instance. Tokens are shown once — treat them like passwords.',
        deepLink: { label: 'Open Preferences', href: '/preferences' },
      },
      {
        title: 'Work offline without losing anything',
        body: 'If the instance is unreachable, changes queue in an offline outbox (watch the pending count) and drain when the connection returns. Nothing is dropped for being written offline.',
        deepLink: { label: 'Open Preferences', href: '/preferences' },
      },
      {
        title: 'Keep a bot local-only when it should be',
        body: 'A bot\'s placement panel has a local-only switch: that bot\'s history never syncs and stays on this device, even while everything else syncs through your instance.',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
    ],
    relatedCapabilities: ['device-sync', 'execution-placement'],
    keywords: ['sync', 'devices', 'phone', 'history', 'outbox', 'offline', 'link token', 'local only', 'another device'],
  },
  {
    id: 'permissions-pane',
    title: 'The Permissions pane: who may do what, in one place',
    theme: 'Safety & control',
    audience: 'Anyone reviewing what their bots and connectors may do',
    summary:
      'Settings → Permissions ("Permissions & identity") is the single view over enforcement that already exists: surface defaults, connector action groups, standing allowances, and per-item overrides — with the hard floors visibly untouchable.',
    steps: [
      {
        title: 'Read the overview first',
        body: 'The pane opens on the surface defaults — what Chat, purchases and the other surfaces do by default (allow, ask, or deny) and where each default comes from. Purchases show as non-overridable: every purchase is approved individually, by design.',
        deepLink: { label: 'Open Permissions', href: '/permissions' },
      },
      {
        title: 'Set connector action groups',
        body: 'Each connector (for example an email or chat app) breaks its actions into groups like read vs send, each settable to Allow, Ask or Deny, plus a background-sync flag. Where a sync engine does not exist yet, the pane says so honestly instead of pretending.',
        deepLink: { label: 'Open Permissions', href: '/permissions' },
      },
      {
        title: 'Grant a standing allowance — narrowly',
        body: 'An allowance turns Ask into Allow for one exact (kind, target, action) match. It never applies to privileged tools, never beats a hard floor or a policy deny, and can carry an expiry. Broad problems want policy changes, not allowances.',
        deepLink: { label: 'Open Permissions', href: '/permissions' },
      },
      {
        title: 'Override a single item when one thing differs',
        body: 'Per-item overrides adjust permissions for one specific bot, file or server without touching the surface default it sits under — the narrowest change that does the job.',
        deepLink: { label: 'Open Permissions', href: '/permissions' },
      },
      {
        title: 'Reset when in doubt',
        body: 'The pane can reset overrides back to the shipped defaults. When you are unsure what state you left things in, resetting and re-approving beats guessing.',
        deepLink: { label: 'Open Permissions', href: '/permissions' },
      },
    ],
    relatedCapabilities: ['approvals-governance'],
    keywords: ['permissions', 'pane', 'allowance', 'override', 'connector', 'identity', 'surface', 'allow ask deny'],
  },
  {
    id: 'feed',
    title: 'Feed: a proactive briefing on the topics you name',
    theme: 'Discover & extend',
    audience: 'Anyone who wants the team watching topics for them',
    summary:
      'Feed is a KriyaDot module that generates posts in the background from a brief you write — the topics you care about — so staying current is reading, not searching. Find it in the Modules hub under More.',
    steps: [
      {
        title: 'Open Feed from the Modules hub',
        body: 'More → Modules hub lists the modules; open the Feed card ("Open Feed →"). The same page is reachable directly at the Feed module route.',
        deepLink: { label: 'Open Feed', href: '/modules/feed' },
      },
      {
        title: 'Write your brief',
        body: 'In "Your brief", name the topics in plain words — for example "AI agent frameworks, TypeScript, indie hacking" — and choose "Save brief". The brief is what every generated post is aimed at.',
        deepLink: { label: 'Open Feed', href: '/modules/feed' },
      },
      {
        title: 'Generate posts',
        body: 'Choose "Generate posts" and Feed researches and writes posts against your brief, each with its sources noted. With no posts yet the page says exactly this: "No posts yet. Save a brief, then hit Generate posts."',
        deepLink: { label: 'Open Feed', href: '/modules/feed' },
      },
      {
        title: 'Read, dismiss, discuss',
        body: 'Work through the posts; dismiss what is noise so the signal improves, and take any post into Chat to discuss it with the team when you want depth.',
        deepLink: { label: 'Open Universal Chat', href: '/' },
      },
      {
        title: 'Retune the brief instead of fighting the feed',
        body: 'If posts drift off what you care about, edit the brief — one clear brief beats a pile of dismissals, and the next generation follows the new brief.',
        deepLink: { label: 'Open Feed', href: '/modules/feed' },
      },
    ],
    relatedCapabilities: ['feed'],
    keywords: ['feed', 'brief', 'posts', 'proactive', 'topics', 'news', 'digest', 'modules'],
  },
  {
    id: 'computer-use',
    title: 'Computer use: bots that drive a real desktop, under approval',
    theme: 'Safety & control',
    audience: 'Anyone letting a bot operate apps instead of APIs',
    summary:
      'Bots can drive a computer — screenshot, click, type, open apps — for work that has no API. Every mutating action is approval-gated, each bot gets its own computer surface, and real mouse control is foreground: it is the user\'s cursor, and the UI says so.',
    steps: [
      {
        title: 'Choose the surface on the bot\'s Computer tab',
        body: 'Open a bot and its Computer tab: the "Works on surface" control picks auto (best available), local (this machine), a remote computer, or off (disable computer tools for this bot). Each bot gets its own computer — no shared cursors.',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
      {
        title: 'Know what needs approval',
        body: 'Screenshots are auto-allowed so a bot can see before it acts. Clicks, typing, key presses and other mutating actions require your approval every time, under the same governance as every other consequential tool.',
        deepLink: { label: 'Open Approvals', href: '/approvals' },
      },
      {
        title: 'Real desktop control is foreground — plan for it',
        body: 'Driving your real machine uses your real cursor: it happens in the foreground where you can watch, step in, or stop it. Work that must run unattended belongs on API tools, the browser backend, or a sandboxed surface instead.',
        deepLink: { label: 'Open Bots', href: '/bots' },
      },
      {
        title: 'Web forms prefer the browser backend',
        body: 'For web pages, the browser (Playwright) backend fills forms and clicks through flows without touching your cursor; native apps are what the real-desktop surface is for. Ask in Chat and the bot picks the backend that fits.',
        deepLink: { label: 'Open Universal Chat', href: '/' },
      },
      {
        title: 'Phone work goes through the phone agent',
        body: 'Operating real apps on your Android phone — including sending a file in a chat app — works two ways: the messaging channel send, and the phone agent operating the app itself, both under the same approval rules.',
        deepLink: { label: 'Open Activity', href: '/activity' },
      },
    ],
    relatedCapabilities: ['computer-use', 'approvals-governance'],
    keywords: ['computer', 'desktop', 'mouse', 'click', 'type', 'screenshot', 'open app', 'gui', 'playwright', 'form', 'cursor'],
  },
];

/** Lookup by id; undefined for unknown ids (routes answer 404). */
export function getGuideArticle(id: string): GuideArticle | undefined {
  return GUIDE_ARTICLES.find((a) => a.id === id);
}

/** Question filler that must never drive matching ("how do I …?" matches everything otherwise). */
const STOPWORDS = new Set([
  'how', 'do', 'does', 'did', 'i', 'me', 'a', 'an', 'the', 'to', 'can',
  'could', 'should', 'what', 'is', 'it', 'you', 'your', 'please',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9@]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Weighted score of one article against already-tokenized query terms. */
export function scoreGuideArticle(article: GuideArticle, terms: string[]): number {
  if (terms.length === 0) return 0;
  const title = article.title.toLowerCase();
  const keywords = article.keywords.join(' ').toLowerCase();
  const caps = article.relatedCapabilities.join(' ').toLowerCase();
  const body = [
    article.summary,
    article.audience,
    ...article.steps.flatMap((s) => [s.title, s.body]),
  ]
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 5;
    if (keywords.includes(term)) score += 4;
    if (caps.includes(term)) score += 3;
    if (body.includes(term)) score += 1;
  }
  return score;
}

export interface GuideSearchHit {
  article: GuideArticle;
  score: number;
}

/** Ranked guide search: title > keywords > capabilities > body. Zero-score hits are dropped. */
export function searchGuide(query: string, limit = 10): GuideSearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  return GUIDE_ARTICLES.map((article) => ({ article, score: scoreGuideArticle(article, terms) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title))
    .slice(0, Math.max(1, limit));
}

/** Every deep link an article contains, de-duplicated by href, in step order. */
export function articleDeepLinks(article: GuideArticle): GuideDeepLink[] {
  const seen = new Set<string>();
  const out: GuideDeepLink[] = [];
  for (const step of article.steps) {
    if (step.deepLink && !seen.has(step.deepLink.href)) {
      seen.add(step.deepLink.href);
      out.push(step.deepLink);
    }
  }
  return out;
}
