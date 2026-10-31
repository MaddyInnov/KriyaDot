// SPDX-License-Identifier: Apache-2.0
'use client';

// Shared collapse/expand + resize affordances (2026-10-31 collapse pass).
// Every collapsible section and divided window uses these three pieces so
// the whole app shares one chevron, one strip, one drag handle:
//
//   CollapseChevron — the accent ▾/▸ glyph, the same disclosure mark the
//     dc-details / dc-accordion family already uses.
//   PaneStrip — the slim re-open strip a collapsed side pane leaves
//     behind (never a dead end): one icon button + a vertical label.
//   PaneResizeHandle — a window-splitter (role="separator") on a pane's
//     edge: pointer drag to resize, arrow keys when focused, double-click
//     to reset to the default width. Width state lives in usePaneSize
//     (lib/use-collapsed.ts) under `kriyadot:size:<panelId>`.

import React, { useRef } from 'react';

export function CollapseChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <span className="kd-chev" aria-hidden="true">
      {collapsed ? '▸' : '▾'}
    </span>
  );
}

export function PaneStrip({
  label,
  side,
  onExpand,
}: {
  label: string;
  /** Which side of the layout the pane sits on — the chevron points back into the freed space. */
  side: 'left' | 'right';
  onExpand: () => void;
}) {
  return (
    <div className="kd-strip">
      <button
        type="button"
        className="kd-strip-btn"
        onClick={onExpand}
        aria-label={`Expand ${label}`}
        title={`Expand ${label}`}
      >
        <span aria-hidden="true">{side === 'left' ? '»' : '«'}</span>
      </button>
      <span className="kd-strip-label" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

/** Small chevron button placed in a pane's own header to collapse it. */
export function PaneCollapseButton({
  label,
  side,
  onCollapse,
}: {
  label: string;
  side: 'left' | 'right';
  onCollapse: () => void;
}) {
  return (
    <button
      type="button"
      className="icon-btn kd-collapse-btn"
      onClick={onCollapse}
      aria-label={`Collapse ${label}`}
      title={`Collapse ${label}`}
    >
      <span aria-hidden="true">{side === 'left' ? '«' : '»'}</span>
    </button>
  );
}

const KEY_STEP = 16;
const KEY_STEP_LARGE = 48;
/** Safety cap for the aria/absolute clamp; the live row-relative cap also applies during drags. */
const ABS_MAX = 1600;

export function PaneResizeHandle({
  label,
  edge,
  width,
  min,
  max = ABS_MAX,
  onResize,
  onReset,
}: {
  label: string;
  /** The pane edge the handle sits on: a right-side pane is resized from its LEFT edge. */
  edge: 'left' | 'right';
  /** Current effective width in px (stored width or the CSS default). */
  width: number;
  min: number;
  max?: number;
  onResize: (px: number) => void;
  onReset: () => void;
}) {
  const dragRef = useRef<{ startX: number; startW: number; rowW: number } | null>(null);

  const clamp = (px: number, rowW?: number) => {
    const rowCap = rowW ? Math.max(min, Math.floor(rowW * 0.7)) : max;
    return Math.min(Math.max(px, min), Math.min(max, rowCap));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // The pane being resized is the closest `.kd-resizable` ancestor when
    // the handle sits inside it (chat side panes), or the element whose
    // width the `width` prop tracks when the handle is a sibling grid
    // item (Workspace files split) — either way the row is the handle's
    // offset parent row for the 70% cap.
    const pane = e.currentTarget.closest('.kd-resizable');
    const row = pane?.parentElement ?? e.currentTarget.parentElement;
    dragRef.current = {
      startX: e.clientX,
      startW: pane ? pane.getBoundingClientRect().width : width,
      rowW: row ? row.getBoundingClientRect().width : 0,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const next = edge === 'left' ? drag.startW - dx : drag.startW + dx;
    onResize(clamp(next, drag.rowW));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = edge === 'left' ? width + step : width - step;
    else if (e.key === 'ArrowRight') next = edge === 'left' ? width - step : width + step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next !== null) {
      e.preventDefault();
      onResize(clamp(next));
    }
  };

  return (
    <div
      className={`kd-resize-handle kd-rh-${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="Drag to resize · Arrow keys nudge · Double-click resets"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
