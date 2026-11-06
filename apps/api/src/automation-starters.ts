// SPDX-License-Identifier: Apache-2.0
// Automation starters — one-click recipes that turn a connected app into
// a ready-made (but DISABLED) bot routine the user can review and enable.
//
// A starter is a recipe: the Composio apps it needs, a routine schedule
// (or an event trigger resolved at creation time), and a prompt template.
// Creating a starter persists a BotRoutine with enabled:false — nothing
// ever fires until the user enables it in Routines.
//
// Honesty rules (same as connected-apps.ts):
//   - No prompt template names a concrete Composio action slug. Every
//     template instructs the bot to call composio_list_actions for the
//     named toolkits first and to use ONLY an action slug that tool
//     returns — never an invented one.
//   - Send/publish steps are draft-only: templates say "prepare a draft
//     and stop for my approval". (composio_call write actions are also
//     approval-gated by governance, so this is defense in depth.)
//   - WhatsApp has no Composio event trigger in this system, so the
//     WhatsApp starter POLLS on an interval and says so — it is never
//     dressed up as event-driven.
//
// Wiring (coordinator, in routes.ts):
//   import { registerAutomationStartersRoutes } from './automation-starters.js';
//   registerAutomationStartersRoutes(router, deps);
//
// Routes (relative to the router mount, i.e. /api/...):
//   GET  /automation-starters[?botId=]   → { starters: [...] } with
//                                          per-recipe readiness for the caller
//   POST /automation-starters/:id/create → { botId } → creates the routine
//                                          DISABLED; { ok, routineId, ... }

import express from 'express';
import type { Request, Response } from 'express';
import type { RouteDeps } from './routes.js';
import { principalMiddleware, type PrincipalContext } from './principal.js';
import {
  composioCallerOf,
  composioEntityId,
  fetchComposioClient,
  getComposioApiKey,
  readComposioEnables,
  resolveComposioClient,
  type ComposioClient,
} from './composio.js';
import { readAccountCache } from './composio-accounts.js';
import {
  classifyConnectionNeed,
  featuredAppDefinition,
  type ConnectionNeeded,
} from './connected-apps.js';
import { RoutineStore } from './bot-routines.js';
import type { EventSchedule, RoutineSchedule } from './routine-schedules.js';

/** All starter schedules are interpreted in the user's home timezone. */
const STARTER_TIMEZONE = 'Asia/Kolkata';

// ---------------------------------------------------------------------------
// Recipe model
// ---------------------------------------------------------------------------

export interface StarterScheduleContext {
  /**
   * Resolve the connected-account id for a toolkit slug from the local
   * account cache (status ACTIVE). The cache is the local mirror of the
   * user's Composio accounts; it is acceptable at starter-creation time
   * because the routine's own event engine re-resolves and re-validates
   * the account at runtime before every poll.
   */
  accountIdFor: (slug: string) => string | undefined;
}

export type AutomationStarterCategory =
  | 'content'
  | 'communication'
  | 'work'
  | 'business'
  | 'development';

export interface AutomationStarterRecipe {
  id: string;
  name: string;
  description: string;
  category: AutomationStarterCategory;
  /** Composio toolkit slugs this starter uses. */
  requiredApps: string[];
  /**
   * Slugs that enhance the starter but never block it. A slug may appear
   * in both lists (it is part of the full experience, but readiness and
   * creation do not require it).
   */
  optionalApps?: string[];
  triggerKind: 'event' | 'schedule' | 'manual';
  /** Static schedule for schedule-triggered starters. */
  schedule?: RoutineSchedule;
  /**
   * Dynamic schedule resolved at creation time (event triggers need a
   * concrete connected-account id). Returning null creates the routine
   * with no schedule (manual firing) — the readiness notes say why.
   */
  scheduleFor?: (ctx: StarterScheduleContext) => RoutineSchedule | null;
  promptTemplate: string;
  /** What the user is told about approvals for this starter. */
  approvalNote: string;
}

const DISCOVERY =
  'First call composio_list_actions for the toolkits named below to discover the real actions available, ' +
  'and use only an action slug that tool returns — never invent an action name.';

