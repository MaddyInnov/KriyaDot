// SPDX-License-Identifier: Apache-2.0
// BrandMark — the KriyaDot product mark: ALWAYS the Hologram portrait,
// regardless of which companion pet the user has chosen. The brand is the
// product mark, not the user's companion, so this component never reads
// the stored pet choice.

import React from 'react';
import { BRAND_MARK_SRC } from '../../lib/pet';

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- local brand asset, fixed square size
    <img
      className="brand-mark-img"
      src={BRAND_MARK_SRC}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
