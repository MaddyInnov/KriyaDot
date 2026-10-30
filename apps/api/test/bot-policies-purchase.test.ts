// SPDX-License-Identifier: Apache-2.0
// Regression (QA 2026-10-30, red-team WS-E): PUT /bots/:id/policy accepted
// an `allow ^request_purchase$` rule because validatePolicyRules' privileged
// probe list omitted request_purchase — while POST /bots/:id/allow-tool
// correctly refused it. Policy simulation then reported purchases as
// allowed, defeating the "no always-allow for purchases, ever" invariant
// at the policy surface. The validator must reject every allow rule whose
// pattern can match a purchase (or any other privileged tool).

import { describe, expect, it } from 'vitest';
import { validatePolicyRules } from '../src/bot-policies.js';

function rules(toolPattern: string, effect: string) {
  return [{ id: 'r1', toolPattern, effect }];
}

describe('validatePolicyRules: purchases can never be always-allowed', () => {
  it('rejects allow ^request_purchase$', () => {
    expect(() => validatePolicyRules(rules('^request_purchase$', 'allow'))).toThrow(/privileged/);
  });

  it('rejects allow patterns that merely contain the purchase tool name', () => {
    expect(() => validatePolicyRules(rules('request_purchase', 'allow'))).toThrow(/privileged/);
    expect(() => validatePolicyRules(rules('^request_.*', 'allow'))).toThrow(/privileged/);
    expect(() => validatePolicyRules(rules('.*', 'allow'))).toThrow(/privileged/);
  });

  it('rejects allow for the other privileged file/command tools', () => {
    for (const p of ['^edit_file$', '^create_file$', '^remove_file$', '^write_file$', '^run_command$']) {
      expect(() => validatePolicyRules(rules(p, 'allow'))).toThrow(/privileged/);
    }
  });

  it('still permits require-approval and deny rules for purchases', () => {
    expect(validatePolicyRules(rules('^request_purchase$', 'require-approval'))).toHaveLength(1);
    expect(validatePolicyRules(rules('^request_purchase$', 'deny'))).toHaveLength(1);
  });

  it('still permits allow rules for ordinary tools', () => {
    expect(validatePolicyRules(rules('^web_search$', 'allow'))).toHaveLength(1);
    expect(validatePolicyRules(rules('^read_file$', 'allow'))).toHaveLength(1);
  });
});
