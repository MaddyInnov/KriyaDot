// SPDX-License-Identifier: Apache-2.0
// GuideHint (ADD-3): the reusable empty-state hint links to the exact
// guide article for that surface.
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { GuideHint } from './hint';

describe('GuideHint', () => {
  it('renders its text and a deep link to the matching guide article', () => {
    render(<GuideHint articleId="workflows" text="No workflows yet." />);
    expect(screen.getByTestId('guide-hint')).toBeInTheDocument();
    expect(screen.getByText(/No workflows yet\./)).toBeInTheDocument();
    const link = screen.getByText(/Open the guide walkthrough/).closest('a');
    expect(link?.getAttribute('href')).toBe('/more/guide#workflows');
  });
});
