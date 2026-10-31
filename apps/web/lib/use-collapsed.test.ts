// SPDX-License-Identifier: Apache-2.0
// Shared collapse/size state (2026-10-31 collapse pass): the persisted
// pattern every section and divided window uses — collapsed flags under
// `kriyadot:collapse:<panelId>`, pane widths under
// `kriyadot:size:<panelId>`, collapse never clearing the stored width.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  collapseStorageKey,
  sizeStorageKey,
  useCollapsed,
  usePaneSize,
} from './use-collapsed';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('storage keys', () => {
  it('namespaces collapse and size keys per panel', () => {
    expect(collapseStorageKey('chat-inspector')).toBe('kriyadot:collapse:chat-inspector');
    expect(sizeStorageKey('chat-preview')).toBe('kriyadot:size:chat-preview');
  });
});

describe('useCollapsed', () => {
  it('defaults to expanded and persists setCollapsed', () => {
    const { result } = renderHook(() => useCollapsed('panel-a'));
    expect(result.current.collapsed).toBe(false);
    act(() => result.current.setCollapsed(true));
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem('kriyadot:collapse:panel-a')).toBe('1');
    act(() => result.current.setCollapsed(false));
    expect(localStorage.getItem('kriyadot:collapse:panel-a')).toBe('0');
  });

  it('toggle flips and persists', () => {
    const { result } = renderHook(() => useCollapsed('panel-b', true));
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    expect(localStorage.getItem('kriyadot:collapse:panel-b')).toBe('0');
  });

  it('loads the persisted flag on mount', () => {
    localStorage.setItem('kriyadot:collapse:panel-c', '1');
    const { result } = renderHook(() => useCollapsed('panel-c'));
    expect(result.current.collapsed).toBe(true);
  });

  it('keeps panels independent', () => {
    const a = renderHook(() => useCollapsed('panel-d'));
    const b = renderHook(() => useCollapsed('panel-e'));
    act(() => a.result.current.setCollapsed(true));
    expect(a.result.current.collapsed).toBe(true);
    expect(b.result.current.collapsed).toBe(false);
  });
});

describe('usePaneSize', () => {
  it('starts at the CSS default (null) and persists explicit widths', () => {
    const { result } = renderHook(() => usePaneSize('pane-a'));
    expect(result.current.width).toBe(null);
    act(() => result.current.setWidth(512));
    expect(result.current.width).toBe(512);
    expect(localStorage.getItem('kriyadot:size:pane-a')).toBe('512');
  });

  it('reset removes the stored width (back to the CSS default)', () => {
    const { result } = renderHook(() => usePaneSize('pane-b'));
    act(() => result.current.setWidth(640));
    act(() => result.current.reset());
    expect(result.current.width).toBe(null);
    expect(localStorage.getItem('kriyadot:size:pane-b')).toBe(null);
  });

  it('loads the persisted width on mount', () => {
    localStorage.setItem('kriyadot:size:pane-c', '733');
    const { result } = renderHook(() => usePaneSize('pane-c'));
    expect(result.current.width).toBe(733);
  });

  it('collapse state never clears the stored width (compose rule)', () => {
    localStorage.setItem('kriyadot:size:pane-d', '480');
    const size = renderHook(() => usePaneSize('pane-d'));
    const col = renderHook(() => useCollapsed('pane-d'));
    act(() => col.result.current.setCollapsed(true));
    act(() => col.result.current.setCollapsed(false));
    expect(size.result.current.width).toBe(480);
    expect(localStorage.getItem('kriyadot:size:pane-d')).toBe('480');
  });
});
