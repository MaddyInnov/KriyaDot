// SPDX-License-Identifier: Apache-2.0
// Settings window host: opens on the kriyadot:open-settings event,
// hosts the existing settings page components (stubbed here), switches
// sections from its own nav, and closes on Esc / backdrop / ✕ without
// touching the page behind it.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import SettingsWindowHost, { SETTINGS_SECTIONS, openSettings } from './settings-window';

vi.mock('../../app/accounts/page', () => ({ default: () => <div>Accounts panel stub</div> }));
vi.mock('../../app/providers/page', () => ({ default: () => <div>Providers panel stub</div> }));
vi.mock('../../app/messaging/page', () => ({ default: () => <div>Messaging panel stub</div> }));
vi.mock('../../app/usage/page', () => ({ default: () => <div>Usage panel stub</div> }));
vi.mock('../../app/permissions/page', () => ({ default: () => <div>Permissions panel stub</div> }));
vi.mock('../../app/preferences/page', () => ({ default: () => <div>Preferences panel stub</div> }));
vi.mock('../../app/more/page', () => ({ default: () => <div>Modules panel stub</div> }));

afterEach(() => cleanup());

describe('settings window', () => {
  it('registry covers the seven settings surfaces', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.href)).toEqual([
      '/accounts',
      '/providers',
      '/messaging',
      '/usage',
      '/permissions',
      '/preferences',
      '/more',
    ]);
  });

  it('opens on the event, hosts the requested section, switches and closes', async () => {
    render(
      <div>
        <p>Chat state behind the window</p>
        <SettingsWindowHost />
      </div>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    openSettings('/providers');
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(await screen.findByText('Providers panel stub')).toBeInTheDocument();
    // The page behind the window is untouched.
    expect(screen.getByText('Chat state behind the window')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Connected Apps/ }));
    expect(await screen.findByText('Accounts panel stub')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes from the backdrop and defaults to Connected Apps', async () => {
    render(<SettingsWindowHost />);
    openSettings();
    expect(await screen.findByText('Accounts panel stub')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('settings-window-overlay'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
