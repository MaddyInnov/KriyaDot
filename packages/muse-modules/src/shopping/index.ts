// SPDX-License-Identifier: Apache-2.0
// Shopping (Muse parity): product search over a mock catalog plus an
// approval-gated purchase flow.
//
// TRUST GUARANTEE: checkout never completes silently. checkout() creates a
// `pending_approval` order and returns a mock approval code; the order only
// moves to `ordered` via approveOrder(orderId, code). Real checkout providers
// (Stripe etc.) plug in behind this two-phase seam — see
// docs/founder-setup.d/workstream-e.md. The catalog is a mock fixture; no
// live merchant calls are made.

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from '../errors.js';
import type { ModuleDb } from '../db.js';

// CN-7: cross-merchant catalog providers + aggregator (Meta Catalog
// adapter, env-gated; mock fixture as honest fallback) live in ./catalog.
export * from './catalog.js';

export interface Product {
  id: string;
  name: string;
  description: string;
  /** Price in minor units (cents). */
  priceCents: number;
  currency: string;
  imageUrl: string;
  /** Visual attributes a photo matcher can observe (M-3): category, material, color family, form. */
  visualTags?: string[];
}

/** Mock catalog fixture — deterministic, offline. */
export const MOCK_CATALOG: Product[] = [
  { id: 'prod-001', name: 'Aurora Desk Lamp', description: 'Dimmable LED desk lamp, warm-to-cool white.', priceCents: 4999, currency: 'USD', imageUrl: 'mock://products/prod-001.jpg', visualTags: ['lamp', 'lighting', 'metal', 'white', 'desk', 'modern'] },
  { id: 'prod-002', name: 'Nomad Backpack 25L', description: 'Water-resistant everyday carry backpack.', priceCents: 8999, currency: 'USD', imageUrl: 'mock://products/prod-002.jpg', visualTags: ['backpack', 'bag', 'fabric', 'black', 'travel', 'outdoor'] },
  { id: 'prod-003', name: 'Kiln Ceramic Mug', description: 'Hand-glazed 350ml stoneware mug.', priceCents: 2499, currency: 'USD', imageUrl: 'mock://products/prod-003.jpg', visualTags: ['mug', 'ceramic', 'cup', 'kitchen', 'white', 'round'] },
  { id: 'prod-004', name: 'Tempo Wireless Earbuds', description: 'ANC earbuds, 30h case battery.', priceCents: 12999, currency: 'USD', imageUrl: 'mock://products/prod-004.jpg', visualTags: ['earbuds', 'audio', 'plastic', 'white', 'small', 'tech'] },
  { id: 'prod-005', name: 'Field Notes Trio', description: 'Three pocket notebooks, dot grid.', priceCents: 1499, currency: 'USD', imageUrl: 'mock://products/prod-005.jpg', visualTags: ['notebook', 'paper', 'brown', 'flat', 'stationery'] },
  { id: 'prod-006', name: 'Ember Pour-Over Set', description: 'Glass dripper, carafe, and filters.', priceCents: 6499, currency: 'USD', imageUrl: 'mock://products/prod-006.jpg', visualTags: ['coffee', 'glass', 'carafe', 'kitchen', 'transparent', 'round'] },
  { id: 'prod-007', name: 'Drift Mechanical Keyboard', description: '75% hot-swap keyboard, tactile switches.', priceCents: 15999, currency: 'USD', imageUrl: 'mock://products/prod-007.jpg', visualTags: ['keyboard', 'tech', 'plastic', 'black', 'rectangular', 'desk'] },
  { id: 'prod-008', name: 'Solstice Throw Blanket', description: 'Woven cotton throw, 130×180cm.', priceCents: 5499, currency: 'USD', imageUrl: 'mock://products/prod-008.jpg', visualTags: ['blanket', 'fabric', 'textile', 'soft', 'home', 'folded'] },
];

