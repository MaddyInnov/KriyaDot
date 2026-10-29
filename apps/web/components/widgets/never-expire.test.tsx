// SPDX-License-Identifier: Apache-2.0
// W12b: never-expire question cards render a "No expiry" label instead of
// a countdown and never flip to the expired state.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { validateWidget, type Widget } from './schema';
import { WidgetRenderer } from './widgets';

afterEach(() => cleanup());

function buttonsWidget(): Widget {
  const r = validateWidget({
    kind: 'buttons',
    question: 'Pick one',
    options: [{ id: 'a', label: 'Alpha' }],
  });
  if (!r.ok) throw new Error(r.error);
  return r.widget;
}

describe('never-expire widget rendering (W12b)', () => {
  it('shows the "No expiry" label and stays answerable with expiresAt=null', () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <WidgetRenderer
        widget={buttonsWidget()}
        widgetId="w-1"
        expiresAt={null}
        neverExpire
        interactive
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByText('No expiry')).toBeInTheDocument();
    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument();
    // The form is live (submit exists and is the normal answer path).
    expect(screen.getByRole('button', { name: /alpha/i })).toBeEnabled();
  });

  it('a normal card whose expiry passed shows the expired note and no "No expiry" label', () => {
    render(
      <WidgetRenderer
        widget={buttonsWidget()}
        widgetId="w-2"
        expiresAt={Date.now() - 1000}
        interactive
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.queryByText('No expiry')).not.toBeInTheDocument();
    expect(screen.getByText(/expired — the agent continued/i)).toBeInTheDocument();
  });
});
