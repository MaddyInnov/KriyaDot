// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { composeChangeInstruction, parsePickedElement } from './page-preview-pane';

describe('page preview pane helpers', () => {
  it('parses picker messages and rejects everything else', () => {
    expect(
      parsePickedElement({
        type: 'kriyadot:page-element',
        tag: 'h1',
        text: 'Hello',
        path: 'main > h1',
      }),
    ).toEqual({ tag: 'h1', text: 'Hello', path: 'main > h1' });
    expect(parsePickedElement({ type: 'other', tag: 'h1' })).toBeNull();
    expect(parsePickedElement(null)).toBeNull();
    expect(parsePickedElement({ type: 'kriyadot:page-element' })).toBeNull();
  });

  it('composes a change instruction referencing element + page id', () => {
    const text = composeChangeInstruction({
      pageId: 'page-42',
      pageTitle: 'Launch Notes',
      element: { tag: 'p', text: 'Old copy', path: 'main > p:nth-child(2)' },
      change: 'Make it punchier',
    });
    expect(text).toContain('page id: page-42');
    expect(text).toContain('<p>');
    expect(text).toContain('Old copy');
    expect(text).toContain('Make it punchier');
  });
});
