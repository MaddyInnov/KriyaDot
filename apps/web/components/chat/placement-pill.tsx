// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Universal Chat composer placement pill (Front Door spec Part 5): a
 * per-message choice — "This device" / "In cloud" — for one-off tasks
 * ("run this in the cloud tonight") without moving the whole project.
 * It is NOT a global toggle: the parent owns the value per send.
 *
 * Visibility rule: rendered only in Universal mode; enabled only when
 * sync is configured. When sync isn't configured the pill is disabled
 * with the tooltip "Connect cloud to run tasks in your cloud".
 */

import React from 'react';
import type { TaskPlacement } from '../../lib/frontdoor';

export function PlacementPill({
  value,
  onChange,
  syncConfigured,
  disabled,
}: {
  value: TaskPlacement;
  onChange: (v: TaskPlacement) => void;
  /** When false the pill renders disabled (cloud not connected). */
  syncConfigured: boolean;
  disabled?: boolean;
}) {
  const isCloud = value === 'cloud';
  const off = disabled || !syncConfigured;
  return (
    <button
      type="button"
      className={`fusion-toggle placement-pill${isCloud ? ' on' : ''}`}
      data-placement={value}
      aria-pressed={isCloud}
      disabled={off}
      title={
        syncConfigured
          ? isCloud
            ? 'This message runs in your cloud — click to run on this device instead'
            : 'This message runs on this device — click to run it in your cloud'
          : 'Connect cloud to run tasks in your cloud'
      }
      onClick={() => onChange(isCloud ? 'local' : 'cloud')}
    >
      {isCloud ? '☁️ In cloud' : '💻 This device'}
    </button>
  );
}
