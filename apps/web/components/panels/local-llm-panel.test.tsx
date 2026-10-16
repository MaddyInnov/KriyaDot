// SPDX-License-Identifier: Apache-2.0
// LocalLlmPanel exports the component for the Local LLM settings section.
// Component rendering is covered by type-checking; these tests verify
// the module loads and the expected exports exist.

import { describe, expect, it } from 'vitest';
import { LocalLlmPanel } from './local-llm-panel';

describe('local-llm-panel', () => {
  it('exports the LocalLlmPanel component', () => {
    expect(typeof LocalLlmPanel).toBe('function');
  });
});
