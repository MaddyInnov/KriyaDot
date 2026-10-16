// SPDX-License-Identifier: Apache-2.0
// AgentImportPanel exports the component for the "Import from other agents"
// settings section. Component rendering is covered by type-checking; these
// tests verify the module loads and the expected exports exist.

import { describe, expect, it } from 'vitest';
import { AgentImportPanel } from './agent-import-panel';

describe('agent-import-panel', () => {
  it('exports the AgentImportPanel component', () => {
    expect(typeof AgentImportPanel).toBe('function');
  });
});
