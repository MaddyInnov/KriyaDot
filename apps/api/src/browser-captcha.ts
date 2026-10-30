// SPDX-License-Identifier: Apache-2.0
// BR-8 — CAPTCHA / bot-check handling (Muse parity audit §4.11,
// DECISION ROW — user-approved handling).
//
// The defensible shape, and the only shape built here:
//
//   - KriyaDot does NOT solve CAPTCHAs or bot checks, does NOT
//     integrate any third-party CAPTCHA-solving service, and does NOT
//     automate around a challenge (no fingerprint spoofing, no
//     challenge-token harvesting, no retry-until-it-passes loops).
//   - When a browser task meets a challenge on a site the user asked
//     it to use, the task PAUSES and control of that browser passes to
//     the user through the BR-9 takeover flow. The user completes the
//     challenge personally, in their own session, and hands the
//     browser back. That is lawful, ToS-clean assistance: the human
//     the challenge is addressed to is the human who answers it.
//   - The boundary is stated plainly in the UI copy below — the same
//     strings the API serves and the web UI renders, so there is one
//     canonical wording.
//
// Detection is host-supplied: the runner/driver reports challenge
// signals (a challenge iframe, "verify you are human" text, a 403
// bot-wall). This module classifies those signals and drives the
// takeover escalation; it never interacts with the challenge itself.
// Configuration that names a solver service is REFUSED at startup
// (assertNoSolverConfig) so the boundary cannot be configured away.

import express, { type Router } from 'express';
import { BrowserTakeoverManager, type TakeoverSession } from './browser-takeover.js';

/** Canonical boundary copy — rendered verbatim by the web UI. */
export const CAPTCHA_BOUNDARY_COPY = {
  title: 'A check needs you, not the bot',
  body:
    'This site is asking to verify that a human is present. KriyaDot will not solve CAPTCHAs or bot checks, ' +
    'and it does not use any CAPTCHA-solving service. Instead, the browser pauses and hands control to you: ' +
    'complete the check yourself, then hand the browser back and the task continues.',
  takeoverButton: 'Take over the browser',
  handbackButton: 'Done — hand the browser back',
  footnote: 'If a site forbids automated browsing altogether, the task stops there rather than working around the check.',
} as const;

export type CaptchaChallengeKind = 'captcha' | 'bot-wall' | 'human-verification' | 'unknown';

/** Signals a runner/driver may report from a page. Detection only. */
export interface CaptchaChallengeSignal {
  kind: CaptchaChallengeKind;
  /** Where the challenge was seen. */
  url?: string;
  /** Short human description from the driver ("reCAPTCHA iframe present"). */
  detail?: string;
}

const CHALLENGE_TEXT_PATTERNS: readonly RegExp[] = [
  /verify (that )?you are (a )?human/i,
  /are you a robot/i,
  /complete the captcha/i,
  /solve the captcha/i,
  /checking your browser/i,
  /bot detection/i,
  /unusual traffic/i,
];

const CHALLENGE_SELECTOR_PATTERNS: readonly string[] = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]',
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  '#challenge-form',
];

/**
 * Classify host-observed page evidence as a challenge signal.
 * Pure + deterministic; returns undefined when nothing matches.
 * This DETECTS challenges so the task can pause for the user — it is
 * never used to interact with one.
 */
export function detectChallengeSignal(evidence: {
  url?: string;
  pageText?: string;
  selectorsPresent?: string[];
  httpStatus?: number;
}): CaptchaChallengeSignal | undefined {
  const selectors = evidence.selectorsPresent ?? [];
  for (const sel of selectors) {
    if (CHALLENGE_SELECTOR_PATTERNS.includes(sel)) {
      return { kind: 'captcha', url: evidence.url, detail: `challenge element present: ${sel}` };
    }
  }
  const text = evidence.pageText ?? '';
  for (const pattern of CHALLENGE_TEXT_PATTERNS) {
    if (pattern.test(text)) {
      const kind: CaptchaChallengeKind = /captcha/i.test(text) ? 'captcha' : 'human-verification';
      return { kind, url: evidence.url, detail: `page text matches ${pattern.source}` };
    }
  }
  if (evidence.httpStatus === 403 && /bot|challenge|verify/i.test(text)) {
    return { kind: 'bot-wall', url: evidence.url, detail: 'HTTP 403 bot wall' };
  }
  return undefined;
}

/** Config keys that would wire a solver service. Their presence is a hard error. */
const SOLVER_CONFIG_KEYS: readonly string[] = [
  'captchaSolver',
  'captcha_solver',
  'captchaSolverApiKey',
  'captchaSolverEndpoint',
  'twoCaptchaApiKey',
  'twocaptcha',
  'rucaptcha',
  'capSolverApiKey',
  'capsolver',
  'antiCaptchaApiKey',
  'anticaptcha',
  'nextCaptchaApiKey',
  'solveCaptcha',
];

/**
 * Startup guard: refuse configuration that names a CAPTCHA-solving
 * service. The BR-8 boundary is not configurable away.
 */
