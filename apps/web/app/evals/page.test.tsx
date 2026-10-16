// SPDX-License-Identifier: Apache-2.0
// Evals page: rendering is covered by type-checking; these tests verify the
// module loads, the page component exists, and the eval API client surface
// is complete.

import { describe, expect, it } from 'vitest';
import EvalsPage from './page';
import {
  deleteEvalSuite,
  getEvalRun,
  listEvalRuns,
  listEvalSuites,
  saveEvalSuite,
  startEvalRun,
  streamEvalRun,
} from '../../lib/api';

describe('evals page', () => {
  it('exports the EvalsPage component', () => {
    expect(typeof EvalsPage).toBe('function');
  });

  it('exposes the full eval API client surface', () => {
    for (const fn of [
      listEvalSuites,
      saveEvalSuite,
      deleteEvalSuite,
      startEvalRun,
      listEvalRuns,
      getEvalRun,
      streamEvalRun,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });
});
