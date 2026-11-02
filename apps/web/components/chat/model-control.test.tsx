// SPDX-License-Identifier: Apache-2.0
// ModelControl popover search (chrome simplification follow-up,
// 2026-10-31): the pinned "Search models…" filter — needed because the
// backend serves LIVE model lists for liveModels providers (a linked
// OpenRouter account returns hundreds of models). Covers filtering,
// provider-group hiding, the no-matches line, keyboard navigation, and
// Escape focus return.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModelControl, type ModelControlProvider } from './model-control';

afterEach(() => cleanup());

const PROVIDERS: ModelControlProvider[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    configured: true,
    models: [
      { id: 'anthropic/claude-opus-4.5', name: 'Claude Opus 4.5' },
      { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' },
      { id: 'openai/gpt-5', name: 'GPT-5' },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    configured: false,
    models: [{ id: 'llama-3.3-70b', name: 'Llama 3.3 70B' }],
  },
  { id: 'emptyprov', name: 'EmptyProv', configured: true, models: [] },
];

function renderControl() {
  const handlers = {
    onSelectModel: vi.fn(),
    onSelectBotDefault: vi.fn(),
    onTurnModelChange: vi.fn(),
    onSandboxChange: vi.fn(),
    onEffortChange: vi.fn(),
    onQueueModeChange: vi.fn(),
  };
  const utils = render(
    <ModelControl
      providers={PROVIDERS}
      providerId="openrouter"
      modelId="anthropic/claude-opus-4.5"
      botDefaultLabel="Scout default (GPT-OSS 120B)"
      turnModel=""
      sandboxMode="workspace-write"
      reasoningEffort="medium"
      queueMode="queue"
      {...handlers}
    />,
  );
  return { handlers, ...utils };
}

function openPopover() {
  fireEvent.click(
    screen.getByTitle(/Provider · model · effort · access/),
  );
}

function searchInput() {
  return screen.getByLabelText('Search models') as HTMLInputElement;
}

function groupNames(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.mc-group-name')).map((el) =>
    el.textContent?.replace('no key', '').trim(),
  );
}

describe('ModelControl popover search', () => {
  it('opens with the search input pinned and auto-focused, current model highlighted', () => {
    renderControl();
    openPopover();
    expect(searchInput()).toBeInTheDocument();
    expect(document.activeElement).toBe(searchInput());
    // Current selection starts highlighted for keyboard users.
    expect(screen.getByRole('button', { name: 'Claude Opus 4.5' })).toHaveClass('highlighted');
    // Existing behaviors intact: checkmark + "no key" tag.
    expect(screen.getByRole('button', { name: 'Claude Opus 4.5' })).toHaveTextContent('✓');
    expect(screen.getByText('no key')).toBeInTheDocument();
  });

  it('filters models live and hides provider groups with no matches', () => {
    const { container } = renderControl();
    openPopover();
    fireEvent.change(searchInput(), { target: { value: 'haiku' } });
    expect(screen.getByRole('button', { name: 'Claude Haiku 4.5' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Claude Opus 4.5' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Llama 3.3 70B' })).not.toBeInTheDocument();
    expect(groupNames(container)).toEqual(['OpenRouter']);
    // Bot-default row does not match "haiku" and disappears too.
    expect(screen.queryByRole('button', { name: /Bot default/ })).not.toBeInTheDocument();
  });

  it('matches on model id as well as name', () => {
    renderControl();
    openPopover();
    fireEvent.change(searchInput(), { target: { value: 'llama-3.3' } });
    expect(screen.getByRole('button', { name: 'Llama 3.3 70B' })).toBeInTheDocument();
  });

  it('a provider-name match keeps that provider’s whole model list', () => {
    const { container } = renderControl();
    openPopover();
    fireEvent.change(searchInput(), { target: { value: 'groq' } });
    expect(groupNames(container)).toEqual(['Groq']);
    expect(screen.getByRole('button', { name: 'Llama 3.3 70B' })).toBeInTheDocument();
  });

  it('hides the secondary sections while searching and restores them when cleared', () => {
    renderControl();
    openPopover();
    expect(screen.getByText('Next turn only')).toBeInTheDocument();
    expect(screen.getByText('Effort')).toBeInTheDocument();
    fireEvent.change(searchInput(), { target: { value: 'opus' } });
    expect(screen.queryByText('Next turn only')).not.toBeInTheDocument();
    expect(screen.queryByText('Effort')).not.toBeInTheDocument();
    fireEvent.change(searchInput(), { target: { value: '' } });
    expect(screen.getByText('Next turn only')).toBeInTheDocument();
    expect(screen.getByText('Effort')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Llama 3.3 70B' })).toBeInTheDocument();
  });

  it('shows a no-matches line when nothing fits', () => {
    renderControl();
    openPopover();
    fireEvent.change(searchInput(), { target: { value: 'zzzz-nothing' } });
    expect(screen.getByText(/No models match/)).toBeInTheDocument();
  });

  it('arrow keys move the highlight and Enter selects the highlighted model', () => {
    const { handlers } = renderControl();
    openPopover();
    const input = searchInput();
    // Highlight starts on the current model (Claude Opus 4.5); one ↓ → Haiku.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: 'Claude Haiku 4.5' })).toHaveClass('highlighted');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(handlers.onSelectModel).toHaveBeenCalledWith(
      'openrouter',
      'anthropic/claude-haiku-4.5',
    );
    // Popover closed after selection.
    expect(screen.queryByLabelText('Search models')).not.toBeInTheDocument();
  });

  it('arrow-up at the top clamps instead of wrapping', () => {
    renderControl();
    openPopover();
    const input = searchInput();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    // Flat order is [Auto, Bot default, current model, …]: from the
    // current model (index 2) ups reach Bot default (1), then Auto (0),
    // and clamp there instead of wrapping.
    expect(screen.getByRole('button', { name: /Auto — pick per message/ })).toHaveClass('highlighted');
  });

  it('Enter on a search that only matches Bot default selects the bot default', () => {
    const { handlers } = renderControl();
    openPopover();
    fireEvent.change(searchInput(), { target: { value: 'bot default' } });
    fireEvent.keyDown(searchInput(), { key: 'Enter' });
    expect(handlers.onSelectBotDefault).toHaveBeenCalledTimes(1);
    expect(handlers.onSelectModel).not.toHaveBeenCalled();
  });

  it('Escape closes the popover and returns focus to the control', () => {
    renderControl();
    const control = screen.getByTitle(/Provider · model · effort · access/);
    openPopover();
    expect(searchInput()).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByLabelText('Search models')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(control);
  });

  it('mouse hover moves the highlight so mouse and keyboard stay in sync', () => {
    renderControl();
    openPopover();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'GPT-5' }));
    expect(screen.getByRole('button', { name: 'GPT-5' })).toHaveClass('highlighted');
    expect(screen.getByRole('button', { name: 'Claude Opus 4.5' })).not.toHaveClass('highlighted');
  });
});

