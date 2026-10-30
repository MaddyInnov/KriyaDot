// SPDX-License-Identifier: Apache-2.0
// Real-desktop computer use: first-run setup flow (closure ADD-5 items 1–2).
//
// The product surface over @mvp/agent-runtime's computer-setup model
// (packages/agent-runtime/src/tools/computer-setup.ts). One per-user state
// file (computer-use-setup[.user].json in the data dir, namespaced like
// the permissions-pane stores) records where the user is in the flow:
//
//   not-started → in-progress → self-test-failed ─┐
//                    ↑  └──────────────┘           │ self-test passes
//                    └──────── ready-to-enable ────┴→ enabled ⇄ disabled
//
// Routes (register-style; the host mounts the returned router under /api,
// so paths below are /api/computer-use-setup/...):
//   GET  /computer-use-setup            status + explainer + live OS checks + adapter selection
//   POST /computer-use-setup/begin      start (or restart) the flow
//   POST /computer-use-setup/self-test  run screenshot+move+click through the real adapter seam; record results
//   POST /computer-use-setup/enable     { confirm: true } — only after a passing self-test
//   POST /computer-use-setup/disable    turn real-desktop control back off
//
// Governance contract (never weakened): enabling setup ONLY selects the
// real adapter for the host composition (see createSetupAwareLocalLayer).
// It grants no allowance and no standing allow — every mutating computer
// action still goes through computerUsePolicyRules() → require-approval,
// and the permissions pane's reset does not silently re-enable anything
// (this store is separate; disabling here is the off switch).
//
// The self-test runs through the adapter seam: deps.createSelfTestLayer
// in tests; in production selectDesktopAdapter({ setupEnabled: true })
// — the real foreground layer (native bindings load lazily; a missing
// robotjs/screenshot-desktop install surfaces as a recorded self-test
// failure with the install error, never a crash).

import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router } from 'express';
import type { OSScreenLayer } from '@mvp/agent-runtime/dist/tools/computer.js';
import {
  COMPUTER_USE_EXPLAINER,
  detectPlatformChecks,
  runComputerUseSelfTest,
  selectDesktopAdapter,
  type ComputerUsePermissionCheck,
  type ComputerUseSelfTestResult,
  type PlatformCheckReport,
} from '@mvp/agent-runtime/dist/tools/computer-setup.js';
import type { ComputerVerificationRecord } from '@mvp/agent-runtime/dist/tools/computer-verify.js';
import { principalMiddleware, resolvePrincipal, type PrincipalContext } from './principal.js';

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

export type ComputerUseSetupStatus =
  | 'not-started'
  | 'in-progress'
  | 'self-test-failed'
  | 'ready-to-enable'
  | 'enabled'
  | 'disabled';

export interface ComputerUseSetupState {
  version: 1;
  status: ComputerUseSetupStatus;
  /** Platform report captured when the flow was begun (refreshed on read). */
  platform?: string;
  selfTest?: ComputerUseSelfTestResult;
  enabledAt?: number;
  updatedAt: number;
}

const SETUP_FILE = 'computer-use-setup';

function sanitizeNamespace(ns: string): string {
  return ns.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64) || 'user';
}

export function computerUseSetupPath(dataDir: string, userId: string): string {
  const suffix = userId === 'default-user' ? '' : `.${sanitizeNamespace(userId)}`;
  return path.join(dataDir, `${SETUP_FILE}${suffix}.json`);
}

export function readComputerUseSetup(dataDir: string, userId: string): ComputerUseSetupState {
  try {
    const parsed = JSON.parse(fs.readFileSync(computerUseSetupPath(dataDir, userId), 'utf8')) as Partial<ComputerUseSetupState>;
    if (parsed && typeof parsed === 'object' && typeof parsed.status === 'string') {
      return { version: 1, updatedAt: 0, ...parsed } as ComputerUseSetupState;
    }
  } catch {
    // Missing or corrupt → not started (never 500 on a settings read).
  }
  return { version: 1, status: 'not-started', updatedAt: 0 };
}

