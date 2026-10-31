// SPDX-License-Identifier: Apache-2.0
// Shared collapse affordances (2026-10-31 collapse pass): the one
// chevron, the re-open strip, the pane collapse button, and the
// window-splitter resize handle (keyboard adjust, min clamp, dbl-click
// reset, separator ARIA).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CollapseChevron, PaneCollapseButton, PaneResizeHandle, PaneStrip } from './collapse';

afterEach(() => cleanup());

describe('CollapseChevron', () => {
  it('points right when collapsed and down when expanded', () => {
    const { rerender } = render(React.createElement(CollapseChevron, { collapsed: true }));
    expect(screen.getByText('▸')).toBeTruthy();
    rerender(React.createElement(CollapseChevron, { collapsed: false }));
    expect(screen.getByText('▾')).toBeTruthy();
  });
});

describe('PaneStrip', () => {
  it('offers a labelled re-open button pointing back into the freed space', () => {
    const onExpand = vi.fn();
    render(React.createElement(PaneStrip, { label: 'Step inspector', side: 'right', onExpand }));
    const btn = screen.getByRole('button', { name: 'Expand Step inspector' });
    expect(btn.textContent).toContain('«');
    fireEvent.click(btn);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('points the other way for a left-side pane', () => {
    render(React.createElement(PaneStrip, { label: 'Bots', side: 'left', onExpand: () => {} }));
    expect(screen.getByRole('button', { name: 'Expand Bots' }).textContent).toContain('»');
  });
});

describe('PaneCollapseButton', () => {
  it('fires onCollapse with an accessible label', () => {
    const onCollapse = vi.fn();
    render(React.createElement(PaneCollapseButton, { label: 'file preview', side: 'right', onCollapse }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse file preview' }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});

describe('PaneResizeHandle', () => {
  function renderHandle(overrides: Partial<React.ComponentProps<typeof PaneResizeHandle>> = {}) {
    const props = {
      label: 'Resize pane',
      edge: 'left' as const,
      width: 400,
      min: 280,
      onResize: vi.fn(),
      onReset: vi.fn(),
      ...overrides,
    };
    render(React.createElement(PaneResizeHandle, props));
    return { ...props, handle: screen.getByRole('separator', { name: 'Resize pane' }) };
  }

  it('exposes separator ARIA with the current width', () => {
    const { handle } = renderHandle();
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuemin')).toBe('280');
    expect(handle.getAttribute('aria-valuenow')).toBe('400');
    expect(handle.getAttribute('tabIndex')).toBe('0');
  });

  it('arrow keys resize a left-edge handle (Left grows a right-side pane)', () => {
    const { handle, onResize } = renderHandle();
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(416);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(384);
  });

  it('shift+arrow takes the large step; a right-edge handle mirrors direction', () => {
    const { handle, onResize } = renderHandle({ edge: 'right' });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith(448);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(384);
  });

  it('clamps at the minimum and Home jumps to it', () => {
    const { handle, onResize } = renderHandle({ width: 288 });
    fireEvent.keyDown(handle, { key: 'ArrowRight' }); // left edge: shrink 288-16=272 → clamp 280
    expect(onResize).toHaveBeenLastCalledWith(280);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(onResize).toHaveBeenLastCalledWith(280);
  });

  it('double-click resets to the default width', () => {
    const { handle, onReset } = renderHandle();
    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
