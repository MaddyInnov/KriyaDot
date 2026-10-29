// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { validateWidget } from './schema';
import { registeredWidgetKinds } from './widgets';

describe('mcp-app and page widget kinds (web schema)', () => {
  it('validates an mcp-app widget and strips extras', () => {
    const r = validateWidget({
      kind: 'mcp-app',
      serverId: 'weather',
      resourceUri: 'ui://dash',
      nonce: 'n1',
      evil: '<script>',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.widget.kind).toBe('mcp-app');
      expect('evil' in r.widget).toBe(false);
    }
  });

  it('rejects mcp-app widgets without a nonce or with a non-ui URI', () => {
    expect(validateWidget({ kind: 'mcp-app', serverId: 'w', resourceUri: 'ui://x' }).ok).toBe(false);
    expect(
      validateWidget({ kind: 'mcp-app', serverId: 'w', resourceUri: 'https://e.example/', nonce: 'n' }).ok,
    ).toBe(false);
  });

  it('validates a page widget', () => {
    const r = validateWidget({ kind: 'page', pageId: 'p1', title: 'Doc', slug: 's', path: '/p/s' });
    expect(r.ok).toBe(true);
    expect(validateWidget({ kind: 'page' }).ok).toBe(false);
  });

  it('registers renderers for both new kinds', () => {
    const kinds = registeredWidgetKinds();
    expect(kinds).toContain('mcp-app');
    expect(kinds).toContain('page');
  });
});