export function writeComputerUseSetup(dataDir: string, userId: string, state: ComputerUseSetupState): ComputerUseSetupState {
  const file = computerUseSetupPath(dataDir, userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return state;
}

/** The one question the host composition asks: is real-desktop control enabled for this user? */
export function isComputerUseEnabled(dataDir: string, userId: string): boolean {
  return readComputerUseSetup(dataDir, userId).status === 'enabled';
}

// ---------------------------------------------------------------------------
// Status view (shared by the routes and the permissions pane)
// ---------------------------------------------------------------------------

export interface ComputerUseSetupView {
  status: ComputerUseSetupStatus;
  enabled: boolean;
  explainer: typeof COMPUTER_USE_EXPLAINER;
  platform: PlatformCheckReport;
  selfTest?: ComputerUseSelfTestResult;
  enabledAt?: number;
  adapter: { kind: string; real: boolean; reason: string };
  /** Standing reminder rendered next to the state: setup ≠ permission. */
  approvalNote: string;
}

export function buildComputerUseSetupView(
  dataDir: string,
  userId: string,
  opts: { platform?: string; env?: NodeJS.ProcessEnv } = {},
): ComputerUseSetupView {
  const state = readComputerUseSetup(dataDir, userId);
  const platform = detectPlatformChecks({ platform: opts.platform, env: opts.env });
  const adapter = selectDesktopAdapter({ setupEnabled: state.status === 'enabled', env: opts.env });
  return {
    status: state.status,
    enabled: state.status === 'enabled',
    explainer: COMPUTER_USE_EXPLAINER,
    platform,
    ...(state.selfTest ? { selfTest: state.selfTest } : {}),
    ...(state.enabledAt ? { enabledAt: state.enabledAt } : {}),
    adapter: { kind: adapter.kind, real: adapter.real, reason: adapter.reason },
    approvalNote: COMPUTER_USE_EXPLAINER.approvalNote,
  };
}

/** Compact summary the permissions pane embeds in its overview. */
export interface ComputerUsePaneSummary {
  status: ComputerUseSetupStatus;
  enabled: boolean;
  platform: string;
  checks: ComputerUsePermissionCheck[];
  selfTestOk?: boolean;
  adapterKind: string;
}

export function computerUsePaneSummary(dataDir: string, userId: string): ComputerUsePaneSummary {
  const view = buildComputerUseSetupView(dataDir, userId);
  return {
    status: view.status,
    enabled: view.enabled,
    platform: view.platform.platform,
    checks: view.platform.checks,
    ...(view.selfTest ? { selfTestOk: view.selfTest.ok } : {}),
    adapterKind: view.adapter.kind,
  };
}

// ---------------------------------------------------------------------------
// Host composition seam (item 2: default-when-enabled wiring)
// ---------------------------------------------------------------------------

export interface SetupAwareLayerDeps {
  dataDir: string;
  /** The user whose setup state decides (the bot owner's id in the host). */
  userId: string;
  env?: NodeJS.ProcessEnv;
  /** Native backend injection for the real layer (the computer-real seam). */
  realDeps?: Parameters<typeof selectDesktopAdapter>[0]['realDeps'];
  /** Screenshot-verification records from the real layer (spans/attempts). */
  onVerification?: (record: ComputerVerificationRecord) => void;
}

/**
 * The layer the host's per-bot computer manager should use for the LOCAL
 * surface: the real (screenshot-verified) foreground adapter when setup
 * is enabled for the owner (or the legacy env opt-in applies), otherwise
 * the setup-required layer whose calls answer with the setup prompt
 * instead of silently using the mock. Re-evaluated on every call, so
 * enabling/disabling setup takes effect without a restart.
 */
export function createSetupAwareLocalLayer(deps: SetupAwareLayerDeps): OSScreenLayer {
  const pick = () =>
    selectDesktopAdapter({
      setupEnabled: isComputerUseEnabled(deps.dataDir, deps.userId),
      env: deps.env,
      realDeps: deps.realDeps,
      onVerification: deps.onVerification,
    }).layer;
  // A delegating proxy: the adapter choice is re-read per call so a
  // setup change mid-session applies to the very next action.
  return {
    displaySize: () => pick().displaySize(),
    screenshot: () => pick().screenshot(),
    click: (x, y, opts) => pick().click(x, y, opts),
    type: (text) => pick().type(text),
    key: (name) => pick().key(name),
    keyChord: (modifiers, key) => pick().keyChord(modifiers, key),
    scroll: (x, y, dx, dy) => pick().scroll(x, y, dx, dy),
    drag: (x1, y1, x2, y2, opts) => pick().drag(x1, y1, x2, y2, opts),
    move: (x, y) => pick().move(x, y),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface ComputerUseSetupDeps {
  dataDir: string;
  audit?: (action: string, fields: { actor?: string; toolName?: string; detail?: unknown }) => void;
  loopbackToken?: string;
  jwtSecret?: string;
  now?: () => number;
  /** Platform override (tests); defaults to process.platform. */
  platform?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * The adapter seam the self-test runs through. Default: the real
   * adapter (selectDesktopAdapter with setupEnabled: true). Tests inject
   * a MockOSScreenLayer (or a failing layer) here.
   */
  createSelfTestLayer?: () => OSScreenLayer;
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail ? { error, detail } : { error };
}

export function registerComputerUseSetupRoutes(router: Router, deps: ComputerUseSetupDeps): void {
  const pctx: PrincipalContext = { dataDir: deps.dataDir, loopbackToken: deps.loopbackToken, jwtSecret: deps.jwtSecret };
  const now = deps.now ?? Date.now;
  const view = (userId: string) => buildComputerUseSetupView(deps.dataDir, userId, { platform: deps.platform, env: deps.env });
  const audit = (req: Request, action: string, detail?: unknown) => {
    try {
      deps.audit?.(action, { actor: callerOf(req), toolName: 'computer-use-setup', detail });
    } catch {
      // Audit must never break a settings write.
    }
  };
  function callerOf(req: Request): string {
    const userId = resolvePrincipal(req, pctx)?.userId;
    if (!userId) throw new Error('unauthenticated');
    return userId;
  }

  const r = express.Router();
  r.use(principalMiddleware(pctx));

  r.get('/', (req: Request, res: Response) => {
    res.json({ ok: true, ...view(callerOf(req)) });
  });

  r.post('/begin', (req: Request, res: Response) => {
    const userId = callerOf(req);
    const current = readComputerUseSetup(deps.dataDir, userId);
    if (current.status === 'enabled') {
      res.json({ ok: true, ...view(userId) });
      return;
    }
    const platform = detectPlatformChecks({ platform: deps.platform, env: deps.env });
    writeComputerUseSetup(deps.dataDir, userId, {
      ...current,
      version: 1,
      status: 'in-progress',
      platform: platform.platform,
      updatedAt: now(),
    });
    audit(req, 'computer_use.setup_begin', { platform: platform.platform });
    res.json({ ok: true, ...view(userId) });
  });

  r.post('/self-test', async (req: Request, res: Response) => {
    const userId = callerOf(req);
    const current = readComputerUseSetup(deps.dataDir, userId);
    if (current.status === 'not-started') {
      res.status(400).json(errorBody('begin the setup flow first (POST /computer-use-setup/begin)'));
      return;
    }
    // The self-test always targets the REAL adapter seam — never the
    // setup-required layer and never the mock (tests inject the seam).
    const layer = deps.createSelfTestLayer
      ? deps.createSelfTestLayer()
      : selectDesktopAdapter({ setupEnabled: true, env: deps.env }).layer;
    const result = await runComputerUseSelfTest(layer, { now });
    const wasEnabled = current.status === 'enabled';
    writeComputerUseSetup(deps.dataDir, userId, {
      ...current,
      version: 1,
      status: wasEnabled ? 'enabled' : result.ok ? 'ready-to-enable' : 'self-test-failed',
      selfTest: result,
      updatedAt: now(),
    });
    audit(req, 'computer_use.self_test', { ok: result.ok, steps: result.steps.map((s) => ({ id: s.id, ok: s.ok })) });
    res.json({ ok: true, selfTest: result, ...view(userId) });
  });

  r.post('/enable', (req: Request, res: Response) => {
    const userId = callerOf(req);
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) {
      res.status(400).json(errorBody('enable requires { confirm: true }'));
      return;
    }
    const current = readComputerUseSetup(deps.dataDir, userId);
    if (!current.selfTest?.ok) {
      res.status(400).json(
        errorBody('the self-test has not passed yet — run it (and fix any OS permission it reports) before enabling'),
      );
      return;
    }
    writeComputerUseSetup(deps.dataDir, userId, {
      ...current,
      version: 1,
      status: 'enabled',
      enabledAt: now(),
      updatedAt: now(),
    });
    audit(req, 'computer_use.enabled', { selfTestAt: current.selfTest.at });
    res.json({ ok: true, ...view(userId) });
  });

  r.post('/disable', (req: Request, res: Response) => {
    const userId = callerOf(req);
    const current = readComputerUseSetup(deps.dataDir, userId);
    writeComputerUseSetup(deps.dataDir, userId, { ...current, version: 1, status: 'disabled', updatedAt: now() });
    audit(req, 'computer_use.disabled', {});
    res.json({ ok: true, ...view(userId) });
  });

  router.use('/computer-use-setup', r);
}