describe('ModelControl Auto row (OH-5)', () => {
  function renderAutoControl(modelId: string) {
    const handlers = {
      onSelectModel: vi.fn(),
      onSelectBotDefault: vi.fn(),
      onTurnModelChange: vi.fn(),
      onSandboxChange: vi.fn(),
      onEffortChange: vi.fn(),
      onQueueModeChange: vi.fn(),
    };
    const utils = render(
      <ModelControl
        providers={PROVIDERS}
        providerId="openrouter"
        modelId={modelId}
        botDefaultLabel="Scout default (GPT-OSS 120B)"
        turnModel=""
        sandboxMode="workspace-write"
        reasoningEffort="medium"
        queueMode="queue"
        {...handlers}
      />,
    );
    return { handlers, ...utils };
  }

  it('renders the Auto row at the top, above Bot default and provider groups', () => {
    const { container } = renderControl();
    openPopover();
    const rows = Array.from(container.querySelectorAll('.mc-row'));
    expect(rows[0]).toHaveTextContent('Auto — pick per message');
    expect(rows[0]).toHaveTextContent(/Chooses from your configured providers per message shape/);
    expect(rows[1]).toHaveTextContent('Bot default');
  });

  it('selecting Auto sets the model to "auto" through onSelectModel', () => {
    const { handlers } = renderControl();
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: /Auto — pick per message/ }));
    expect(handlers.onSelectModel).toHaveBeenCalledWith('openrouter', 'auto');
    expect(handlers.onSelectBotDefault).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Search models')).not.toBeInTheDocument();
  });

  it('Enter selects Auto when it is the highlighted row', () => {
    const { handlers } = renderControl();
    openPopover();
    fireEvent.change(searchInput(), { target: { value: 'auto' } });
    fireEvent.keyDown(searchInput(), { key: 'Enter' });
    expect(handlers.onSelectModel).toHaveBeenCalledWith('openrouter', 'auto');
  });

  it('stays visible for an "auto" search but hides for unrelated terms', () => {
    renderControl();
    openPopover();
    fireEvent.change(searchInput(), { target: { value: 'aut' } });
    expect(screen.getByRole('button', { name: /Auto — pick per message/ })).toBeInTheDocument();
    fireEvent.change(searchInput(), { target: { value: 'haiku' } });
    expect(screen.queryByRole('button', { name: /Auto — pick per message/ })).not.toBeInTheDocument();
  });

  it('when the selection is auto, the closed label shows "Auto" and the row is checkmarked', () => {
    renderAutoControl('auto');
    const control = screen.getByTitle(/Provider · model · effort · access/);
    expect(control).toHaveTextContent('Auto');
    expect(control).not.toHaveTextContent('OpenRouter');
    fireEvent.click(control);
    const autoRow = screen.getByRole('button', { name: /Auto — pick per message/ });
    expect(autoRow).toHaveClass('current');
    expect(autoRow).toHaveTextContent('✓');
    expect(autoRow).toHaveClass('highlighted');
    expect(screen.getByRole('button', { name: /Bot default/ })).not.toHaveClass('current');
  });
});
