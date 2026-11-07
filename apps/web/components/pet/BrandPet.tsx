// SPDX-License-Identifier: Apache-2.0
// BrandPet — the topbar/sidebar brand slot. Thin wrapper kept so existing
// call sites (app-sidebar.tsx etc.) do not change: it renders BrandMark,
// i.e. ALWAYS the Hologram brand mark at 26px, never the user's chosen pet.

'use client';

import React from 'react';
import { BrandMark } from './BrandMark';

export function BrandPet() {
  return (
    <span className="brand-pet" aria-hidden="true">
      <BrandMark size={26} />
    </span>
  );
}
