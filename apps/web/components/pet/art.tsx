// SPDX-License-Identifier: Apache-2.0
// Hand-drawn inline SVG art for the 6 companion pets. No image assets.
// Every pet renders in a 120x120 viewBox and accepts a `mood` that changes
// its face; mood *motion* is handled by CSS classes in pet.css.

import React, { useId } from 'react';
import type { PetId, PetMood } from '../../lib/pet';

export interface ArtProps {
  mood: PetMood;
}

/** Unique gradient id prefix per mounted instance (same pet can appear twice on a page). */
function useGid(prefix: string): string {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  return `${prefix}-${uid}`;
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

/** Mood-reactive face. Eyes at (x±11s, y); mouth around y+11s. */
function Face({
  mood,
  x,
  y,
  s = 1,
  ink = '#232838',
}: {
  mood: PetMood;
  x: number;
  y: number;
  s?: number;
  ink?: string;
}) {
  const sw = 2.4 * s;
  return (
    <g transform={`translate(${x},${y}) scale(${s})`} strokeLinecap="round">
      {mood === 'happy' ? (
        <>
          <path d="M-17,-1 Q-11,-8 -5,-1" fill="none" stroke={ink} strokeWidth={sw} />
          <path d="M5,-1 Q11,-8 17,-1" fill="none" stroke={ink} strokeWidth={sw} />
          <ellipse cx="0" cy="12" rx="7" ry="5.4" fill={ink} />
        </>
      ) : mood === 'error' ? (
        <>
          <path d="M-15,-4 L-8,3 M-8,-4 L-15,3" stroke={ink} strokeWidth={sw} fill="none" />
          <path d="M8,-4 L15,3 M15,-4 L8,3" stroke={ink} strokeWidth={sw} fill="none" />
          <circle cx="0" cy="12" r="3.6" fill="none" stroke={ink} strokeWidth={sw} />
        </>
      ) : mood === 'sleeping' ? (
        <>
          <path d="M-16,-1 Q-11,4 -6,-1" fill="none" stroke={ink} strokeWidth={sw} />
          <path d="M6,-1 Q11,4 16,-1" fill="none" stroke={ink} strokeWidth={sw} />
        </>
      ) : (
        <>
          <circle cx="-11" cy="0" r="3.6" fill={ink} />
          <circle cx="11" cy="0" r="3.6" fill={ink} />
          {mood === 'thinking' && (
            <path d="M-16,-9 L-6,-11" stroke={ink} strokeWidth={sw} fill="none" />
          )}
          {mood === 'working' ? (
            <ellipse cx="0" cy="12" rx="6" ry="4.4" fill={ink} />
          ) : mood === 'thinking' ? (
            <path d="M-6,11 H6" stroke={ink} strokeWidth={sw} fill="none" />
          ) : (
            <path d="M-8,10 Q0,17 8,10" fill="none" stroke={ink} strokeWidth={sw} />
          )}
        </>
      )}
    </g>
  );
}

/** Mood extras: thought bubble, sparkles, z's. Visibility driven by CSS. */
function PetFx({ x, y }: { x: number; y: number }) {
  return (
    <g aria-hidden="true">
      <g className="fx fx-thought" transform={`translate(${x + 32},${y - 50})`}>
        <rect x="-18" y="-16" width="36" height="21" rx="10.5" fill="#ffffff" opacity="0.96" />
        <rect x="-18" y="-16" width="36" height="21" rx="10.5" fill="none" stroke="#94a3b8" strokeOpacity="0.45" />
        <text x="0" y="-1" textAnchor="middle" fontSize="16" fontWeight="700" fill="#64748b">
          …
        </text>
      </g>
      <g className="fx fx-happy" transform={`translate(${x},${y - 56})`} fill="#fbbf24">
        <path d="M-30,8 C-29.4,5.6 -28.6,4.8 -26,4 C-28.6,3.2 -29.4,2.4 -30,0 C-30.6,2.4 -31.4,3.2 -34,4 C-31.4,4.8 -30.6,5.6 -30,8 Z" />
        <path d="M24,1.6 C24.5,-0.3 25.1,-1 27.2,0 C25.1,1 24.5,1.6 24,3.5 C23.5,1.6 22.9,1 20.8,0 C22.9,-1 23.5,-0.3 24,1.6 Z" />
        <path d="M8,-6 C8.5,-8 9.2,-8.7 11.5,-9.4 C9.2,-10.1 8.5,-10.8 8,-12.8 C7.5,-10.8 6.8,-10.1 4.5,-9.4 C6.8,-8.7 7.5,-8 8,-6 Z" />
      </g>
      <g className="fx fx-sleep" transform={`translate(${x + 36},${y - 44})`} fill="#818cf8" fontWeight="700">
        <text className="z z1" x="0" y="0" fontSize="13" textAnchor="middle">
          z
        </text>
        <text className="z z2" x="10" y="-14" fontSize="16" textAnchor="middle">
          z
        </text>
        <text className="z z3" x="22" y="-30" fontSize="20" textAnchor="middle">
          z
        </text>
      </g>
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* 1. KriyaDot — round ink-blue blob, 8 stubby arms each holding a tool   */
/* ------------------------------------------------------------------ */

const TOOLS = ['circle', 'square', 'tri', 'star', 'plus', 'ring', 'diamond', 'bar'] as const;

function ToolGlyph({ kind, x, y }: { kind: (typeof TOOLS)[number]; x: number; y: number }) {
  const fill = '#ffd166';
  const stroke = '#b45309';
  const sw = 1.1;
  switch (kind) {
    case 'circle':
      return <circle cx={x} cy={y} r="4" fill={fill} stroke={stroke} strokeWidth={sw} />;
    case 'square':
      return <rect x={x - 3.6} y={y - 3.6} width="7.2" height="7.2" rx="1.6" fill={fill} stroke={stroke} strokeWidth={sw} />;
    case 'tri':
      return <path d={`M${x},${y - 4.4} L${x + 4.2},${y + 3.4} L${x - 4.2},${y + 3.4} Z`} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />;
    case 'star':
      return <path d={`M${x},${y - 5} C${x + 0.7},${y - 1.8} ${x + 1.8},${y - 0.7} ${x + 5},${y} C${x + 1.8},${y + 0.7} ${x + 0.7},${y + 1.8} ${x},${y + 5} C${x - 0.7},${y + 1.8} ${x - 1.8},${y + 0.7} ${x - 5},${y} C${x - 1.8},${y - 0.7} ${x - 0.7},${y - 1.8} ${x},${y - 5} Z`} fill={fill} stroke={stroke} strokeWidth={sw} />;
    case 'plus':
      return <path d={`M${x - 4},${y} H${x + 4} M${x},${y - 4} V${y + 4}`} stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />;
    case 'ring':
      return <circle cx={x} cy={y} r="3.6" fill="none" stroke={stroke} strokeWidth="2.2" />;
    case 'diamond':
      return <path d={`M${x},${y - 4.6} L${x + 3.6},${y} L${x},${y + 4.6} L${x - 3.6},${y} Z`} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />;
    case 'bar':
      return <rect x={x - 4.4} y={y - 1.8} width="8.8" height="3.6" rx="1.8" fill={fill} stroke={stroke} strokeWidth={sw} />;
  }
}

function KriyaDotArt({ mood }: ArtProps) {
  const gid = useGid('kriyadot');
  const cx = 60;
  const cy = 66;
  const arms = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return {
      x1: cx + 29 * Math.cos(a),
      y1: cy + 29 * Math.sin(a),
      x2: cx + 42 * Math.cos(a),
      y2: cy + 42 * Math.sin(a),
      tx: cx + 48 * Math.cos(a),
      ty: cy + 48 * Math.sin(a),
      tool: TOOLS[i],
    };
  });
  return (
    <g>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6d9bff" />
          <stop offset="1" stopColor="#2b50c8" />
        </linearGradient>
      </defs>
      {arms.map((a, i) => (
        <line key={i} x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke="#2b50c8" strokeWidth="8" strokeLinecap="round" />
      ))}
      <circle cx={cx} cy={cy} r="32" fill={`url(#${gid})`} />
      <ellipse cx="49" cy="55" rx="11" ry="8" fill="#ffffff" opacity="0.32" />
      <circle cx="71" cy="79" r="3" fill="#ffffff" opacity="0.22" />
      {arms.map((a, i) => (
        <ToolGlyph key={i} kind={a.tool} x={a.tx} y={a.ty} />
      ))}
      <Face mood={mood} x={cx} y={cy} ink="#1e2a52" />
      <PetFx x={cx} y={cy} />
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Ocky — purple explorer, big eyes + headlamp                       */
/* ------------------------------------------------------------------ */

function OckyArt({ mood }: ArtProps) {
  const gid = useGid('ocky');
  const ink = '#2a1b4e';
  return (
    <g>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b794f6" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      {[38, 51, 64, 77].map((x) => (
        <rect key={x} x={x - 5} y="92" width="10" height="13" rx="5" fill="#6d28d9" />
      ))}
      <path d="M30,98 C30,58 44,42 60,42 C76,42 90,58 90,98 Q60,107 30,98 Z" fill={`url(#${gid})`} />
      <ellipse cx="48" cy="58" rx="9" ry="12" fill="#ffffff" opacity="0.25" />
      <path d="M38,50 Q60,38 82,50" fill="none" stroke="#4c1d95" strokeWidth="5" strokeLinecap="round" />
      <rect x="53" y="24" width="14" height="11" rx="4" fill="#fde68a" stroke="#b45309" strokeWidth="1.4" />
      <polygon className="fx fx-lamp" points="60,36 38,72 82,72" fill="#fde68a" opacity="0.16" />
      <g>
        <circle cx="47" cy="66" r="10.5" fill="#ffffff" />
        <circle cx="73" cy="66" r="10.5" fill="#ffffff" />
        {mood === 'happy' ? (
          <>
            <path d="M40,66 Q47,58 54,66" fill="none" stroke={ink} strokeWidth="2.6" strokeLinecap="round" />
            <path d="M66,66 Q73,58 80,66" fill="none" stroke={ink} strokeWidth="2.6" strokeLinecap="round" />
          </>
        ) : mood === 'error' ? (
          <path d="M43,62 L51,70 M51,62 L43,70 M69,62 L77,70 M77,62 L69,70" stroke={ink} strokeWidth="2.4" strokeLinecap="round" />
        ) : mood === 'sleeping' ? (
          <>
            <path d="M41,66 H53" stroke={ink} strokeWidth="2.6" strokeLinecap="round" />
            <path d="M67,66 H79" stroke={ink} strokeWidth="2.6" strokeLinecap="round" />
          </>
        ) : (
          <>
            <circle cx={mood === 'thinking' ? 47 : 48.5} cy={mood === 'thinking' ? 63 : 67} r="4.6" fill={ink} />
            <circle cx={mood === 'thinking' ? 73 : 74.5} cy={mood === 'thinking' ? 63 : 67} r="4.6" fill={ink} />
            <circle cx={mood === 'thinking' ? 48.6 : 50} cy={mood === 'thinking' ? 61.4 : 65.4} r="1.5" fill="#fff" />
            <circle cx={mood === 'thinking' ? 74.6 : 76} cy={mood === 'thinking' ? 61.4 : 65.4} r="1.5" fill="#fff" />
          </>
        )}
      </g>
      {mood === 'error' ? (
        <circle cx="60" cy="88" r="3.6" fill="none" stroke={ink} strokeWidth="2.4" />
      ) : mood === 'working' ? (
        <ellipse cx="60" cy="87" rx="6" ry="4.4" fill={ink} />
      ) : mood !== 'sleeping' ? (
        <path d="M53,86 Q60,91 67,86" fill="none" stroke={ink} strokeWidth="2.4" strokeLinecap="round" />
      ) : null}
      <ellipse cx="38" cy="79" rx="4" ry="2.6" fill="#f9a8d4" opacity="0.55" />
      <ellipse cx="82" cy="79" rx="4" ry="2.6" fill="#f9a8d4" opacity="0.55" />
      <PetFx x={60} y={66} />
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Nubi — rainbow-frilled slug                                       */
/* ------------------------------------------------------------------ */

const FRILLS = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#60a5fa', '#c084fc'];

function NubiArt({ mood }: ArtProps) {
  const gid = useGid('nubi');
  return (
    <g>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd9c0" />
          <stop offset="1" stopColor="#ffab8a" />
        </linearGradient>
      </defs>
      {FRILLS.map((c, i) => (
        <circle key={c} cx={30 + i * 12} cy="56" r="8.5" fill={c} opacity="0.95" stroke="#ffffff" strokeOpacity="0.7" strokeWidth="1.4" />
      ))}
      <path d="M18,86 C18,64 34,58 52,58 L78,58 C96,58 102,68 100,86 C80,95 40,95 18,86 Z" fill={`url(#${gid})`} />
      <path d="M18,86 q-9,1 -12,8 q9,3 14,-2 Z" fill="#ffab8a" />
      <ellipse cx="42" cy="70" rx="12" ry="7" fill="#ffffff" opacity="0.3" />
      <line x1="68" y1="56" x2="64" y2="46" stroke="#e07b54" strokeWidth="3" strokeLinecap="round" />
      <line x1="80" y1="56" x2="84" y2="46" stroke="#e07b54" strokeWidth="3" strokeLinecap="round" />
      <circle cx="64" cy="44" r="3.4" fill="#e07b54" />
      <circle cx="84" cy="44" r="3.4" fill="#e07b54" />
      <Face mood={mood} x={72} y={74} s={0.9} ink="#5b3a2e" />
      <PetFx x={66} y={70} />
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Plip — droplet blob, 6 wiggly arms                                 */
/* ------------------------------------------------------------------ */

function PlipArt({ mood }: ArtProps) {
  const gid = useGid('plip');
  return (
    <g>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6ee7d8" />
          <stop offset="1" stopColor="#0d9488" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="#0f766e" strokeWidth="6.5" strokeLinecap="round">
        <path d="M37,62 q-11,-3 -15,-12" />
        <path d="M35,78 q-11,3 -13,11" />
        <path d="M83,62 q11,-3 15,-12" />
        <path d="M85,78 q11,3 13,11" />
        <path d="M48,98 q-4,9 -12,11" />
        <path d="M72,98 q4,9 12,11" />
      </g>
      <path
        d="M60,20 C60,20 36,54 36,78 C36,94 47,102 60,102 C73,102 84,94 84,78 C84,54 60,20 60,20 Z"
        fill={`url(#${gid})`}
      />
      <ellipse cx="50" cy="58" rx="7" ry="12" fill="#ffffff" opacity="0.35" transform="rotate(-14 50 58)" />
      <Face mood={mood} x={60} y={76} ink="#134e4a" />
      <PetFx x={60} y={72} />
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* 5. Bolt — geometric robot pet                                        */
/* ------------------------------------------------------------------ */

function BoltArt({ mood }: ArtProps) {
  const gid = useGid('bolt');
  const eyeFill = mood === 'error' ? '#f87171' : mood === 'sleeping' ? '#155e75' : '#22d3ee';
  const eyeOp = mood === 'sleeping' ? 0.55 : 1;
  return (
    <g>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e8edf5" />
          <stop offset="1" stopColor="#94a3b8" />
        </linearGradient>
      </defs>
      <rect x="38" y="88" width="44" height="18" rx="9" fill="#475569" />
      {[48, 60, 72].map((x) => (
        <line key={x} x1={x} y1="90" x2={x} y2="104" stroke="#94a3b8" strokeWidth="2.4" strokeLinecap="round" />
      ))}
      <rect x="52" y="78" width="16" height="12" fill="#94a3b8" />
      <rect x="26" y="52" width="10" height="22" rx="5" fill="#94a3b8" />
      <rect x="84" y="52" width="10" height="22" rx="5" fill="#94a3b8" />
      <rect x="24" y="44" width="9" height="16" rx="4.5" fill="#64748b" />
      <rect x="87" y="44" width="9" height="16" rx="4.5" fill="#64748b" />
      <rect x="32" y="26" width="56" height="54" rx="16" fill={`url(#${gid})`} />
      <rect x="39" y="33" width="42" height="40" rx="11" fill="none" stroke="#64748b" strokeOpacity="0.5" strokeWidth="1.6" />
      <line x1="60" y1="26" x2="60" y2="15" stroke="#64748b" strokeWidth="3" strokeLinecap="round" />
      <circle className="fx fx-antenna" cx="60" cy="11" r="4.6" fill="#f59e0b" stroke="#b45309" strokeWidth="1.2" />
      <rect x="44" y="44" width="13" height="18" rx="6.5" fill={eyeFill} opacity="0.32" />
      <rect x="65" y="44" width="13" height="18" rx="6.5" fill={eyeFill} opacity="0.32" />
      <rect x="44" y="46" width="13" height="18" rx="6.5" fill={eyeFill} opacity={eyeOp} />
      <rect x="63" y="46" width="13" height="18" rx="6.5" fill={eyeFill} opacity={eyeOp} />
      {mood === 'error' ? (
        <path d="M52,72 l4,-4 4,4 4,-4 4,4" fill="none" stroke="#475569" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : mood === 'happy' ? (
        <path d="M52,70 Q60,78 68,70" fill="none" stroke="#475569" strokeWidth="2.6" strokeLinecap="round" />
      ) : (
        <g stroke="#475569" strokeWidth="2.4" strokeLinecap="round">
          <line x1="52" y1="69" x2="68" y2="69" />
          <line x1="52" y1="74" x2="68" y2="74" />
        </g>
      )}
      <PetFx x={60} y={60} />
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* 6. Wisp — floating ghost wisp, soft glow                              */
/* ------------------------------------------------------------------ */

function WispArt({ mood }: ArtProps) {
  const gid = useGid('wisp');
  const hid = useGid('wisp-halo');
  const ink = '#4c1d95';
  return (
    <g>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#ddd6fe" />
        </linearGradient>
        <radialGradient id={hid}>
          <stop offset="0" stopColor="#c4b5fd" stopOpacity="0.45" />
          <stop offset="1" stopColor="#c4b5fd" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="60" cy="60" r="44" fill={`url(#${hid})`} />
      <path
        d="M60,26 C42,26 32,40 32,58 L32,88 Q39,80 46,88 Q53,80 60,88 Q67,80 74,88 Q81,80 88,88 L88,58 C88,40 78,26 60,26 Z"
        fill={`url(#${gid})`}
        opacity="0.97"
      />
      <ellipse cx="46" cy="46" rx="8" ry="11" fill="#ffffff" opacity="0.6" />
      {mood === 'error' ? (
        <>
          <circle cx="49" cy="60" r="3.4" fill={ink} />
          <circle cx="71" cy="60" r="3.4" fill={ink} />
          <circle cx="60" cy="74" r="3.2" fill="none" stroke={ink} strokeWidth="2.4" />
        </>
      ) : (
        <>
          <path d="M42,60 Q48,65 54,60" fill="none" stroke={ink} strokeWidth="2.6" strokeLinecap="round" />
          <path d="M66,60 Q72,65 78,60" fill="none" stroke={ink} strokeWidth="2.6" strokeLinecap="round" />
          {mood === 'happy' ? (
            <ellipse cx="60" cy="72" rx="6" ry="4.4" fill={ink} />
          ) : mood !== 'sleeping' ? (
            <path d="M55,71 Q60,75 65,71" fill="none" stroke={ink} strokeWidth="2.2" strokeLinecap="round" />
          ) : null}
        </>
      )}
      <ellipse cx="40" cy="69" rx="4.4" ry="3" fill="#f9a8d4" opacity="0.7" />
      <ellipse cx="80" cy="69" rx="4.4" ry="3" fill="#f9a8d4" opacity="0.7" />
      <PetFx x={60} y={62} />
    </g>
  );
}

/* ------------------------------------------------------------------ */

export const PET_ART: Record<PetId, (props: ArtProps) => React.ReactElement> = {
  kriyadot: KriyaDotArt,
  ocky: OckyArt,
  nubi: NubiArt,
  plip: PlipArt,
  bolt: BoltArt,
  wisp: WispArt,
};
