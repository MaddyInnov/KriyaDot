// SPDX-License-Identifier: Apache-2.0
// Demo project: a tiny cart module with one deliberate bug (see README).

/**
 * Total a cart.
 * items: [{ price, qty, discountPct? }] — discountPct is a percentage
 * off the WHOLE line (price * qty), per the pricing spec.
 */
export function cartTotal(items) {
  let total = 0;
  for (const item of items) {
    const line = item.price * item.qty;
    if (item.discountPct) {
      total += line - (line * item.discountPct) / 100;
    } else {
      total += line;
    }
  }
  return Math.round(total * 100) / 100;
}
