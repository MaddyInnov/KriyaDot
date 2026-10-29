// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from './cart.js';

test('plain lines sum price * qty', () => {
  assert.equal(cartTotal([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25);
});

test('discount applies to the whole line', () => {
  // 3 × $50 with 10% off the whole line = $135, not $145.
  assert.equal(cartTotal([{ price: 50, qty: 3, discountPct: 10 }]), 135);
});

test('single discounted item', () => {
  assert.equal(cartTotal([{ price: 80, qty: 1, discountPct: 25 }]), 60);
});
