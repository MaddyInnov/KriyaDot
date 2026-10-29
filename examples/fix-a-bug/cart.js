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
      // BUG: the discount is computed on a single unit and then the
      // discounted unit price is multiplied — wait, that part is fine.
      // The real bug: for qty > 1 the discount is applied only ONCE
      // (to one unit) instead of to the whole line.
      const discountedUnit = item.price - (item.price * item.discountPct) / 100;
      total += discountedUnit + item.price * (item.qty - 1);
    } else {
      total += line;
    }
  }
  return Math.round(total * 100) / 100;
}
