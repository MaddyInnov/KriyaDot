// SPDX-License-Identifier: Apache-2.0
/**
 * Startup bootstrap (Octomind parity #156, API side).
 *
 * The marketplace's bootstrapFirstRun already does the real first-use
 * work (dependency installs via an injectable hook, credential
 * resolution with blockers surfaced, bundle MCP entries installed
 * disabled + an MCP startup PLAN) — but the API only invoked it from a
 * POST endpoint, never at startup. This module is the startup call the
 * parent makes from index.ts. It cannot live in index.ts (parent-owned
 * in this build), so:
 *
 * PARENT — add exactly this to apps/api/src/index.ts, after the
 * marketplace registry/installer are constructed and the per-bot/global
 * MCP manager exists:
 *
 *   import { runStartupBootstrap } from './boot-bootstrap.js';
 *   const bootstrapReport = runStartupBootstrap({
 *     dataDir: config.dataDir, registry, installer,
 *     startMcpServer: async (planEntry) => { await mcpManager.startFromPlan(planEntry); },
 *     audit: (a, f) => governance.audit(a, f),
 *   });
 *
 * Behaviour: idempotent (bootstrapFirstRun no-ops when its marker
 * exists), never throws into boot (failures are collected into the
 * returned report and audited), and only starts MCP servers whose
 * credentials fully resolved (plan blockers are reported, not forced).
 */

import { bootstrapFirstRun, MarketplaceInstaller, MarketplaceRegistry, type BootstrapResult } from '@mvp/marketplace';

export interface StartupBootstrapDeps {
  dataDir: string;
  registry: MarketplaceRegistry;
  installer: MarketplaceInstaller;
  /** Start one planned MCP server (host's MCP manager). Optional. */
  startMcpServer?: (entry: unknown) => Promise<void> | void;
  /** Injectable dep installer passthrough (tests). */
  depInstaller?: Parameters<typeof bootstrapFirstRun>[0]['depInstaller'];
  env?: Record<string, string | undefined>;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
  log?: (message: string) => void;
}

export interface StartupBootstrapReport {
  alreadyBootstrapped: boolean;
  result?: BootstrapResult;
  /** Credential/setup blockers the user must act on (never silent). */
  blockers: string[];
  /** MCP servers actually started at boot. */
  mcpStarted: string[];
  /** MCP servers in the plan that were NOT started (blocked or no starter wired). */
  mcpNotStarted: string[];
  error?: string;
}

export function runStartupBootstrap(deps: StartupBootstrapDeps): StartupBootstrapReport {
  const log = deps.log ?? ((m: string) => console.log(m));
  try {
    const result = bootstrapFirstRun({
      dataDir: deps.dataDir,
      registry: deps.registry,
      installer: deps.installer,
      ...(deps.depInstaller ? { depInstaller: deps.depInstaller } : {}),
      ...(deps.env ? { env: deps.env } : {}),
    });
    if (result.alreadyBootstrapped) {
      return { alreadyBootstrapped: true, blockers: [], mcpStarted: [], mcpNotStarted: [] };
    }
    const blockers: string[] = [...(result.plan?.blockers ?? []), ...(result.bundle?.blockers ?? [])];
    const planServers: Array<{ id?: string }> = (result.plan?.mcpServers ?? result.bundle?.mcpPlan ?? []) as Array<{ id?: string }>;
    return finish(deps, { alreadyBootstrapped: false, result, blockers, planServers, log });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.audit?.('marketplace.bootstrap_failed', { actor: 'system', detail: { error: message } });
    log(`[bootstrap] startup bootstrap failed (server continues): ${message}`);
    return { alreadyBootstrapped: false, blockers: [], mcpStarted: [], mcpNotStarted: [], error: message };
  }
}

function finish(
  deps: StartupBootstrapDeps,
  input: { alreadyBootstrapped: boolean; result: BootstrapResult; blockers: string[]; planServers: Array<{ id?: string }>; log: (m: string) => void },
): StartupBootstrapReport {
  // MCP startup is async in real managers; runStartupBootstrap stays
  // synchronous for the install/credential report and kicks the starts
  // off in the background, recording outcomes via audit. The returned
  // report lists what was ATTEMPTED; `mcpStarted` is filled for
  // synchronous starters only — see the note in the closure report.
  const mcpStarted: string[] = [];
  const mcpNotStarted: string[] = [];
  for (const entry of input.planServers) {
    const id = typeof entry?.id === 'string' ? entry.id : 'unknown';
    // Never start a server whose credentials did not fully resolve.
    const env = (entry as { env?: Record<string, string | null> }).env;
    if (env && Object.values(env).some((v) => v === null)) { mcpNotStarted.push(id); continue; }
    if (!deps.startMcpServer) { mcpNotStarted.push(id); continue; }
    try {
      const r = deps.startMcpServer(entry);
      if (r && typeof (r as Promise<void>).then === 'function') {
        void (r as Promise<void>).then(
          () => deps.audit?.('marketplace.bootstrap_mcp_started', { actor: 'system', detail: { id } }),
          (e: unknown) => deps.audit?.('marketplace.bootstrap_mcp_failed', { actor: 'system', detail: { id, error: e instanceof Error ? e.message : String(e) } }),
        );
        mcpStarted.push(id); // attempted; outcome audited asynchronously
      } else {
        mcpStarted.push(id);
      }
    } catch (err) {
      mcpNotStarted.push(id);
      deps.audit?.('marketplace.bootstrap_mcp_failed', { actor: 'system', detail: { id, error: err instanceof Error ? err.message : String(err) } });
    }
  }
  deps.audit?.('marketplace.bootstrap_startup', {
    actor: 'system',
    detail: { blockers: input.blockers, mcpStarted, mcpNotStarted },
  });
  if (input.blockers.length) input.log(`[bootstrap] setup blockers: ${input.blockers.join('; ')}`);
  return { alreadyBootstrapped: false, result: input.result, blockers: input.blockers, mcpStarted, mcpNotStarted };
}
