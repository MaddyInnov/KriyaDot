// SPDX-License-Identifier: Apache-2.0
// Wave-4 browser suite (§4.11) — one register-style assembly.
//
// createBrowserSuite(deps) builds the whole block over shared stores
// and returns { router, …parts } so the host mounts ONE router at
// /api/browser (alongside the existing §1.4 browser-hold router) and
// keeps handles for the runner-side pieces (gate, takeover manager,
// captcha handler, question cards).
//
// HOST WIRING: see hidden_files/wave4-browser-WIRING.md.

import express, { type Router } from 'express';
import { defaultBrowserHoldRegistry, type BrowserHoldRegistry, type WidgetCoordinator } from '@mvp/agent-runtime';
import type { FileLinkService } from './file-links.js';
import { BrowserPermissionStore, registerBrowserPermissionRoutes, type BrowserHardDenyHook } from './browser-permissions.js';
import { BrowserTakeoverManager, registerBrowserTakeoverRoutes } from './browser-takeover.js';
import { BrowserFileGrantStore, registerBrowserFileGrantRoutes } from './browser-file-grants.js';
import { BrowserQuestionCards, registerBrowserQuestionRoutes } from './browser-question-cards.js';
import { BrowserArtifactStore, registerBrowserArtifactRoutes } from './browser-artifacts.js';
import { CheckoutWindowGuard, registerBrowserCheckoutRoutes } from './browser-checkout.js';
import { BrowserCaptchaHandler, registerBrowserCaptchaRoutes } from './browser-captcha.js';
import { BrowserActionGate } from './browser-action-gate.js';

export interface BrowserSuiteDeps {
  dataDir: string;
  /** Shared §1.4 hold registry (default: the process-wide one). */
  holds?: BrowserHoldRegistry;
  /** Governance hard-deny hook for BR-13 composition. */
  hardDeny?: BrowserHardDenyHook;
  /** Chat widget surface for BR-10 cards (the host's WidgetCoordinator). */
  widgets?: WidgetCoordinator;
  /** FL-7 service for BR-12 links (default: one over dataDir). */
  fileLinks?: FileLinkService;
  /** Workspace root for BR-7 confinement checks. */
  workspaceRoot?: string | (() => string);
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  /** Host config validated against the BR-8 no-solver rule. */
  config?: Record<string, unknown>;
}

export interface BrowserSuite {
  router: Router;
  permissions: BrowserPermissionStore;
  takeover: BrowserTakeoverManager;
  fileGrants: BrowserFileGrantStore;
  questions: BrowserQuestionCards;
  artifacts: BrowserArtifactStore;
  checkoutGuard: CheckoutWindowGuard;
  captcha: BrowserCaptchaHandler;
  gate: BrowserActionGate;
}

export function createBrowserSuite(deps: BrowserSuiteDeps): BrowserSuite {
  const audit = deps.audit;
  const holds = deps.holds ?? defaultBrowserHoldRegistry;

  const permissions = new BrowserPermissionStore(deps.dataDir, { hardDeny: deps.hardDeny });
  const takeover = new BrowserTakeoverManager({ registry: holds, audit });
  const fileGrants = new BrowserFileGrantStore(deps.dataDir);
  const questions = new BrowserQuestionCards({ widgets: deps.widgets, audit });
  const artifacts = new BrowserArtifactStore(deps.dataDir, { fileLinks: deps.fileLinks, audit });
  const checkoutGuard = new CheckoutWindowGuard({ audit });
  const captcha = new BrowserCaptchaHandler({ takeover, audit, config: deps.config });
  const gate = new BrowserActionGate({ permissions, holds, grants: fileGrants, checkoutGuard });

  const router = express.Router();
  registerBrowserPermissionRoutes(router, { store: permissions, audit });
  registerBrowserTakeoverRoutes(router, { manager: takeover });
  registerBrowserFileGrantRoutes(router, { store: fileGrants, workspaceRoot: deps.workspaceRoot, audit });
  registerBrowserQuestionRoutes(router, { cards: questions });
  registerBrowserArtifactRoutes(router, { store: artifacts });
  registerBrowserCheckoutRoutes(router, { guard: checkoutGuard });
  registerBrowserCaptchaRoutes(router, { handler: captcha });

  return { router, permissions, takeover, fileGrants, questions, artifacts, checkoutGuard, captcha, gate };
}
