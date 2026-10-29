// SPDX-License-Identifier: Apache-2.0
// Run health scoring + regression detection for workflow runs and bot turns.
// Telemetry stays local: scores persist in SQLite, findings are
// template-generated (no LLM, no network), and nothing here touches secrets.

export type {
  FindingSeverity,
  HealthBaselines,
  HealthFinding,
  HealthScore,
  HealthSignal,
  MetricSample,
  RegressionAlert,
  RegressionMetric,
  RunHealth,
  TurnHealth,
  TurnTelemetry,
} from './types.js';
export { scoreWorkflowRun, scoreTurn, scoreFromFindings, healthPoints, classifyError, loopFinding } from './scorer.js';
export type { ScoreRunOptions, ScoreTurnOptions } from './scorer.js';
export { detectRegressions } from './regressions.js';
export type { RegressionOptions } from './regressions.js';
export { RunHealthStore } from './store.js';
