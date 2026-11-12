// SPDX-License-Identifier: Apache-2.0
// B2: MultiUserProNotice renders only in the gate-on + Pro-missing
// state; gate OFF (default) and Pro-licensed states render nothing.
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MultiUserProNotice } from './multi-user-pro-notice';
import type { MultiUserGateStatus } from '../../lib/multi-user-gate';

afterEach(() => cleanup());

const denied: MultiUserGateStatus = {
  gateEnabled: true,
  allowed: false,
  feature: 'multi-user',
  requiredTier: 'pro',
  code: 'multi_user_requires_pro',
  error: 'license_required',
  message: 'Multi-user teams require a Pro license. Add a license that includes the "multi-user" feature.',
};

describe('MultiUserProNotice', () => {
  it('shows the Pro requirement when the gate is on and Pro is missing', () => {
    render(<MultiUserProNotice status={denied} />);
    const note = screen.getByTestId('multi-user-pro-notice');
    expect(note).toHaveTextContent('Pro required');
    expect(note).toHaveTextContent('multi-user');
  });

  it('renders nothing when the gate is OFF (the default)', () => {
    const { container } = render(
      <MultiUserProNotice status={{ gateEnabled: false, allowed: true, feature: 'multi-user', requiredTier: 'pro' }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing with a Pro license, and nothing before status loads', () => {
    const { container } = render(
      <MultiUserProNotice status={{ gateEnabled: true, allowed: true, feature: 'multi-user', requiredTier: 'pro' }} />,
    );
    expect(container).toBeEmptyDOMElement();
    const { container: c2 } = render(<MultiUserProNotice status={null} />);
    expect(c2).toBeEmptyDOMElement();
  });
});
