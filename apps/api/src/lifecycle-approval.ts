// SPDX-License-Identifier: Apache-2.0
// Shared approval seam for the file-lifecycle features (FL-6 / FL-7).
//
// The governance gateway (packages/governance GovernanceGateway) is the real
// approval system: route modules that hold it mint approvals with
// requestApproval(toolName, args, ctx) and read decisions back with
// getApproval(id). This module adapts that exact seam for the lifecycle
// stores, following the injectable-interface pattern used by
// remote-screen.ts and purchases.ts:
//
// - When a governance gateway is injected, creating a gated object mints a
//   real approval and the object stays in `pending-approval` until the
//   gateway records an `approved` decision (checked via sync calls). A
//   denial marks the object denied. Nothing becomes public/active on a
//   pending or denied approval — fail closed.
// - When no gateway is injected (standalone store use, tests), the caller
//   must pass an explicit `confirmed: true` flag. That confirmation is
//   recorded on the object and in the audit log. Without either a gateway
//   or the explicit confirmation the operation is refused. This fallback is
//   deliberately weaker than a gateway approval and is surfaced as
//   mode: 'confirmed-flag' so hosts can tell the difference.
//
// Every gated creation is audit-logged: through the gateway's audit() when
// present, otherwise into the local append-only `lifecycle_audit` table in
// file-lifecycle.db (metadata only — never file bytes or link tokens).

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb as openSqliteDb } from '@mvp/agent-runtime';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal governance surface the lifecycle modules need. The real
 *  GovernanceGateway satisfies this structurally. */
export interface LifecycleGovernance {
  requestApproval(
    toolName: string,
    args: Record<string, unknown>,
    ctx: { sessionId: string; botId: string; actor: string },
  ): string;
  getApproval?(id: string): { status: string } | undefined;
  audit(
    action: string,
    fields: { actor?: string; sessionId?: string; toolName?: string; decision?: string; detail?: unknown },
  ): void;
}

export type ApprovalMode = 'governance' | 'confirmed-flag';

export interface ApprovalOutcome {
  mode: ApprovalMode;
  /** Gateway approval id when mode is 'governance'. */
  approvalId?: string;
  /** 'active' = approved now; 'pending' = waiting on the gateway decision. */
  status: 'active' | 'pending';
}

export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRequiredError';
    (this as Error & { code?: string }).code = 'APPROVAL_REQUIRED';
  }
}

export function isApprovalRequiredError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === 'APPROVAL_REQUIRED';
}

// ---------------------------------------------------------------------------
// Local audit fallback (append-only table in file-lifecycle.db)
// ---------------------------------------------------------------------------

const AUDIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS lifecycle_audit (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lifecycle_audit_created ON lifecycle_audit(created_at DESC);
`;

export interface LifecycleAuditEntry {
  id: string;
  action: string;
  actor: string;
  detail: unknown;
  createdAt: number;
}

export class LifecycleAuditLog {
  protected readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = openSqliteDb(join(dataDir, 'file-lifecycle.db'));
    this.db.exec(AUDIT_SCHEMA);
  }

  record(action: string, actor: string, detail: Record<string, unknown> = {}): LifecycleAuditEntry {
    const entry: LifecycleAuditEntry = {
      id: randomUUID(),
      action,
      actor: actor ?? '',
      detail,
      createdAt: Date.now(),
    };
    let detailJson = '';
    try {
      detailJson = JSON.stringify(detail);
    } catch {
      detailJson = '{"note":"[unserializable detail]"}';
    }
    this.db
      .prepare('INSERT INTO lifecycle_audit (id, action, actor, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(entry.id, entry.action, entry.actor, detailJson, entry.createdAt);
    return entry;
  }

  list(limit = 100): LifecycleAuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM lifecycle_audit ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as Array<{
      id: string;
      action: string;
      actor: string;
      detail: string;
      created_at: number;
    }>;
    return rows.map((r) => {
      let detail: unknown = null;
      try {
        detail = r.detail ? JSON.parse(r.detail) : null;
      } catch {
        detail = null;
      }
      return { id: r.id, action: r.action, actor: r.actor, detail, createdAt: r.created_at };
    });
  }
}

/** Audit through the gateway when present, else the local log. Never throws. */
export function auditLifecycle(
  governance: LifecycleGovernance | undefined,
  fallbackLog: LifecycleAuditLog | undefined,
  action: string,
  actor: string,
  detail: Record<string, unknown>,
): void {
  try {
    if (governance) {
      governance.audit(action, { actor, detail });
      return;
    }
  } catch {
    // fall through to the local log
  }
  try {
    fallbackLog?.record(action, actor, detail);
  } catch {
    // Audit must never break the operation it describes.
  }
}

/**
 * Begin a gated creation. With a gateway: mints a real approval and returns
 * status 'pending' (the object must not go live until syncFromGovernance
 * observes 'approved'). Without a gateway: requires `confirmed === true`,
 * else throws ApprovalRequiredError.
 */
export function beginApproval(opts: {
  governance?: LifecycleGovernance;
  toolName: string;
  args: Record<string, unknown>;
  actor: string;
  confirmed?: boolean;
  sessionId?: string;
  botId?: string;
}): ApprovalOutcome {
  if (opts.governance) {
    const approvalId = opts.governance.requestApproval(opts.toolName, opts.args, {
      sessionId: opts.sessionId ?? 'file-lifecycle',
      botId: opts.botId ?? 'api',
      actor: opts.actor || 'api',
    });
    return { mode: 'governance', approvalId, status: 'pending' };
  }
  if (opts.confirmed === true) {
    return { mode: 'confirmed-flag', status: 'active' };
  }
  throw new ApprovalRequiredError(
    `creating this item requires an approval: approve "${opts.toolName}" in the approvals inbox, ` +
      'or retry with { "confirmed": true } when no governance gateway is wired',
  );
}

/**
 * Resolve the live status of a governance-gated object.
 * Returns 'active' | 'pending' | 'denied'.
 */
export function syncApprovalStatus(
  governance: LifecycleGovernance | undefined,
  approvalId: string | undefined,
  current: 'active' | 'pending' | 'denied',
): 'active' | 'pending' | 'denied' {
  if (current !== 'pending') return current;
  if (!governance || !approvalId || !governance.getApproval) return 'pending';
  const rec = governance.getApproval(approvalId);
  if (!rec) return 'pending';
  if (rec.status === 'approved') return 'active';
  if (rec.status === 'denied' || rec.status === 'expired') return 'denied';
  return 'pending';
}
