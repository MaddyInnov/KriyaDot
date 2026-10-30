// SPDX-License-Identifier: Apache-2.0
// Composer placement pill visibility rules: enabled only when sync is
// configured; otherwise disabled with the connect-cloud tooltip. The
// pill is a per-message choice (clicking toggles the value via onChange).
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlacementPill } from './placement-pill';

afterEach(() => cleanup());

describe('PlacementPill', () => {
  it('shows "This device" by default and toggles to cloud on click when sync is configured', () => {
    const onChange = vi.fn();
    render(<PlacementPill value="local" onChange={onChange} syncConfigured />);
    const pill = screen.getByRole('button', { name: /This device/ });
    expect(pill).not.toBeDisabled();
    expect(pill).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pill);
    expect(onChange).toHaveBeenCalledWith('cloud');
  });

  it('shows "In cloud" when the per-message value is cloud, and toggles back', () => {
    const onChange = vi.fn();
    render(<PlacementPill value="cloud" onChange={onChange} syncConfigured />);
    const pill = screen.getByRole('button', { name: /In cloud/ });
    expect(pill).toHaveAttribute('aria-pressed', 'true');
    expect(pill).toHaveAttribute('data-placement', 'cloud');
    fireEvent.click(pill);
    expect(onChange).toHaveBeenCalledWith('local');
  });

  it('is disabled with the connect-cloud tooltip when sync is not configured', () => {
    const onChange = vi.fn();
    render(<PlacementPill value="local" onChange={onChange} syncConfigured={false} />);
    const pill = screen.getByRole('button', { name: /This device/ });
    expect(pill).toBeDisabled();
    expect(pill).toHaveAttribute('title', 'Connect cloud to run tasks in your cloud');
    fireEvent.click(pill);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is disabled while a send is in flight', () => {
    render(<PlacementPill value="local" onChange={() => undefined} syncConfigured disabled />);
    expect(screen.getByRole('button', { name: /This device/ })).toBeDisabled();
  });
});
