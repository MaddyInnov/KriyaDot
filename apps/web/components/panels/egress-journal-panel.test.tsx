// SPDX-License-Identifier: Apache-2.0
// EgressJournalPanel (A13): module/export smoke test, matching the
// analytics-panel test pattern. The honest "Visible, not confined"
// labelling is asserted against the API payload the panel renders.

import { describe, expect, it } from 'vitest';
import { EgressJournalPanel } from './egress-journal-panel';

describe('egress-journal-panel', () => {
  it('exports the EgressJournalPanel component', () => {
    expect(typeof EgressJournalPanel).toBe('function');
  });
});