/** Case-insensitive substring search over name + description. */
export function searchProducts(query: string): Product[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return [...MOCK_CATALOG];
  return MOCK_CATALOG.filter(
    (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
  );
}

export function getProduct(id: string): Product {
  const p = MOCK_CATALOG.find((x) => x.id === id);
  if (!p) throw new NotFoundError(`unknown product: ${id}`);
  return p;
}

export interface CartLine {
  productId: string;
  qty: number;
  product: Product;
  lineTotalCents: number;
}

export interface Cart {
  id: string;
  items: CartLine[];
  totalCents: number;
  currency: string;
  createdAt: number;
  updatedAt: number;
}

export type OrderStatus = 'pending_approval' | 'ordered' | 'cancelled';

export interface Order {
  id: string;
  items: CartLine[];
  totalCents: number;
  currency: string;
  status: OrderStatus;
  /**
   * Mock approval code shown to the human at checkout. NOT a secret — this is
   * a mock stand-in for the governance approval flow used in production.
   */
  approvalCode: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredCart {
  items: { productId: string; qty: number }[];
}

function hydrateCart(id: string, stored: StoredCart, createdAt: number, updatedAt: number): Cart {
  const items: CartLine[] = stored.items.map(({ productId, qty }) => {
    const product = getProduct(productId);
    return { productId, qty, product, lineTotalCents: product.priceCents * qty };
  });
  return {
    id,
    items,
    totalCents: items.reduce((s, l) => s + l.lineTotalCents, 0),
    currency: 'USD',
    createdAt,
    updatedAt,
  };
}

export class ShoppingStore {
  constructor(private readonly mdb: ModuleDb) {}

  createCart(): Cart {
    const id = randomUUID();
    const now = Date.now();
    this.mdb.db
      .prepare('INSERT INTO mm_carts (id, items_json, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, JSON.stringify({ items: [] } satisfies StoredCart), now, now);
    return this.getCart(id);
  }

  getCart(id: string): Cart {
    const row = this.mdb.db
      .prepare('SELECT id, items_json, created_at, updated_at FROM mm_carts WHERE id = ?')
      .get(id) as { id: string; items_json: string; created_at: number; updated_at: number } | undefined;
    if (!row) throw new NotFoundError(`unknown cart: ${id}`);
    return hydrateCart(row.id, JSON.parse(row.items_json) as StoredCart, row.created_at, row.updated_at);
  }

  addItem(cartId: string, productId: string, qty: number): Cart {
    getProduct(productId); // throws NotFoundError for unknown products
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      throw new ValidationError('cart "qty" must be an integer 1–99');
    }
    const cart = this.getCart(cartId);
    const items = cart.items.map((l) => ({ productId: l.productId, qty: l.qty }));
    const existing = items.find((i) => i.productId === productId);
    if (existing) existing.qty = Math.min(99, existing.qty + qty);
    else items.push({ productId, qty });
    const now = Date.now();
    this.mdb.db
      .prepare('UPDATE mm_carts SET items_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ items } satisfies StoredCart), now, cartId);
    return this.getCart(cartId);
  }

  /**
   * Begin the approval-gated purchase: freezes the cart into a
   * `pending_approval` order. The order completes ONLY via approveOrder().
   */
  checkout(cartId: string): Order {
    const cart = this.getCart(cartId);
    if (cart.items.length === 0) throw new ValidationError('cannot checkout an empty cart');
    const id = randomUUID();
    const now = Date.now();
    // Mock approval code — human-readable, NOT a secret; production uses the
    // governance approval flow instead (see workstream-e.md).
    const approvalCode = `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`;
    const lines = cart.items.map((l) => ({ productId: l.productId, qty: l.qty }));
    this.mdb.db
      .prepare(
        `INSERT INTO mm_orders (id, items_json, total_cents, currency, status, approval_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending_approval', ?, ?, ?)`,
      )
      .run(id, JSON.stringify(lines), cart.totalCents, cart.currency, approvalCode, now, now);
    return this.getOrder(id);
  }

  /** Approve a pending order with its checkout approval code → `ordered`. */
  approveOrder(orderId: string, code: string): Order {
    const order = this.getOrder(orderId);
    if (order.status !== 'pending_approval') {
      throw new ValidationError(`order is ${order.status}; only pending_approval orders can be approved`);
    }
    if (code !== order.approvalCode) {
      throw new ValidationError('incorrect approval code for this order');
    }
    const now = Date.now();
    this.mdb.db.prepare(`UPDATE mm_orders SET status = 'ordered', updated_at = ? WHERE id = ?`).run(now, orderId);
    return this.getOrder(orderId);
  }

  cancelOrder(orderId: string): Order {
    const order = this.getOrder(orderId);
    if (order.status === 'ordered') {
      throw new ValidationError('an ordered (mock-completed) order cannot be cancelled');
    }
    if (order.status === 'cancelled') return order;
    this.mdb.db
      .prepare(`UPDATE mm_orders SET status = 'cancelled', updated_at = ? WHERE id = ?`)
      .run(Date.now(), orderId);
    return this.getOrder(orderId);
  }

  getOrder(id: string): Order {
    const row = this.mdb.db
      .prepare(
        'SELECT id, items_json, total_cents, currency, status, approval_code, created_at, updated_at FROM mm_orders WHERE id = ?',
      )
      .get(id) as
      | {
          id: string;
          items_json: string;
          total_cents: number;
          currency: string;
          status: string;
          approval_code: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) throw new NotFoundError(`unknown order: ${id}`);
    const lines = JSON.parse(row.items_json) as { productId: string; qty: number }[];
    return {
      id: row.id,
      items: lines.map(({ productId, qty }) => {
        const product = getProduct(productId);
        return { productId, qty, product, lineTotalCents: product.priceCents * qty };
      }),
      totalCents: row.total_cents,
      currency: row.currency,
      status: row.status as OrderStatus,
      approvalCode: row.approval_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