const DRAFT_RULE =
  'Never send or publish anything directly: for every send/publish step, prepare a draft and stop for my approval.';

export const AUTOMATION_STARTERS: AutomationStarterRecipe[] = [
  {
    id: 'canva-design-archive-post',
    name: 'Canva design archive + social drafts',
    category: 'content',
    description:
      'Once a day, exports your new Canva designs, archives the exports to Google Drive and your workspace, ' +
      'and prepares draft Instagram and LinkedIn posts for them. Instagram and LinkedIn are optional — ' +
      'the design archive still runs when they are not connected.',
    requiredApps: ['canva', 'googledrive', 'instagram', 'linkedin'],
    optionalApps: ['instagram', 'linkedin'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'daily',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      time: '18:00',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: canva, googledrive, instagram, linkedin. ${DRAFT_RULE} ` +
      'Steps: (1) Find the Canva designs I created or updated since the last run. ' +
      '(2) Export each finished design. (3) Save every export to Google Drive and to my workspace so I have both copies. ' +
      '(4) For each exported design, draft one Instagram caption and one LinkedIn post text, matched to the design, ' +
      'and present them as drafts — prepare a draft and stop for my approval before anything is posted. ' +
      'Finish with a short summary of what was archived. Run context (may be empty): {{payload}}',
    approvalNote:
      'Drafts only: the bot archives files on its own, but every Instagram or LinkedIn post is prepared as a draft and stops for your approval — nothing is published directly.',
  },
  {
    id: 'whatsapp-lead-digest',
    name: 'WhatsApp lead digest',
    category: 'communication',
    description:
      'Polls your WhatsApp Business account through Composio every 30 minutes and summarises new leads. ' +
      'Honest label: there is no WhatsApp event trigger, so this starter polls on an interval instead of ' +
      'reacting instantly. The summary is saved to your workspace (and to a Google Sheet when one is ' +
      'connected), and a reply draft is prepared for each lead.',
    requiredApps: ['whatsapp'],
    optionalApps: ['googlesheets'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'interval',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      everyMinutes: 30,
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: whatsapp, and googlesheets when it is connected. ${DRAFT_RULE} ` +
      'Steps: (1) Read the incoming WhatsApp Business messages that arrived since the last run. ' +
      '(2) Identify which senders are sales leads and what each one is asking about. ' +
      '(3) Save a short lead summary to my workspace; when a Google Sheet is connected, also append one row per lead to it. ' +
      '(4) For each lead, prepare a draft reply in a helpful tone — prepare a draft and stop for my approval; never send a reply directly. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Reply drafts only: summaries and sheet rows are saved automatically, but every WhatsApp reply is a draft that stops for your approval — the bot never messages a customer on its own.',
  },
  {
    id: 'instagram-engagement-digest',
    name: 'Instagram engagement digest',
    category: 'content',
    description:
      'A daily morning briefing of your Instagram comments and mentions: what people said, what needs a ' +
      'reply, and draft replies for the ones that matter.',
    requiredApps: ['instagram'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'daily',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      time: '09:00',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: instagram. ${DRAFT_RULE} ` +
      'Steps: (1) Read the comments and mentions on my Instagram professional account from the last day. ' +
      '(2) Group them into: questions waiting for an answer, praise, complaints, and spam or noise. ' +
      '(3) Write my morning briefing with counts and the most important items first. ' +
      '(4) For each item that deserves a reply, prepare a draft reply and stop for my approval — never post a reply directly. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Briefing + drafts only: the digest is produced automatically, but every reply is prepared as a draft and stops for your approval before it is posted.',
  },
  {
    id: 'linkedin-content-pipeline',
    name: 'LinkedIn content pipeline',
    category: 'content',
    description:
      'Once a week, turns a workspace note into a LinkedIn post draft, reminds you to review it, and ' +
      'summarises engagement on your recent posts.',
    requiredApps: ['linkedin'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'cron',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      expression: '0 10 * * 1', // Mondays 10:00 in the schedule timezone
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: linkedin. ${DRAFT_RULE} ` +
      'Steps: (1) Manual step: the note to turn into a post is the workspace note named in the run context below; ' +
      'if none is named, stop and ask me which note to use — choosing the note is a manual step only I can do. ' +
      '(2) Read that note and draft a LinkedIn post from it in my voice. ' +
      '(3) Present the draft as a scheduled reminder for me to review: prepare a draft and stop for my approval — never publish it directly. ' +
      '(4) Summarise the engagement on my recent LinkedIn posts so I can see what is working. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Drafts only: the post is drafted and surfaced as a review reminder, and publishing always waits for your approval.',
  },
  {
    id: 'gmail-important-mail-note',
    name: 'Important Gmail → workspace note',
    category: 'communication',
    description:
      'When new Gmail arrives on the connected account, summarises the important messages and saves a ' +
      'note to your workspace. Needs a connected Gmail account at creation time so the event trigger can ' +
      'be bound to it; without one the routine is created for manual firing and this page says why.',
    requiredApps: ['gmail'],
    triggerKind: 'event',
    scheduleFor: (ctx) => {
      const accountId = ctx.accountIdFor('gmail');
      if (!accountId) return null;
      const schedule: EventSchedule = {
        kind: 'event',
        timezone: STARTER_TIMEZONE,
        enabled: true,
        overlap: 'skip',
        app: 'gmail',
        accountId,
        pollMinutes: 15,
        dailyCap: 20,
      };
      return schedule;
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: gmail. ${DRAFT_RULE} ` +
      'The event payload for this run is: {{payload}} ' +
      'Steps: (1) Read the new Gmail message(s) described in the payload. ' +
      '(2) Decide which ones are important (they need my reply, a decision, or carry a deadline) and which are noise. ' +
      '(3) Summarise the important ones and save the summary as a note in my workspace. ' +
      '(4) If a message needs a reply, prepare a draft reply and stop for my approval — never send email directly.',
    approvalNote:
      'Notes only: summaries are saved automatically, but any reply is prepared as a draft and stops for your approval — the bot never sends email on its own.',
  },
  {
    id: 'morning-brief',
    name: 'Morning brief',
    category: 'work',
    description:
      'Runs on a daily schedule at 08:00 on every weekday: builds your day plan from Google Calendar and Gmail — ' +
      'meetings with times, important unread mail, and prep notes — and saves it as a workspace note.',
    requiredApps: ['gmail', 'googlecalendar'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'daily',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      time: '08:00',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: gmail, googlecalendar. ${DRAFT_RULE} ` +
      'Steps: (1) Read my Google Calendar events for today, in order, with their times and attendees. ' +
      '(2) Read my important unread Gmail from the last day and pick out anything that needs a reply, a decision, or preparation before a meeting. ' +
      '(3) Write a short day plan: meetings with times first, then the important mail, then prep notes for each meeting. ' +
      '(4) Save the day plan as a note in my workspace. If a message needs a reply, prepare a draft and stop for my approval — never send email directly. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Notes only: the morning brief is saved automatically, but any email reply is prepared as a draft and stops for your approval — the bot never sends email on its own.',
  },
  {
    id: 'slack-channel-digest',
    name: 'Slack channel digest',
    category: 'communication',
    description:
      'Runs on a daily schedule at 19:00: summarises the Slack channels named in the run context, with the ' +
      'decisions made and the action items, and prepares draft replies only.',
    requiredApps: ['slack'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'daily',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      time: '19:00',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: slack. ${DRAFT_RULE} ` +
      'Steps: (1) The channels to summarise are the ones named in the run context below; if no channel is named, stop and ask me which channels to use — never guess a channel. ' +
      '(2) Read the messages from today in each named channel. ' +
      '(3) Write a digest that lists the decisions made and the action items, with who owns each item when that is clear. ' +
      '(4) Save the digest to my workspace. For any message that deserves a reply, prepare a draft reply and stop for my approval — never post a message directly. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Digest plus drafts only: the summary is saved automatically, but every Slack reply is prepared as a draft and stops for your approval before anything is posted.',
  },
  {
    id: 'github-repo-digest',
    name: 'GitHub repo digest',
    category: 'development',
    description:
      'Runs on a weekly schedule, Mondays at 09:00: summarises new issues and pull requests on your GitHub ' +
      'repositories, calls out stale items, and prepares draft comments only.',
    requiredApps: ['github'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'cron',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      expression: '0 9 * * 1',
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: github. ${DRAFT_RULE} ` +
      'Steps: (1) Read the open issues and pull requests on my GitHub repositories from the last week. ' +
      '(2) Group them by repository and by urgency, and call out stale items that have had no activity for a long time. ' +
      '(3) Save the digest to my workspace. ' +
      '(4) Where a comment would help, prepare a draft comment and stop for my approval — never post a comment directly. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Digest plus drafts only: the summary is saved automatically, but every GitHub comment is prepared as a draft and stops for your approval before it is posted.',
  },
  {
    id: 'stripe-payments-digest',
    name: 'Stripe payments digest',
    category: 'business',
    description:
      'Runs on a daily schedule at 20:00: summarises Stripe revenue and failed payments and saves the ' +
      'summary to your workspace. Customers are never contacted except through a draft you approve.',
    requiredApps: ['stripe'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'daily',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      time: '20:00',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: stripe. ${DRAFT_RULE} ` +
      'Steps: (1) Read my Stripe payments for today: total revenue, payment count, and refunds. ' +
      '(2) List the failed payments with amounts and the stated failure reasons, without contacting any customer. ' +
      '(3) Save a short revenue and failed payments summary to my workspace. ' +
      '(4) If a customer follow-up would help, prepare a draft message and stop for my approval — never contact a customer directly. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Summary only: the digest is saved automatically, but customers are never contacted directly — any follow-up is a draft that stops for your approval.',
  },
  {
    id: 'drive-document-intake',
    name: 'Drive document intake',
    category: 'work',
    description:
      'Polls Google Drive on an interval, every 120 minutes: finds new files, summarises each one, extracts ' +
      'dates and action items, and saves an index note to your workspace.',
    requiredApps: ['googledrive'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'interval',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      everyMinutes: 120,
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: googledrive. ${DRAFT_RULE} ` +
      'Steps: (1) Find the Google Drive files that were added or changed since the last run. ' +
      '(2) Summarise each new file in a few lines. ' +
      '(3) Extract any dates, deadlines, and action items mentioned in the files. ' +
      '(4) Save an index note in my workspace that links each file to its summary, dates, and action items. ' +
      'This starter polls on an interval; it does not react the moment a file appears. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Notes only: summaries and the index note are saved automatically, and this starter changes nothing in Drive itself.',
  },
  {
    id: 'notion-action-items',
    name: 'Notion action items',
    category: 'work',
    description:
      'Runs on a daily schedule at 09:00: reads your recent Notion notes and pages and turns the action ' +
      'items it finds into a task-list draft in your workspace.',
    requiredApps: ['notion'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'daily',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      time: '09:00',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: notion. ${DRAFT_RULE} ` +
      'Steps: (1) Read my Notion pages and notes that were created or edited recently. ' +
      '(2) Pull out every action item, task, and follow-up you can find, with its context. ' +
      '(3) Write them as a clear task-list draft and save the draft to my workspace for my review. ' +
      '(4) Do not create or change tasks anywhere else — the task list stays a draft until I approve it. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Drafts only: the task list is prepared as a workspace draft and stops for your approval — nothing is created or changed in other tools directly.',
  },
  {
    id: 'youtube-channel-digest',
    name: 'YouTube channel digest',
    category: 'content',
    description:
      'Runs on a weekly schedule, Mondays at 10:00: summarises your YouTube channel performance and drafts ' +
      'ideas for the next videos.',
    requiredApps: ['youtube'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'cron',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      expression: '0 10 * * 1',
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: youtube. ${DRAFT_RULE} ` +
      'Steps: (1) Read my YouTube channel and recent video performance from the data available. ' +
      '(2) Summarise what performed well, what did not, and any clear patterns. ' +
      '(3) Draft a list of next-video ideas based on those patterns. ' +
      '(4) Save the performance summary and the draft ideas to my workspace. Any title or description change stays a draft and stops for my approval. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Summary plus drafts only: the report is saved automatically, but any change to a video is prepared as a draft and stops for your approval.',
  },
  {
    id: 'tiktok-content-digest',
    name: 'TikTok content digest',
    category: 'content',
    description:
      'Runs on a weekly schedule, Tuesdays at 10:00: summarises your TikTok performance and trends and ' +
      'drafts new content ideas.',
    requiredApps: ['tiktok'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'cron',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      expression: '0 10 * * 2',
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: tiktok. ${DRAFT_RULE} ` +
      'Steps: (1) Read my TikTok profile and recent video performance from the data available. ' +
      '(2) Summarise what performed well and any trends that fit my content. ' +
      '(3) Draft new content ideas based on that summary. ' +
      '(4) Save the summary and the draft ideas to my workspace — nothing is posted directly. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Summary plus drafts only: the report and ideas are saved as drafts, and nothing is posted to TikTok directly.',
  },
  {
    id: 'facebook-page-digest',
    name: 'Facebook Page digest',
    category: 'content',
    description:
      'Runs on a daily schedule at 09:00: digests comments and messages on your Facebook Pages and prepares ' +
      'draft replies for the ones that matter.',
    requiredApps: ['facebook'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'daily',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      time: '09:00',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: facebook. ${DRAFT_RULE} ` +
      'Steps: (1) Read the comments and messages on my Facebook Pages from the last day. Page actions only — personal profile activity is not part of this starter. ' +
      '(2) Group them into questions, praise, complaints, and spam or noise. ' +
      '(3) Save the digest to my workspace with the most important items first. ' +
      '(4) For each item that deserves a reply, prepare a draft reply and stop for my approval — never post or send a reply directly. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Digest plus drafts only: the summary is saved automatically, but every reply is prepared as a draft and stops for your approval before it is posted or sent.',
  },
  {
    id: 'figma-handoff-digest',
    name: 'Figma handoff digest',
    category: 'work',
    description:
      'Runs on a daily schedule at 18:00: turns recent Figma file activity and comments into a handoff note ' +
      'in your workspace, with draft comments only.',
    requiredApps: ['figma'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'daily',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      time: '18:00',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: figma. ${DRAFT_RULE} ` +
      'Steps: (1) Read the recent activity and comments on my Figma files from the last day. ' +
      '(2) Write a handoff note: what changed, which comments are still open, and what needs a decision. ' +
      '(3) Save the handoff note to my workspace. ' +
      '(4) Where a comment would help, prepare a draft comment and stop for my approval — never post a comment directly. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Notes plus drafts only: the handoff note is saved automatically, but every Figma comment is prepared as a draft and stops for your approval.',
  },
  {
    id: 'shopify-store-digest',
    name: 'Shopify store digest',
    category: 'business',
    description:
      'Runs on a daily schedule at 21:00: summarises Shopify orders and low-stock products and prepares ' +
      'draft customer replies only. It never changes an order.',
    requiredApps: ['shopify'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'daily',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      time: '21:00',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: shopify. ${DRAFT_RULE} ` +
      'Steps: (1) Read my store orders from today and summarise totals, notable orders, and anything that needs attention. ' +
      '(2) List products that are low on stock or out of stock. ' +
      '(3) Save the orders and low-stock summary to my workspace. ' +
      '(4) For any customer who needs a reply, prepare a draft reply and stop for my approval — never send it directly. ' +
      'Do not change any order: no refunds, no edits, no cancellations, and no fulfilment changes of any kind. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Summary plus drafts only: the digest is saved automatically, customer replies are drafts that stop for your approval, and the bot never changes an order.',
  },
  {
    id: 'zoom-meeting-followup',
    name: 'Zoom meeting follow-up',
    category: 'communication',
    description:
      'Polls Zoom on an interval, every 60 minutes: finds recent meetings, summarises each one, and drafts ' +
      'the follow-up emails.',
    requiredApps: ['zoom'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'interval',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      everyMinutes: 60,
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: zoom. ${DRAFT_RULE} ` +
      'Steps: (1) Find my Zoom meetings that finished since the last run, using the meeting details and recordings available. This starter polls on an interval, so a meeting is picked up on the next poll, not instantly. ' +
      '(2) Summarise each meeting: decisions, action items, and open questions. ' +
      '(3) Save the summaries to my workspace. ' +
      '(4) Draft a follow-up email for each meeting and stop for my approval — never send a follow-up directly. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Summaries plus drafts only: meeting summaries are saved automatically, but every follow-up email is a draft that stops for your approval before it is sent.',
  },
  {
    id: 'cross-social-weekly-report',
    name: 'Cross-social weekly report',
    category: 'content',
    description:
      'Runs on a weekly schedule, Sundays at 18:00: one report across your connected social apps. Instagram ' +
      'and Facebook are required; TikTok and YouTube are optional and are included only when they are connected. ' +
      'It also drafts next week\u2019s content plan.',
    requiredApps: ['instagram', 'facebook'],
    optionalApps: ['tiktok', 'youtube'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'cron',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      expression: '0 18 * * 0',
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: instagram, facebook, and tiktok and youtube when they are connected. ${DRAFT_RULE} ` +
      'Steps: (1) Read the last week of performance for Instagram and Facebook, and for TikTok and YouTube only when they are connected — say plainly which apps were included. ' +
      '(2) Write one weekly report that compares the apps: reach, engagement, and the best-performing posts. ' +
      '(3) Draft a content plan for next week based on what worked. ' +
      '(4) Save the report and the draft plan to my workspace — nothing is posted directly. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Report plus drafts only: the weekly report is saved automatically, but the next-week plan is a draft and nothing is posted to any social app directly.',
  },
  {
    id: 'sheets-kpi-snapshot',
    name: 'Sheets KPI snapshot',
    category: 'business',
    description:
      'Runs on a weekly schedule, Fridays at 17:00: reads the Google Sheet named in the run context and ' +
      'saves a KPI snapshot to your workspace. Google Drive is optional and only helps locate the sheet.',
    requiredApps: ['googlesheets'],
    optionalApps: ['googledrive'],
    triggerKind: 'schedule',
    schedule: {
      kind: 'cron',
      timezone: STARTER_TIMEZONE,
      enabled: true,
      overlap: 'skip',
      expression: '0 17 * * 5',
    },
    promptTemplate:
      `${DISCOVERY} Toolkits: googlesheets, and googledrive when it is connected. ${DRAFT_RULE} ` +
      'Steps: (1) The sheet to read is the one named in the run context below; if no sheet is named, stop and ask me which sheet to use — never guess a sheet. ' +
      '(2) Read the named sheet and pick out the key numbers and how they changed since the last snapshot. ' +
      '(3) Write a short KPI snapshot and save it to my workspace. ' +
      '(4) Do not change the sheet itself — this starter only reads it. ' +
      'Run context (may be empty): {{payload}}',
    approvalNote:
      'Read-only snapshot: the KPI summary is saved to your workspace automatically, and the sheet itself is never changed by this starter.',
  },
];

export function automationStarterById(id: string): AutomationStarterRecipe | undefined {
  return AUTOMATION_STARTERS.find((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// Readiness (pure)
// ---------------------------------------------------------------------------

export interface StarterReadinessState {
  platformConfigured: boolean;
  catalogSlugs: Set<string>;
  activeAccountSlugs: Set<string>;
  enabledSlugsForBot: Set<string>;
}

export interface StarterReadiness {
  ready: boolean;
  missing: { slug: string; need: ConnectionNeeded['kind'] }[];
}

/**
 * Readiness of one starter against a connection-state snapshot. Only
 * required apps block, and optional apps never do (a slug listed in both
 * requiredApps and optionalApps is treated as optional). Each blocking
 * slug is classified with the shared classifyConnectionNeed precedence:
 * platform → catalog → account → enablement.
 */
export function computeStarterReadiness(
  recipe: AutomationStarterRecipe,
  state: StarterReadinessState,
): StarterReadiness {
  const optional = new Set(recipe.optionalApps ?? []);
  const missing: StarterReadiness['missing'] = [];
  for (const slug of recipe.requiredApps) {
    if (optional.has(slug)) continue;
    const verdict = classifyConnectionNeed({
      platformConfigured: state.platformConfigured,
      inCatalog: state.catalogSlugs.has(slug),
      hasActiveAccount: state.activeAccountSlugs.has(slug),
      enabledForBot: state.enabledSlugsForBot.has(slug),
      appSlug: slug,
      appName: featuredAppDefinition(slug)?.name ?? slug,
    });
    if (verdict.kind !== 'ready') {
      missing.push({ slug, need: verdict.kind });
    }
  }
  return { ready: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export type AutomationStartersDeps = Pick<
  RouteDeps,
  'config' | 'governance' | 'bots' | 'loopbackToken'
> & {
  /** Injected in tests; defaults to the real fetch client in production. */
  composioClient?: ComposioClient;
  /** Tenancy JWT secret override (defaults to the KRIYADOT_TENANCY_JWT_SECRET env). */
  jwtSecret?: string;
  /** Routine store factory (tests inject a store they can inspect). */
  routineStoreFactory?: (dataDir: string) => RoutineStore;
};

/** Public recipe shape returned by GET /automation-starters. */
function publicRecipe(recipe: AutomationStarterRecipe) {
  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    category: recipe.category,
    requiredApps: recipe.requiredApps,
    ...(recipe.optionalApps ? { optionalApps: recipe.optionalApps } : {}),
    triggerKind: recipe.triggerKind,
    ...(recipe.schedule ? { schedule: recipe.schedule } : {}),
    promptTemplate: recipe.promptTemplate,
    approvalNote: recipe.approvalNote,
  };
}

export function registerAutomationStartersRoutes(
  router: express.Router,
  deps: AutomationStartersDeps,
): void {
  const pctx: PrincipalContext = {
    dataDir: deps.config.dataDir,
    loopbackToken: deps.loopbackToken,
    jwtSecret: deps.jwtSecret,
  };
  const client: ComposioClient = deps.composioClient ?? fetchComposioClient;
  const newRoutineStore =
    deps.routineStoreFactory ?? ((dataDir: string) => new RoutineStore(dataDir));

  function callerOf(req: Request): string {
    const userId = composioCallerOf(req, pctx);
    if (!userId) throw new Error('unauthenticated');
    return userId;
  }

  /**
   * Connection-state snapshot for readiness. Degradation follows the
   * connected-apps view: a catalog that cannot be loaded never produces
   * a fabricated not_in_catalog verdict (every known slug counts as in
   * catalog), and an account listing failure reads as "no accounts".
   * Without a botId the enablement gate is skipped entirely.
   */
  async function readinessState(userId: string, botId?: string): Promise<StarterReadinessState> {
    const dataDir = deps.config.dataDir;
    const allSlugs = new Set(AUTOMATION_STARTERS.flatMap((r) => r.requiredApps));
    // Managed mode: when no client is injected, resolve BYOK-or-managed so
    // readiness reflects the managed service (its apiKey is the service
    // token; the managed client ignores the entity argument server-side).
    // An injected client keeps the legacy BYOK-key path exactly.
    const resolved = deps.composioClient ? null : resolveComposioClient(dataDir, userId);
    const effClient: ComposioClient = resolved?.client ?? client;
    const apiKey = resolved ? resolved.apiKey : getComposioApiKey(dataDir, userId);
    if (!apiKey) {
      return {
        platformConfigured: false,
        catalogSlugs: new Set(),
        activeAccountSlugs: new Set(),
        enabledSlugsForBot: botId ? new Set() : allSlugs,
      };
    }
    let catalogSlugs: Set<string>;
    try {
      const apps = await effClient.listApps(apiKey);
      catalogSlugs = new Set(apps.map((a) => a.appId.toLowerCase()));
    } catch {
      catalogSlugs = allSlugs; // benefit of the doubt — presence unknown
    }
    let activeAccountSlugs = new Set<string>();
    try {
      const accounts = await effClient.listConnectedAccounts(apiKey, composioEntityId(userId));
      activeAccountSlugs = new Set(
        accounts
          .filter((a) => a.status.toUpperCase() === 'ACTIVE')
          .map((a) => a.toolkitSlug.toLowerCase()),
      );
    } catch {
      activeAccountSlugs = new Set();
    }
    let enabledSlugsForBot: Set<string>;
    if (!botId) {
      enabledSlugsForBot = allSlugs; // no bot in scope → enablement not checked
    } else {
      const perBot = readComposioEnables(dataDir, userId)[botId] ?? {};
      enabledSlugsForBot = new Set(
        Object.entries(perBot)
          .filter(([, v]) => v === true)
          .map(([slug]) => slug.toLowerCase()),
      );
    }
    return { platformConfigured: true, catalogSlugs, activeAccountSlugs, enabledSlugsForBot };
  }

  const r = express.Router();
  r.use(principalMiddleware(pctx));

  // GET /automation-starters[?botId=] — every recipe with its readiness
  // for the caller (and, when botId is given, for that bot).
  r.get('/', async (req: Request, res: Response) => {
    const botId = typeof req.query.botId === 'string' && req.query.botId ? req.query.botId : undefined;
    if (botId && !deps.bots.find((b) => b.id === botId)) {
      res.status(404).json({ error: `unknown bot: ${botId}` });
      return;
    }
    try {
      const state = await readinessState(callerOf(req), botId);
      res.json({
        starters: AUTOMATION_STARTERS.map((recipe) => ({
          ...publicRecipe(recipe),
          ...computeStarterReadiness(recipe, state),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Failed to compute automation starter readiness', detail: message });
    }
  });

  // POST /automation-starters/:id/create { botId } — persist the recipe
  // as a DISABLED routine for the bot. The user reviews and enables it
  // in Routines; creating a starter never fires anything.
  r.post('/:id/create', async (req: Request, res: Response) => {
    const recipe = automationStarterById(req.params.id);
    if (!recipe) {
      res.status(404).json({ error: `unknown automation starter: ${req.params.id}` });
      return;
    }
    const botId = (req.body as { botId?: unknown } | undefined)?.botId;
    if (typeof botId !== 'string' || !botId) {
      res.status(400).json({ error: 'botId is required' });
      return;
    }
    if (!deps.bots.find((b) => b.id === botId)) {
      res.status(404).json({ error: `unknown bot: ${botId}` });
      return;
    }
    try {
      const userId = callerOf(req);
      const dataDir = deps.config.dataDir;
      // accountIdFor resolves from the local account cache (the mirror of
      // the user's Composio accounts). Acceptable at creation time: the
      // routine's event engine re-resolves the account at runtime.
      const cache = readAccountCache(dataDir, userId);
      const accountIdFor = (slug: string): string | undefined => {
        for (const [id, record] of Object.entries(cache)) {
          if (
            record.toolkitSlug.toLowerCase() === slug.toLowerCase() &&
            record.status.toUpperCase() === 'ACTIVE'
          ) {
            return id;
          }
        }
        return undefined;
      };
      const schedule = recipe.scheduleFor?.({ accountIdFor }) ?? recipe.schedule ?? null;
      const store = newRoutineStore(dataDir);
      const routine = store.create({
        name: recipe.name,
        botId,
        promptTemplate: recipe.promptTemplate,
        schedule,
      });
      // Starters are created DISABLED: the user reviews the routine and
      // enables it deliberately. (RoutineStore.create defaults enabled.)
      const disabled = store.update(routine.id, { enabled: false }) ?? routine;
      deps.governance.audit('automation_starter.created', {
        actor: userId,
        toolName: 'automation-starters',
        detail: {
          starterId: recipe.id,
          routineId: routine.id,
          botId,
          triggerKind: recipe.triggerKind,
          scheduleApplied: schedule !== null,
        },
      });
      res.json({
        ok: true,
        routineId: routine.id,
        name: recipe.name,
        enabled: disabled.enabled,
        triggerKind: recipe.triggerKind,
        scheduleApplied: schedule !== null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'Failed to create the automation starter routine', detail: message });
    }
  });

  router.use('/automation-starters', r);
}
