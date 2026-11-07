// SPDX-License-Identifier: Apache-2.0
// <Hologram> — the flagship KriyaDot companion pet (pet id 'kriyadot').
//
// Two presentations, chosen exactly like the drawn pets choose SVG vs 3D:
// - Interactive 3D (Hologram3D.tsx, lazy-loaded via next/dynamic, ssr:false)
//   when variant="3d", or variant="auto" with 3D enabled and size >= 64.
// - Layered 2D (default): NOT a bare portrait <img>. The portrait sits in a
//   clipped circular disc (.holo-disc) wrapped in pure DOM/CSS hologram
//   layers — an orbiting gold particle field, a rotating arc ring, a
//   scanline sheen, speaking EQ arcs and sleeping motes. All motion is CSS
//   keyframes driven by the shared .pet-mood-* classes (pet.css); there is
//   no JS animation loop and no canvas in 2D.
//
// Props mirror PetProps minus `pet` (the hologram is always kriyadot).
// Pet.tsx routes pet === 'kriyadot' here; voxel / droplet keep the plain
// portrait branch in Pet.tsx.

'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { IMAGE_PETS, petDef, type PetMood } from '../../lib/pet';
import { is3DEnabled } from '../three/ClayScene';

const LazyHologram3D = dynamic(() => import('./Hologram3D').then((m) => m.Hologram3D), {
  ssr: false,
});

/**
 * At/above this size the hologram uses its full-size (800px) portrait.
 * Mirrors IMAGE_PET_FULL_SRC_MIN_SIZE (96) in Pet.tsx — kept as a local
 * constant so Hologram does not import Pet (Pet imports Hologram).
 */
const HOLO_FULL_SRC_MIN_SIZE = 96;

export interface HologramProps {
  size?: number;
  mood?: PetMood;
  className?: string;
  /** Accessible label; defaults to the pet's name. */
  label?: string;
  /**
   * Rendering variant: '2d' forces the layered 2D hologram, '3d' forces
   * the interactive 3D hologram, 'auto' (default) picks 3D when 3D is
   * enabled and the size is large enough to be worth a canvas (>= 64px).
   */
  variant?: 'auto' | '2d' | '3d';
  /** Disable pointer interactivity on the 3D hologram. */
  interactive?: boolean;
  /** Double-click handler, forwarded to the rendered wrapper (2D span or 3D). */
  onDoubleClick?: React.MouseEventHandler<HTMLElement>;
}

interface HoloParticle {
  /** Index — spreads the static (reduced-motion) dots around the rim. */
  i: number;
  /** Negative animation delay — desynchronises the orbit phase. */
  d: string;
  /** Dot size (px). */
  s: string;
  /** Orbit duration for this particle (per-particle variance). */
  dur: string;
}

/**
 * Gold dust orbiting the disc. Deterministic (no Math.random) so SSR and
 * hydration agree; each dot is a full-size rotating layer whose visible
 * dot (CSS ::before) rides the rim — see .holo-p in pet.css.
 */
const HOLO_PARTICLES: HoloParticle[] = [
  { i: 0, d: '0s', s: '4px', dur: '9s' },
  { i: 1, d: '-0.9s', s: '3px', dur: '8.2s' },
  { i: 2, d: '-1.7s', s: '5px', dur: '10.4s' },
  { i: 3, d: '-2.6s', s: '3px', dur: '7.8s' },
  { i: 4, d: '-3.4s', s: '4px', dur: '9.6s' },
  { i: 5, d: '-4.3s', s: '6px', dur: '11.2s' },
  { i: 6, d: '-5.1s', s: '3px', dur: '8.8s' },
  { i: 7, d: '-6s', s: '4px', dur: '10s' },
  { i: 8, d: '-6.8s', s: '5px', dur: '8.4s' },
  { i: 9, d: '-7.7s', s: '3px', dur: '9.2s' },
  { i: 10, d: '-8.5s', s: '4px', dur: '10.8s' },
  { i: 11, d: '-9.4s', s: '3px', dur: '7.6s' },
];

export function Hologram({
  size = 48,
  mood = 'idle',
  className = '',
  label,
  variant = 'auto',
  interactive = true,
  onDoubleClick,
}: HologramProps) {
  const ariaLabel = label ?? `${petDef('kriyadot').name} the companion pet (${mood})`;

  const use3D = variant === '3d' || (variant === 'auto' && size >= 64 && is3DEnabled());

  if (use3D) {
    return (
      <LazyHologram3D
        size={size}
        mood={mood}
        className={className}
        label={ariaLabel}
        interactive={interactive}
        onDoubleClick={onDoubleClick}
      />
    );
  }

  const def = IMAGE_PETS.kriyadot!;
  const src = size >= HOLO_FULL_SRC_MIN_SIZE ? def.src : def.srcSmall;

  return (
    <span
      className={`pet pet-hologram pet-frame-circle pet-mood-${mood}${className ? ` ${className}` : ''}`}
      data-mood={mood}
      data-pet="kriyadot"
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaLabel}
      onDoubleClick={onDoubleClick}
    >
      <span className="pet-inner holo-inner">
        <span className="holo-disc">
          {/* eslint-disable-next-line @next/next/no-img-element -- local brand asset, fixed square sizes */}
          <img
            className="pet-image-img holo-img"
            src={src}
            width={size}
            height={size}
            alt=""
            draggable={false}
          />
        </span>
        <span className="holo-ring" aria-hidden="true" />
        <span className="holo-particles" aria-hidden="true">
          {HOLO_PARTICLES.map((p) => (
            <i
              key={p.i}
              className="holo-p"
              style={
                {
                  '--i': String(p.i),
                  '--d': p.d,
                  '--s': p.s,
                  '--dur': p.dur,
                } as React.CSSProperties
              }
            />
          ))}
        </span>
        <span className="holo-sheen" aria-hidden="true" />
        <span className="holo-eq" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="holo-motes" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </span>
    </span>
  );
}