export function assertNoSolverConfig(config: Record<string, unknown> | undefined | null): void {
  if (!config) return;
  for (const key of Object.keys(config)) {
    if (SOLVER_CONFIG_KEYS.some((bad) => bad.toLowerCase() === key.toLowerCase())) {
      throw new Error(
        `configuration key "${key}" names a CAPTCHA-solving service — KriyaDot does not integrate solver services (BR-8); challenges are handled by user takeover`,
      );
    }
  }
  for (const key of ['CAPTCHA_SOLVER_API_KEY', 'TWOCAPTCHA_API_KEY', 'CAPSOLVER_API_KEY', 'ANTI_CAPTCHA_API_KEY']) {
    if (typeof config[key] === 'string' && (config[key] as string).length > 0) {
      throw new Error(
        `configuration key "${key}" names a CAPTCHA-solving service — KriyaDot does not integrate solver services (BR-8); challenges are handled by user takeover`,
      );
    }
  }
}

export interface CaptchaEscalation {
  /** Always 'user-takeover' — the only handling that exists. */
  action: 'user-takeover';
  signal: CaptchaChallengeSignal;
  /** The BR-9 session that now owns the flow (state: user-control). */
  takeover: TakeoverSession;
  copy: typeof CAPTCHA_BOUNDARY_COPY;
}

export class BrowserCaptchaHandler {
  private readonly takeover: BrowserTakeoverManager;
  private readonly audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;

  constructor(deps: {
    takeover: BrowserTakeoverManager;
    audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
    /** Host config to validate against the no-solver rule at construction. */
    config?: Record<string, unknown>;
  }) {
    assertNoSolverConfig(deps.config);
    this.takeover = deps.takeover;
    this.audit = deps.audit;
  }

  /** The policy, as served to the UI. Solver integrations: none, ever. */
  policy(): {
    mode: 'user-takeover';
    solverIntegrations: string[];
    automatedSolving: false;
    copy: typeof CAPTCHA_BOUNDARY_COPY;
  } {
    return { mode: 'user-takeover', solverIntegrations: [], automatedSolving: false, copy: CAPTCHA_BOUNDARY_COPY };
  }

  /**
   * A challenge was detected on a profile's page: pause the task and
   * hand the browser to the user via BR-9 (request + begin, so bot
   * actions block immediately). The user completes the challenge
   * personally and hands back through the normal BR-9 flow.
   */
  handleChallenge(input: {
    profileId: string;
    personId: string;
    personName?: string;
    signal: CaptchaChallengeSignal;
  }): CaptchaEscalation {
    const session = this.takeover.takeOverNow({
      profileId: input.profileId,
      personId: input.personId,
      personName: input.personName,
      reason: `CAPTCHA / bot check (${input.signal.kind})${input.signal.url ? ` at ${input.signal.url}` : ''} — user completes it personally`,
    });
    this.audit?.('browser.captcha_takeover', {
      actor: input.personId,
      detail: {
        profileId: input.profileId,
        signal: input.signal,
        takeoverSessionId: session.id,
        handling: 'user-takeover',
      },
    });
    return { action: 'user-takeover', signal: input.signal, takeover: session, copy: CAPTCHA_BOUNDARY_COPY };
  }
}

// ---------------------------------------------------------------------------
// Routes — mount under /api/browser (paths are /captcha…)
// ---------------------------------------------------------------------------

export function registerBrowserCaptchaRoutes(router: Router, deps: { handler: BrowserCaptchaHandler }): void {
  const { handler } = deps;

  router.get('/captcha/policy', (_req, res) => {
    res.json({ ok: true, ...handler.policy() });
  });

  router.post('/captcha/challenge', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const signalIn = (body.signal ?? {}) as Record<string, unknown>;
    if (typeof body.profileId !== 'string' || !body.profileId) {
      res.status(400).json({ error: 'profileId is required' });
      return;
    }
    if (typeof body.personId !== 'string' || !body.personId) {
      res.status(400).json({ error: 'personId is required (the person who will complete the check)' });
      return;
    }
    const kind = (['captcha', 'bot-wall', 'human-verification', 'unknown'] as const).includes(
      signalIn.kind as CaptchaChallengeKind,
    )
      ? (signalIn.kind as CaptchaChallengeKind)
      : 'unknown';
    try {
      const escalation = handler.handleChallenge({
        profileId: body.profileId,
        personId: body.personId,
        personName: typeof body.personName === 'string' ? body.personName : undefined,
        signal: {
          kind,
          url: typeof signalIn.url === 'string' ? signalIn.url : undefined,
          detail: typeof signalIn.detail === 'string' ? signalIn.detail : undefined,
        },
      });
      res.status(201).json({ ok: true, escalation });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Detection helper for runners: classify page evidence → signal or null. */
  router.post('/captcha/detect', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const signal = detectChallengeSignal({
      url: typeof body.url === 'string' ? body.url : undefined,
      pageText: typeof body.pageText === 'string' ? body.pageText : undefined,
      selectorsPresent: Array.isArray(body.selectorsPresent) ? body.selectorsPresent.map(String) : undefined,
      httpStatus: typeof body.httpStatus === 'number' ? body.httpStatus : undefined,
    });
    res.json({ ok: true, signal: signal ?? null, handling: signal ? 'user-takeover' : null });
  });
}

export function createBrowserCaptchaRouter(deps: { handler: BrowserCaptchaHandler }): Router {
  const router = express.Router();
  registerBrowserCaptchaRoutes(router, deps);
  return router;
}
