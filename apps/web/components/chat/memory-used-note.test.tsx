// SPDX-License-Identifier: Apache-2.0
// MemoryUsedNote + ModelRouteBadge (OH-3/OH-5): render with meta shows
// the collapsible citation note; absent meta renders nothing at all.
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryUsedNote, ModelRouteBadge, memoryFactPreview } from './memory-used-note';
import type { MemoryUsedItem } from '../../lib/api';

afterEach(() => cleanup());

const ITEMS: MemoryUsedItem[] = [
  { atomId: 'a1', fact: 'Prefers terse answers with no preamble.', category: 'preference', sourceTurn: 'turn-12' },
  { atomId: 'a2', fact: 'Building a price-comparison app called Sauda.', category: 'fact', sourceTurn: 'turn-30' },
];

describe('MemoryUsedNote', () => {
  it('renders nothing when meta is absent or empty (no layout shift)', () => {
    const { container: c1 } = render(<MemoryUsedNote items={undefined} />);
    expect(c1.firstChild).toBeNull();
    const { container: c2 } = render(<MemoryUsedNote items={[]} />);
    expect(c2.firstChild).toBeNull();
    const { container: c3 } = render(<MemoryUsedNote items={null} />);
    expect(c3.firstChild).toBeNull();
  });

  it('shows the "Memory used · N" header, collapsed by default', () => {
    render(<MemoryUsedNote items={ITEMS} />);
    const head = screen.getByRole('button', { name: /Memory used · 2/ });
    expect(head).toBeInTheDocument();
    expect(head).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands to fact preview + category + source per item, and collapses again', () => {
    render(<MemoryUsedNote items={ITEMS} />);
    fireEvent.click(screen.getByRole('button', { name: /Memory used · 2/ }));
    expect(screen.getByRole('button', { name: /Memory used · 2/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Prefers terse answers with no preamble.')).toBeInTheDocument();
    expect(screen.getByText('Building a price-comparison app called Sauda.')).toBeInTheDocument();
    expect(screen.getByText('preference')).toBeInTheDocument();
    expect(screen.getByText('turn-12')).toBeInTheDocument();
    expect(screen.getByText('turn-30')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Memory used · 2/ }));
    expect(screen.getByRole('button', { name: /Memory used · 2/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('truncates long facts in the preview', () => {
    const long = 'x'.repeat(300);
    expect(memoryFactPreview(long)).toHaveLength(140);
    expect(memoryFactPreview(long).endsWith('…')).toBe(true);
    expect(memoryFactPreview('short fact')).toBe('short fact');
  });
});

describe('ModelRouteBadge', () => {
  it('renders nothing without a route', () => {
    const { container } = render(<ModelRouteBadge route={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows "Auto → <model>" with the reason as tooltip', () => {
    render(<ModelRouteBadge route={{ chosen: 'llama-3.3-70b', reason: 'Short factual turn' }} />);
    const badge = screen.getByText('Auto → llama-3.3-70b');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', 'Short factual turn');
  });
});
