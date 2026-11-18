// SPDX-License-Identifier: Apache-2.0
/**
 * Plan-level policy specs — Soteria Verified Plans, Workstream 1 (a).
 *
 * Per-call PolicyRules answer "may THIS tool call run?". A plan spec
 * answers a different question: "is this WHOLE PLAN — the ordered set of
 * tool calls the agent proposes to make — shaped the way policy
 * requires?" Specs are therefore constraints over a plan (a sequence of
 * steps), not over a single call:
 *
 *   - `ordering`         — a step matching toolPattern A must precede /
 *                          must not precede a step matching toolPattern B
 *                          (Soteria's temporal ≺ over the trace, at plan
 *                          granularity).
 *   - `requires-history` — a step is only valid when an EARLIER step of
 *                          the same plan called `requires.toolPattern`
 *                          (with matching args when qualified). This
 *                          generalises PolicyRule.requiresHistory from
 *                          session history to plan history.
 *   - `provenance`       — an argument of a step must be value-derived
 *                          from an earlier step's declared output
 *                          (Soteria's ⇝ value-flow): e.g. "the file a
 *                          delete step removes must be a file an earlier
 *                          step of this plan created or listed" — the
 *                          payment-provenance pattern from τ², in
 *                          KriyaDot terms.
 *   - `postcondition`    — the declared expected effect class of a step,
 *                          recorded at verification time for the runtime
 *                          monitor to check at completion. The verifier
 *                          itself does not block on postconditions.
 *
 * Specs live INSIDE the existing policy model — there is deliberately
 * no parallel policy universe: they ride on `Policy`/`BotPolicy`, load
 * from the same `.kriyadot/policy.json` (`planSpecs` block), merge with
 * the same first-scope-wins layering as rules, and are covered by the
 * existing policy-snapshot hash (canonical JSON of the whole policy),
 * so "this plan was verified against policy@<hash>" stays attestable.
 *
 * NOTE (established pattern, see bot-policy.ts): this package cannot
 * import @mvp/agent-runtime, so the spec shapes are declared here and
 * structurally duplicated in agent-runtime's plan-specs.ts. The two
 * declarations must stay field-compatible.
 *
 * Coverage classes are expressed through toolPatterns, so one spec can
 * span the action classes the programme cares about — file
 * (read_file|write_file|delete_file|move_file), browser
 * (browser_navigate|browser_click|browser_submit), app (computer-use
 * actions) and send/pay (send_message|send_email|request_purchase|…)
 * — without the spec language hard-coding tool names.
 */

/** Temporal ordering constraint between two tool patterns within a plan. */
export interface OrderingPlanSpec {
  type: 'ordering';
  id: string;
  /** Tool pattern (case-insensitive RegExp over the tool name) for the first step. */
  before: string;
  /** Tool pattern for the second step. */
  after: string;
  /** 'must-precede': every `after` step needs an earlier `before` step.
   *  'must-not-precede': no `before` step may appear before an `after` step. */
  relation: 'must-precede' | 'must-not-precede';
  reason?: string;
}

/** A step is valid only if an earlier plan step called a required tool. */
export interface RequiresHistoryPlanSpec {
  type: 'requires-history';
  id: string;
  /** Tool pattern of the step being constrained. */
  toolPattern: string;
  requires: {
    /** Tool pattern an earlier step must match. */
    toolPattern: string;
    /** When set, the earlier step's argument of this name must match `argPattern`. */
    arg?: string;
    /** Case-sensitive RegExp over the earlier step's argument value
     *  (the named arg, or the JSON of all args when `arg` is absent). */
    argPattern?: string;
    /** Minimum number of matching earlier steps (default 1). */
    minCount?: number;
  };
  reason?: string;
}

/** An argument of a step must be value-derived from an earlier step's output. */
export interface ProvenancePlanSpec {
  type: 'provenance';
  id: string;
  /** Tool pattern of the step whose argument is constrained. */
  toolPattern: string;
  /** Name of the constrained argument on that step. */
  arg: string;
  /** Tool pattern of the earlier step the value must derive from. */
  sourceToolPattern: string;
  /** Name of the declared output on the source step (default: same as `arg`). */
  sourceArg?: string;
  reason?: string;
}

/** Declared expected effect class of a step — recorded for the runtime monitor. */
export interface PostconditionPlanSpec {
  type: 'postcondition';
  id: string;
  /** Tool pattern of the step the declaration applies to. */
  toolPattern: string;
  /** Declared effect class, e.g. 'file-created' | 'file-deleted' |
   *  'message-sent' | 'payment-made' | 'form-submitted' | 'no-effect'. */
  effectClass: string;
  reason?: string;
}

