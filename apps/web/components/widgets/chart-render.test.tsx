// SPDX-License-Identifier: Apache-2.0
// W8c/W8a rendering: stacked-bar charts render as inline SVG with
// theme-variable fills; step line and Now cards render live state.
// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { WidgetRenderer } from './widgets';
import { validateWidget } from './schema';
import { StepLine, NowCards } from '../chat/step-line';

describe('stacked-bar chart rendering (W8c)', () => {
  it('renders one rect per label×series with stacked heights', () => {
    const v = validateWidget({
      kind: 'chart',
      type: 'stacked-bar',
      title: 'Spend',
      labels: ['Jan', 'Feb'],
      series: [
        { label: 'Food', values: [10, 20] },
        { label: 'Travel', values: [5, 5] },
      ],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const { container } = render(<WidgetRenderer widget={v.widget} />);
    const rects = container.querySelectorAll('svg rect');
    expect(rects.length).toBe(4);
    // Theme palette: fills come from CSS variables, not hardcoded hex.
    const fills = [...rects].map((r) => (r as SVGRectElement).style.fill);
    expect(fills[0]).toContain('var(--accent)');
    expect(fills[1]).toContain('var(--green)');
    expect(container.textContent).toContain('Food');
  });

  it('grouped bar still renders for chartType bar', () => {
    const v = validateWidget({
      kind: 'chart',
      chartType: 'bar',
      labels: ['A'],
      series: [{ label: 'S', values: [7] }],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const { container } = render(<WidgetRenderer widget={v.widget} />);
    expect(container.querySelectorAll('svg rect').length).toBe(1);
  });
});

describe('step line + Now cards (W8a)', () => {
  it('StepLine shows the step, counter and elapsed', () => {
    const { container } = render(
      <StepLine
        state={{
          botId: 'b1',
          sessionId: 's1',
          step: 'Running read_file',
          stepIndex: 2,
          stepTotal: 8,
          startedAt: Date.now() - 5000,
          elapsedMs: 5000,
        }}
      />,
    );
    expect(container.textContent).toContain('Running read_file');
    expect(container.textContent).toContain('step 2 of 8');
  });

  it('NowCards lists busy bots and renders nothing when idle', () => {
    const { container, rerender } = render(<NowCards turns={[]} />);
    expect(container.textContent).toBe('');
    rerender(
      <NowCards
        turns={[
          {
            botId: 'b1',
            botName: 'Coder',
            sessionId: 's1',
            step: 'Thinking',
            startedAt: 0,
            updatedAt: 0,
            elapsedMs: 3000,
          },
        ]}
      />,
    );
    expect(container.textContent).toContain('Coder');
    expect(container.textContent).toContain('Thinking');
  });
});
