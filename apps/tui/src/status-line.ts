// SPDX-License-Identifier: Apache-2.0
// CA-18: configurable TUI status line.
// The template lives in tui.json as `statusLine` and may reference
// {bot} {model} {cost} {contextPct} {gitBranch} {session}. Unknown fields
// render as-is (left in the output) so a typo is visible, not silent;
// known-but-unavailable values render as an em dash.
import { spawnSync } from 'node:child_process';

export interface StatusLineContext {
  bot?: string;
  model?: string;
  /** Session cost in USD; undefined when unknown. */
  cost?: number;
  /** Context-window usage 0..100; undefined when unknown. */
  contextPct?: number;
  gitBranch?: string;
  session?: string;
}

/** Preserves the spirit of the pre-CA-18 fixed header info. */
export const DEFAULT_STATUS_LINE = '{bot} · {model} · {session}';

export const STATUS_LINE_FIELDS = ['bot', 'model', 'cost', 'contextPct', 'gitBranch', 'session'] as const;

function fieldValue(field: string, ctx: StatusLineContext): string | undefined {
  switch (field) {
    case 'bot':
      return ctx.bot || undefined;
    case 'model':
      return ctx.model || undefined;
    case 'cost':
      return ctx.cost === undefined ? undefined : `$${ctx.cost.toFixed(2)}`;
    case 'contextPct':
      return ctx.contextPct === undefined ? undefined : `${Math.round(ctx.contextPct)}% ctx`;
    case 'gitBranch':
      return ctx.gitBranch || undefined;
    case 'session':
      return ctx.session ? ctx.session.slice(0, 8) : undefined;
    default:
      return undefined;
  }
}

/** Render a status-line template against a context. Pure; never throws. */
export function renderStatusLine(template: string | undefined, ctx: StatusLineContext): string {
  const tpl = template && template.trim() ? template : DEFAULT_STATUS_LINE;
  return tpl.replace(/\{([A-Za-z]+)\}/g, (whole, field: string) => {
    if (!(STATUS_LINE_FIELDS as readonly string[]).includes(field)) return whole;
    return fieldValue(field, ctx) ?? '—';
  });
}

/** Best-effort current git branch for `cwd`; undefined outside a repo. */
export function detectGitBranch(cwd: string, run?: (cmd: string, args: string[]) => string): string | undefined {
  try {
    let out: string;
    if (run) {
      out = run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
    } else {
      const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 1500 });
      if (r.status !== 0) return undefined;
      out = r.stdout;
    }
    const branch = out.trim();
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}
