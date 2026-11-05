// SPDX-License-Identifier: Apache-2.0
'use client';

// Connection-needed card: rendered in chat just-in-time when a Composio
// tool result says an app cannot be used yet — the platform is not set
// up, the app is not in the catalog, the user's account for it is not
// connected, or it is not enabled for this bot. Shows one primary link
// into /accounts so the user can fix it without hunting through settings.

import React from 'react';

export type ConnectionNeededKind =
  | 'platform_not_configured'
  | 'not_in_catalog'
  | 'account_not_connected'
  | 'not_enabled_for_bot';

export type ConnectionNeededActionType =
  | 'setup_platform'
  | 'connect_app'
  | 'enable_for_bot'
  | 'open_connected_apps';

export interface ConnectionNeededAction {
  type: ConnectionNeededActionType;
  href: string;
}

export interface ConnectionNeededData {
  kind: ConnectionNeededKind;
  appSlug: string;
  appName?: string;
  botId?: string;
  message?: string;
  action: ConnectionNeededAction;
}

const KINDS: ReadonlySet<string> = new Set([
  'platform_not_configured',
  'not_in_catalog',
  'account_not_connected',
  'not_enabled_for_bot',
]);

const ACTION_TYPES: ReadonlySet<string> = new Set([
  'setup_platform',
  'connect_app',
  'enable_for_bot',
  'open_connected_apps',
]);

const COMPOSIO_TOOLS: ReadonlySet<string> = new Set(['composio_call', 'composio_list_actions']);

function defaultActionType(kind: ConnectionNeededKind): ConnectionNeededActionType {
  switch (kind) {
    case 'platform_not_configured':
      return 'setup_platform';
    case 'not_enabled_for_bot':
      return 'enable_for_bot';
    case 'account_not_connected':
      return 'connect_app';
    case 'not_in_catalog':
      return 'open_connected_apps';
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Extract a ConnectionNeededData from a structured (A) payload, or null. */
function fromStructured(result: Record<string, unknown>): ConnectionNeededData | null {
  const raw = result.connectionNeeded;
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as {
    kind?: unknown;
    appSlug?: unknown;
    appName?: unknown;
    botId?: unknown;
    message?: unknown;
    action?: unknown;
  };
  if (typeof c.kind !== 'string' || !KINDS.has(c.kind)) return null;
  if (typeof c.action !== 'object' || c.action === null) return null;
  const action = c.action as { type?: unknown; href?: unknown };
  const href = asNonEmptyString(action.href);
  // kind + href are the minimum viable card; anything less is malformed.
  if (!href) return null;
  const kind = c.kind as ConnectionNeededKind;
  const type =
    typeof action.type === 'string' && ACTION_TYPES.has(action.type)
      ? (action.type as ConnectionNeededActionType)
      : defaultActionType(kind);
  const appName = asNonEmptyString(c.appName);
  const botId = asNonEmptyString(c.botId);
  const message = asNonEmptyString(c.message);
  return {
    kind,
    appSlug: typeof c.appSlug === 'string' ? c.appSlug : '',
    ...(appName ? { appName } : {}),
    ...(botId ? { botId } : {}),
    ...(message ? { message } : {}),
    action: { type, href },
  };
}

/** Extract a ConnectionNeededData from a thrown-handler error text (B), or null. */
function fromErrorText(error: string): ConnectionNeededData | null {
  if (/Composio is not connected/.test(error)) {
    return {
      kind: 'platform_not_configured',
      appSlug: '',
      message: error,
      action: { type: 'setup_platform', href: '/accounts?setup=platform' },
    };
  }
  const notEnabled = /app "([a-z0-9_-]+)" is not enabled for this bot/.exec(error);
  if (notEnabled) {
    const appSlug = notEnabled[1] as string;
    return {
      kind: 'not_enabled_for_bot',
      appSlug,
      message: error,
      action: { type: 'enable_for_bot', href: `/accounts?app=${appSlug}` },
    };
  }
  if (/unknown Composio account/.test(error)) {
    return {
      kind: 'account_not_connected',
      appSlug: '',
      message: error,
      action: { type: 'open_connected_apps', href: '/accounts' },
    };
  }
  return null;
}

/**
 * Extract a ConnectionNeededData from a Composio tool result, or null.
 * (A) structured `connectionNeeded` on composio_list_actions results,
 * then (B) stable refusal strings in `{ error }` results from
 * composio_call / composio_list_actions. Never throws.
 */
export function connectionNeededFromToolResult(
  toolName: string,
  result: unknown,
): ConnectionNeededData | null {
  try {
    if (!COMPOSIO_TOOLS.has(toolName)) return null;
    if (typeof result !== 'object' || result === null) return null;
    const r = result as Record<string, unknown>;
    if (toolName === 'composio_list_actions' && 'connectionNeeded' in r) {
      const structured = fromStructured(r);
      if (structured) return structured;
    }
    if (typeof r.error === 'string') return fromErrorText(r.error);
    return null;
  } catch {
    return null;
  }
}

function appDisplayName(data: ConnectionNeededData): string {
  return data.appName || data.appSlug || 'this app';
}

function titleFor(data: ConnectionNeededData): string {
  const app = appDisplayName(data);
  switch (data.kind) {
    case 'platform_not_configured':
      return 'Connect the app platform to use this';
    case 'not_in_catalog':
      return `${app} isn't available in your Composio workspace`;
    case 'account_not_connected':
      return `Connect ${app} to continue`;
    case 'not_enabled_for_bot':
      return `Enable ${app} for this bot`;
  }
}

function defaultBodyFor(data: ConnectionNeededData): string {
  const app = appDisplayName(data);
  switch (data.kind) {
    case 'platform_not_configured':
      return 'The app platform (Composio) needs to be set up before bots can use external apps.';
    case 'not_in_catalog':
      return `${app} is not available in your Composio workspace, so this bot cannot use it yet.`;
    case 'account_not_connected':
      return `Connect ${app} first, then try again.`;
    case 'not_enabled_for_bot':
      return `${app} is not enabled for this bot yet. Enable it, then try again.`;
  }
}

function actionLabelFor(data: ConnectionNeededData): string {
  switch (data.action.type) {
    case 'setup_platform':
      return 'Set up the app platform';
    case 'connect_app':
      return `Connect ${appDisplayName(data)}`;
    case 'enable_for_bot':
      return 'Enable for this bot';
    case 'open_connected_apps':
      return 'Open Connected Apps';
  }
}

export function ConnectionNeededCard({ data }: { data: ConnectionNeededData }) {
  const rawBody = data.message || defaultBodyFor(data);
  const body = rawBody.length > 200 ? `${rawBody.slice(0, 200)}…` : rawBody;
  return (
    <div
      className="approval-card"
      style={{ borderLeft: '3px solid var(--amber, #e67700)' }}
      data-testid="connection-needed-card"
    >
      <h4>🔌 {titleFor(data)}</h4>
      <p className="small muted" style={{ margin: '6px 0' }}>
        {body}
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <a href={data.action.href} className="btn btn-sm btn-primary">
          {actionLabelFor(data)}
        </a>
      </div>
    </div>
  );
}
