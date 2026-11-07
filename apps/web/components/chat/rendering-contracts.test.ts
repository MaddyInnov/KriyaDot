// SPDX-License-Identifier: Apache-2.0
// CSS contracts for two 2026-11-07 rendering defects, pinned at the
// stylesheet layer that owns them (app/globals.css):
//  1. .approval-card must never flex-shrink — it is a direct child of
//     the .chat-messages column-flex scroller and its overflow:hidden
//     makes its automatic minimum size 0, so a long conversation
//     crushed it to a thin strip and clipped the "Approval required"
//     label.
//  2. .btn-ghost needs a base rule — the .small/.danger modifiers
//     presuppose one; without it a bare .btn-ghost falls back to the
//     UA button background (light gray in every theme), so in dark
//     themes the light themed label rendered on a near-white box
//     (the cloud-sessions "Refresh" button looked like a blank box).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

/** Extract the declaration block of the first rule matching `selectorRe`. */
function ruleBody(selectorRe: RegExp): string {
  const m = selectorRe.exec(css);
  if (!m) return '';
  const open = css.indexOf('{', m.index);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('globals.css rendering contracts', () => {
  it('.approval-card opts out of flex shrinking', () => {
    const body = ruleBody(/^\.approval-card \{/m);
    expect(body).not.toBe('');
    expect(body).toContain('flex-shrink: 0');
  });

  it('.btn-ghost has a themed base rule (not just modifiers)', () => {
    const body = ruleBody(/^\.btn-ghost \{/m);
    expect(body).not.toBe('');
    expect(body).toContain('background: var(--surface-2)');
    expect(body).toContain('color: var(--text)');
    expect(body).toContain('border: 1px solid var(--border)');
  });
});
