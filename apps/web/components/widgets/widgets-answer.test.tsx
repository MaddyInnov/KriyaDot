// SPDX-License-Identifier: Apache-2.0
// Interactive widget answer UI: buttons/select/input/confirm submit the
// exact answer shapes the protocol requires, expired widgets show the
// expired note with no submit path, and answered widgets render read-only.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { validateWidget, type Widget } from './schema';
import { WidgetRenderer, type WidgetRuntimeProps } from './widgets';

afterEach(() => cleanup());

const OPTS = [
  { id: 'a', label: 'Alpha', description: 'first option' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
];

function validWidget(payload: unknown): Widget {
  const r = validateWidget(payload);
  if (!r.ok) throw new Error(`test payload invalid: ${r.error}`);
  return r.widget;
}

function renderInteractive(widget: Widget, runtime: Partial<WidgetRuntimeProps> = {}) {
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <WidgetRenderer
      widget={widget}
      widgetId="w-1"
      expiresAt={Date.now() + 60_000}
      interactive
      onAnswer={onAnswer}
      {...runtime}
    />,
  );
  return { onAnswer, ...view };
}

describe('buttons widget answer flow', () => {
  const buttons = () =>
    validWidget({ kind: 'buttons', question: 'Pick one', options: OPTS, allowFreeText: true });

  it('clicks an option + submit calls onAnswer with {selected:[...]}', async () => {
    const { onAnswer } = renderInteractive(buttons());
    fireEvent.click(screen.getByRole('button', { name: /beta/i }));
    expect(screen.getByRole('button', { name: /beta/i })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('w-1', { selected: ['b'] });
  });

  it('requires a selection before submit is enabled', () => {
    renderInteractive(buttons());
    expect(screen.getByRole('button', { name: /^submit$/i })).toBeDisabled();
  });

  it('single-select replaces the previous choice', () => {
    const { onAnswer } = renderInteractive(buttons());
    fireEvent.click(screen.getByRole('button', { name: /alpha/i }));
    fireEvent.click(screen.getByRole('button', { name: /gamma/i }));
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));
    expect(onAnswer).toHaveBeenCalledWith('w-1', { selected: ['c'] });
  });

  it('multi-select toggles options and includes free text', () => {
    const widget = validWidget({ kind: 'buttons', options: OPTS, multiSelect: true, allowFreeText: true });
    const { onAnswer } = renderInteractive(widget);
    fireEvent.click(screen.getByRole('button', { name: /alpha/i }));
    fireEvent.click(screen.getByRole('button', { name: /gamma/i }));
    fireEvent.change(screen.getByPlaceholderText(/type your own/i), {
      target: { value: 'something else' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));
    expect(onAnswer).toHaveBeenCalledWith('w-1', {
      selected: ['a', 'c'],
      freeText: 'something else',
    });
  });
});

describe('select widget answer flow', () => {
  it('submits the chosen option id', () => {
    const widget = validWidget({ kind: 'select', label: 'Region', options: OPTS });
    const { onAnswer } = renderInteractive(widget);
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));
    expect(onAnswer).toHaveBeenCalledWith('w-1', { selected: ['b'] });
  });
});

describe('input widget answer flow', () => {
  it('submits {text} with the default prefilled', () => {
    const widget = validWidget({ kind: 'input', label: 'Name', default: 'Ada' });
    const { onAnswer } = renderInteractive(widget);
    expect(screen.getByLabelText('Name')).toHaveValue('Ada');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada Lovelace' } });
    fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));
    expect(onAnswer).toHaveBeenCalledWith('w-1', { text: 'Ada Lovelace' });
  });

  it('renders a textarea when multiline', () => {
    const widget = validWidget({ kind: 'input', label: 'Notes', multiline: true });
    renderInteractive(widget);
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
  });
});

describe('confirm widget answer flow', () => {
  const confirm = () =>
    validWidget({
      kind: 'confirm',
      question: 'Delete the database?',
      confirmLabel: 'Yes, delete',
      cancelLabel: 'Keep it',
    });

  it('posts {confirmed:true} on confirm', () => {
    const { onAnswer } = renderInteractive(confirm());
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(onAnswer).toHaveBeenCalledWith('w-1', { confirmed: true });
  });

  it('posts {confirmed:false} on cancel', () => {
    const { onAnswer } = renderInteractive(confirm());
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(onAnswer).toHaveBeenCalledWith('w-1', { confirmed: false });
  });
});

describe('expired and answered states', () => {
  const buttons = () => validWidget({ kind: 'buttons', question: 'Pick one', options: OPTS });

  it('expired widget renders the expired note and no submit', () => {
    renderInteractive(buttons(), { expiresAt: Date.now() - 1000 });
    expect(screen.getByText(/expired — the agent continued without an answer/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^submit$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /alpha/i })).toBeDisabled();
  });

  it('answered widget shows "You chose" read-only with the option label', () => {
    renderInteractive(buttons(), {
      answered: { answered: true, value: { selected: ['a'] }, answeredAt: Date.now() },
    });
    const note = screen.getByText(/you chose:/i);
    expect(note.textContent).toContain('Alpha');
    expect(screen.queryByRole('button', { name: /^submit$/i })).toBeNull();
  });

  it('server-expired unanswered widget shows the expired note', () => {
    renderInteractive(buttons(), {
      answered: { answered: true, expired: true, answeredAt: Date.now() },
    });
    expect(screen.getByText(/expired — the agent continued without an answer/i)).toBeTruthy();
  });

  it('display-only widget (interactive=false) renders without a submit button', () => {
    renderInteractive(buttons(), { interactive: false, onAnswer: undefined });
    expect(screen.queryByRole('button', { name: /^submit$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /beta/i })).toBeDisabled();
  });
});

describe('progress and image-view render', () => {
  it('progress renders a determinate bar with the percent', () => {
    const widget = validWidget({ kind: 'progress', title: 'Deploy', label: 'Uploading', percent: 42 });
    renderInteractive(widget);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText('42%')).toBeTruthy();
  });

  it('image-view renders the img with alt and caption', () => {
    const widget = validWidget({
      kind: 'image-view',
      url: 'https://example.com/chart.png',
      alt: 'MRR chart',
      caption: 'Weekly MRR',
    });
    renderInteractive(widget);
    const img = screen.getByAltText('MRR chart') as HTMLImageElement;
    expect(img.src).toBe('https://example.com/chart.png');
    expect(screen.getByText('Weekly MRR')).toBeTruthy();
  });
});
