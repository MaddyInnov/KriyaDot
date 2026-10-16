// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  APPROVAL_MODES,
  PLAN_APPROVAL_TOOL,
  buildPlanPrompt,
  parseApprovalMode,
  validateApprovalMode,
} from '../src/approval-modes.js';

describe('parseApprovalMode', () => {
  it('accepts the three modes', () => {
    expect(parseApprovalMode('plan')).toBe('plan');
    expect(parseApprovalMode('auto')).toBe('auto');
    expect(parseApprovalMode('bypass')).toBe('bypass');
  });
  it('rejects anything else', () => {
    expect(parseApprovalMode('yolo')).toBeUndefined();
    expect(parseApprovalMode('')).toBeUndefined();
    expect(parseApprovalMode(undefined)).toBeUndefined();
    expect(parseApprovalMode(42)).toBeUndefined();
  });
  it('APPROVAL_MODES lists all three', () => {
    expect([...APPROVAL_MODES].sort()).toEqual(['auto', 'bypass', 'plan']);
  });
});

describe('validateApprovalMode', () => {
  it('passes undefined through (caller keeps default)', () => {
    expect(validateApprovalMode(undefined, 'bot')).toEqual({ errors: [] });
  });
  it('accepts valid modes', () => {
    expect(validateApprovalMode('plan', 'bots[0]').mode).toBe('plan');
  });
  it('reports invalid modes with location', () => {
    const v = validateApprovalMode('nope', 'bots[3]');
    expect(v.errors).toHaveLength(1);
    expect(v.errors[0]).toContain('bots[3].approvalMode');
  });
});

describe('buildPlanPrompt', () => {
  it('includes the task and asks for a numbered plan', () => {
    const p = buildPlanPrompt('Deploy the app');
    expect(p).toContain('Deploy the app');
    expect(p).toContain('step-by-step plan');
  });
});

describe('PLAN_APPROVAL_TOOL', () => {
  it('is a stable synthetic tool name for the plan gate card', () => {
    expect(PLAN_APPROVAL_TOOL).toBe('approve_plan');
  });
});
