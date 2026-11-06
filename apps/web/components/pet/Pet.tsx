// SPDX-License-Identifier: Apache-2.0
// <Pet> — renders a companion pet with a mood-driven animation.
// - 2D SVG (art.tsx) by default: SSR-safe, tiny sizes, classic mode.
// - Interactive 3D (Pet3D.tsx, WebGL/WebGPU) when variant="3d" or variant="auto"
//   with 3D enabled and size >= 64. Lazy-loaded, never in the initial bundle.
// Props: pet (style id), size (px), mood. No JS animation libraries for 2D.

'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { petDef, type PetId, type PetMood } from '../../lib/pet';
import { PET_ART } from './art';
import { is3DEnabled } from '../three/ClayScene';

const LazyPet3D = dynamic(() => import('./Pet3D').then((m) => m.Pet3D), { ssr: false });

export interface PetProps {
  pet: PetId;
  size?: number;
  mood?: PetMood;
  className?: string;
  /** Accessible label; defaults to the pet's name. */
  label?: string;
  /**
   * Rendering variant: '2d' forces the classic SVG, '3d' forces the
   * interactive 3D pet, 'auto' (default) picks 3D when 3D is enabled and
   * the size is large enough to be worth a canvas (>= 64px).
   */
  variant?: 'auto' | '2d' | '3d';
  /** Disable pointer interactivity on the 3D pet. */
  interactive?: boolean;
  /** Double-click handler, forwarded to the rendered wrapper (2D span or 3D). */
  onDoubleClick?: React.MouseEventHandler<HTMLElement>;
}

export function Pet({
  pet,
  size = 48,
  mood = 'idle',
  className = '',
  label,
  variant = 'auto',
  interactive = true,
  onDoubleClick,
}: PetProps) {
  const name = petDef(pet).name;
  const ariaLabel = label ?? `${name} the companion pet (${mood})`;
  const use3D = variant === '3d' || (variant === 'auto' && size >= 64 && is3DEnabled());

  if (use3D) {
    return (
      <LazyPet3D
        pet={pet}
        mood={mood}
        size={size}
        className={className}
        label={ariaLabel}
        interactive={interactive}
        onDoubleClick={onDoubleClick}
      />
    );
  }

  const Art = PET_ART[pet];
  return (
    <span
      className={`pet pet-mood-${mood}${className ? ` ${className}` : ''}`}
      data-mood={mood}
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaLabel}
      onDoubleClick={onDoubleClick}
    >
      <span className="pet-inner">
        <svg className="pet-svg" viewBox="0 0 120 120" width={size} height={size} aria-hidden="true">
          <Art mood={mood} />
        </svg>
      </span>
    </span>
  );
}
