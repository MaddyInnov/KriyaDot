// SPDX-License-Identifier: Apache-2.0
// Billing ledger: persistent invoices + line items in the billing SQLite
// database. Works alongside any BillingProvider implementation — the
// provider settles money, this ledger keeps the local books.

import { openDb } from './sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
type DatabaseSyncType = DatabaseSync;

import type { BillingInvoice, InvoiceLine, InvoiceStatus } from './provider.js';

export interface LedgerInvoice {
  id: string;
  customerId: string;
  status: InvoiceStatus;
  lines: InvoiceLine[];
  totalCents: number;
  createdAt: number;
  finalizedAt: number | null;
  paidAt: number | null;
  providerInvoiceId: string | null;
}

export class BillingLedger {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing_invoices (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        status TEXT NOT NULL,
        total_cents INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        finalized_at INTEGER,
        paid_at INTEGER,
        provider_invoice_id TEXT
      );
      CREATE TABLE IF NOT EXISTS billing_invoice_lines (
        invoice_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        description TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        quantity INTEGER,
        PRIMARY KEY (invoice_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_billing_invoices_customer ON billing_invoices (customer_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  recordInvoice(inv: BillingInvoice, providerInvoiceId: string | null = null): LedgerInvoice {
    this.db
      .prepare(
        `INSERT INTO billing_invoices
           (id, customer_id, status, total_cents, created_at, finalized_at, paid_at, provider_invoice_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        inv.id,
        inv.customerId,
        inv.status,
        inv.totalCents,
        inv.createdAt,
        inv.finalizedAt,
        inv.paidAt,
        providerInvoiceId,
      );
    const insertLine = this.db.prepare(
      `INSERT INTO billing_invoice_lines (invoice_id, seq, description, amount_cents, quantity)
       VALUES (?, ?, ?, ?, ?)`,
    );
    inv.lines.forEach((line, i) => {
      insertLine.run(inv.id, i, line.description, line.amountCents, line.quantity ?? null);
    });
    return this.getInvoice(inv.id) as LedgerInvoice;
  }

  updateStatus(id: string, status: InvoiceStatus, opts: { finalizedAt?: number; paidAt?: number } = {}): LedgerInvoice | undefined {
    const current = this.getInvoice(id);
    if (!current) return undefined;
    this.db
      .prepare(
        `UPDATE billing_invoices
         SET status = ?,
             finalized_at = COALESCE(?, finalized_at),
             paid_at = COALESCE(?, paid_at)
         WHERE id = ?`,
      )
      .run(status, opts.finalizedAt ?? null, opts.paidAt ?? null, id);
    return this.getInvoice(id);
  }

  getInvoice(id: string): LedgerInvoice | undefined {
    const row = this.db
      .prepare(`SELECT * FROM billing_invoices WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const lines = (
      this.db
        .prepare(`SELECT description, amount_cents, quantity FROM billing_invoice_lines WHERE invoice_id = ? ORDER BY seq`)
        .all(id) as Array<{ description: string; amount_cents: number; quantity: number | null }>
    ).map((l) => ({
      description: l.description,
      amountCents: l.amount_cents,
      ...(l.quantity === null ? {} : { quantity: l.quantity }),
    }));
    return {
      id: row.id as string,
      customerId: row.customer_id as string,
      status: row.status as InvoiceStatus,
      lines,
      totalCents: row.total_cents as number,
      createdAt: row.created_at as number,
      finalizedAt: (row.finalized_at as number | null) ?? null,
      paidAt: (row.paid_at as number | null) ?? null,
      providerInvoiceId: (row.provider_invoice_id as string | null) ?? null,
    };
  }

  listInvoices(opts: { customerId?: string; limit?: number } = {}): LedgerInvoice[] {
    const conds: string[] = [];
    const args: Array<string | number | null> = [];
    if (opts.customerId) {
      conds.push('customer_id = ?');
      args.push(opts.customerId);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(`SELECT id FROM billing_invoices ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, limit) as Array<{ id: string }>;
    return rows.map((r) => this.getInvoice(r.id) as LedgerInvoice);
  }

  /** Total billed (paid) cents for a customer. */
  customerPaidCents(customerId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(total_cents), 0) AS t FROM billing_invoices WHERE customer_id = ? AND status = 'paid'`)
      .get(customerId) as { t: number };
    return row.t;
  }
}
