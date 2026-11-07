// SPDX-License-Identifier: Apache-2.0
// <Pet> — renders a companion pet with a mood-driven animation.
// - Image pets (kriyadot / voxel / droplet, see IMAGE_PETS in lib/pet.ts)
//   render a portrait <img> at EVERY size and variant — never SVG, never
//   the 3D canvas. Mood is expressed through CSS glow/filter treatments on
//   the image wrapper (pet.css, .pet-image / .pet-mood-*), never by faking
//   a mouth; celebrating reuses the shared container choreography.
// - The other five pets render 2D SVG (art.tsx) by default: SSR-safe, tiny
//   sizes, classic mode — or interactive 3D (Pet3D.tsx, WebGL/WebGPU) when
//   variant="3d" or variant="auto" with 3D enabled and size >= 64.
//   Lazy-loaded, never in the initial bundle.
// Props: pet (style id), size (px), mood. No JS animation libraries for 2D.

'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { imagePetDef, petDef, type PetId, type PetMood } from '../../lib/pet';
import { PET_ART } from './art';
import { is3DEnabled } from '../three/ClayScene';

const LazyPet3D = dynamic(() => import('./Pet3D').then((m) => m.Pet3D), { ssr: false });

/** At/above this size an image pet uses its full-size (800px) portrait. */
export const IMAGE_PET_FULL_SRC_MIN_SIZE = 96;

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
   * Ignored for image pets, which always render their portrait image.
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

  // Image pets: portrait <img> at all sizes/variants (hero, avatars,
  // picker, overlay, work panel all flow through this one branch).
  const image = imagePetDef(pet);
  if (image) {
    const src = size >= IMAGE_PET_FULL_SRC_MIN_SIZE ? image.src : image.srcSmall;
    return (
      <span
        className={`pet pet-image pet-frame-${image.frame} pet-mood-${mood}${className ? ` ${className}` : ''}`}
        data-mood={mood}
        data-pet={pet}
        style={{ width: size, height: size }}
        role="img"
        aria-label={ariaLabel}
        onDoubleClick={onDoubleClick}
      >
        <span className="pet-inner">
          {/* eslint-disable-next-line @next/next/no-img-element -- local brand asset, fixed square sizes */}
          <img
            className="pet-image-img"
            src={src}
            width={size}
            height={size}
            alt=""
            draggable={false}
          />
        </span>
      </span>
    );
  }

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
  if (!Art) return null; // unreachable: every non-image pet has SVG art
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