/** One plan-level policy spec (discriminated on `type`). */
export type PlanSpec =
  | OrderingPlanSpec
  | RequiresHistoryPlanSpec
  | ProvenancePlanSpec
  | PostconditionPlanSpec;

/** The `planSpecs` block of a policy: an ordered list of plan specs. */
export type PlanSpecs = PlanSpec[];

function validRegex(pattern: unknown): pattern is string {
  if (typeof pattern !== 'string' || !pattern) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** Case-insensitive tool-name match, mirroring PolicyRule matching. An
 *  invalid pattern never matches (fail-closed), exactly like rules. */
export function matchPlanToolPattern(pattern: string, toolName: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(toolName);
  } catch {
    return false;
  }
}

/**
 * Validate one raw plan spec (from JSON config). Returns the typed spec
 * or null, pushing a human-readable problem onto `errors` — the policy
 * file loader's contract: malformed entries are skipped with collected
 * errors, never thrown, so a broken spec can never break a turn.
 */
export function parsePlanSpec(raw: unknown, index: number, errors: string[]): PlanSpec | null {
  if (typeof raw !== 'object' || raw === null) {
    errors.push(`planSpec ${index}: not an object — skipped`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id ? r.id : `plan-spec-${index}`;
  const reason = typeof r.reason === 'string' ? r.reason : undefined;
  const bad = (msg: string): null => {
    errors.push(`planSpec "${id}": ${msg} — skipped`);
    return null;
  };
  switch (r.type) {
    case 'ordering': {
      if (!validRegex(r.before) || !validRegex(r.after)) return bad('ordering needs valid "before" and "after" toolPatterns');
      if (r.relation !== 'must-precede' && r.relation !== 'must-not-precede') {
        return bad('ordering.relation must be "must-precede" or "must-not-precede"');
      }
      return { type: 'ordering', id, before: r.before, after: r.after, relation: r.relation, ...(reason ? { reason } : {}) };
    }
    case 'requires-history': {
      if (!validRegex(r.toolPattern)) return bad('requires-history needs a valid "toolPattern"');
      const req = r.requires as Record<string, unknown> | null;
      if (typeof req !== 'object' || req === null || !validRegex(req.toolPattern)) {
        return bad('requires-history needs "requires.toolPattern" (valid RegExp)');
      }
      if (req.argPattern !== undefined && !validRegex(req.argPattern)) {
        return bad('requires-history requires.argPattern is not a valid RegExp');
      }
      if (req.arg !== undefined && typeof req.arg !== 'string') return bad('requires-history requires.arg must be a string');
      return {
        type: 'requires-history',
        id,
        toolPattern: r.toolPattern,
        requires: {
          toolPattern: req.toolPattern,
          ...(typeof req.arg === 'string' ? { arg: req.arg } : {}),
          ...(typeof req.argPattern === 'string' ? { argPattern: req.argPattern } : {}),
          ...(typeof req.minCount === 'number' && req.minCount > 0 ? { minCount: Math.floor(req.minCount) } : {}),
        },
        ...(reason ? { reason } : {}),
      };
    }
    case 'provenance': {
      if (!validRegex(r.toolPattern) || !validRegex(r.sourceToolPattern)) {
        return bad('provenance needs valid "toolPattern" and "sourceToolPattern"');
      }
      if (typeof r.arg !== 'string' || !r.arg) return bad('provenance needs a non-empty "arg"');
      if (r.sourceArg !== undefined && typeof r.sourceArg !== 'string') return bad('provenance sourceArg must be a string');
      return {
        type: 'provenance',
        id,
        toolPattern: r.toolPattern,
        arg: r.arg,
        sourceToolPattern: r.sourceToolPattern,
        ...(typeof r.sourceArg === 'string' ? { sourceArg: r.sourceArg } : {}),
        ...(reason ? { reason } : {}),
      };
    }
    case 'postcondition': {
      if (!validRegex(r.toolPattern)) return bad('postcondition needs a valid "toolPattern"');
      if (typeof r.effectClass !== 'string' || !r.effectClass) return bad('postcondition needs a non-empty "effectClass"');
      return { type: 'postcondition', id, toolPattern: r.toolPattern, effectClass: r.effectClass, ...(reason ? { reason } : {}) };
    }
    default:
      return bad(`unknown type "${String(r.type)}" (want ordering|requires-history|provenance|postcondition)`);
  }
}

/** Validate a raw `planSpecs` array; malformed entries are skipped with errors. */
export function parsePlanSpecs(raw: unknown, errors: string[]): PlanSpecs {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push('planSpecs: must be an array — ignored');
    return [];
  }
  const out: PlanSpec[] = [];
  raw.forEach((entry, i) => {
    const spec = parsePlanSpec(entry, i, errors);
    if (spec) out.push(spec);
  });
  return out;
}
