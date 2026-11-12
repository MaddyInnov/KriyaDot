// SPDX-License-Identifier: Apache-2.0
// "Memory used" citation note (OH-3): when an assistant turn actually
// recalled durable memories, the message carries `memoryUsed` metadata
// and this collapsible note renders under it — header "Memory used · N",
// expanded list shows each item's fact preview + category + source.
// Absent/empty metadata renders NOTHING (no layout shift).
//
// Collapse state is local per note (the shared collapse kit persists by
// panel id; keying that by message would leak one note's state into
// every other note and fill localStorage with per-message keys) — the
// disclosure itself reuses the kit's CollapseChevron + kd-collapsible
// styling so it reads as the same affordance as every other section.

'use client';

import React, { useState } from 'react';
import type { MemoryUsedItem, ModelRouteInfo } from '../../lib/api';
import { CollapseChevron } from '../collapse';

export type { MemoryUsedItem, ModelRouteInfo };

/** Fact preview for one cited memory: first ~140 chars, ellipsised. */
export function memoryFactPreview(fact: string, max = 140): string {
  const text = (fact ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function MemoryUsedNote({ items }: { items?: MemoryUsedItem[] | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!items || items.length === 0) return null;
  return (
    <div className="memory-used-note">
      <button
        type="button"
        className="memory-used-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <CollapseChevron collapsed={!expanded} />
        <span className="memory-used-title">Memory used · {items.length}</span>
      </button>
      <div className={`kd-collapsible${expanded ? '' : ' closed'}`}>
        <div className="kd-collapsible-inner">
          <ul className="memory-used-list">
            {items.map((item) => (
              <li key={item.atomId} className="memory-used-item">
                <span className="memory-used-fact">{memoryFactPreview(item.fact)}</span>
                <span className="memory-used-meta">
                  {/* A10: an approved RULE firing is cited distinctly from a recalled fact. */}
                  {item.kind === 'rule' ? (
                    <span className="chip memory-used-rule" title="A standing rule you approved shaped this turn">
                      ⚖️ Rule
                    </span>
                  ) : null}
                  {item.category ? <span className="chip gray memory-used-cat">{item.category}</span> : null}
                  {item.sourceTurn ? <span className="memory-used-source">{item.sourceTurn}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * Auto-routing marker for the routing-chip area (OH-5): when a turn ran
 * under model 'auto', shows which model was actually chosen. The reason
 * rides the title tooltip so the chip row stays one line tall.
 */
export function ModelRouteBadge({ route }: { route?: ModelRouteInfo | null }) {
  if (!route || !route.chosen) return null;
  return (
    <span className="routing-chip-auto" title={route.reason || undefined}>
      Auto → {route.chosen}
    </span>
  );
}
