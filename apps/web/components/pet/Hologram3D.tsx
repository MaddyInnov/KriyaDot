// SPDX-License-Identifier: Apache-2.0
// Hologram3D — the flagship KriyaDot companion as a floating holographic
// medallion: the brand portrait on a glowing circular holo-disc, ringed by
// an orbiting gold/cyan particle field and equalizer light arcs.
//
// Same performance + accessibility contract as Pet3D / ClayScene:
// - lazy three.js usage (WebGPU via three/webgpu, WebGL2 fallback)
// - pauses when offscreen (IntersectionObserver) or tab hidden
// - prefers-reduced-motion → single static frame, no loop
// - pixelRatio capped at 2, full geometry/material/texture disposal
// - pointer lean / hover grow / click bounce on an outer rig group
// - mood pose choreography shared with Pet3D via petMoodPose()

'use client';

import { useEffect, useRef, type MouseEventHandler } from 'react';
import * as THREE from 'three';
import type { PetMood } from '../../lib/pet';
import { PET_CELEBRATION_DURATION_S, PET_SPEAKING_CADENCE_HZ, petMoodPose } from './Pet3D';

export interface Hologram3DProps {
  /** Canvas size in px (square). */
  size?: number;
  mood?: PetMood;
  className?: string;
  label?: string;
  /** Disable pointer interactivity (e.g. decorative previews). */
  interactive?: boolean;
  /** Double-click handler, forwarded to the wrapper div (e.g. celebrate). */
  onDoubleClick?: MouseEventHandler<HTMLDivElement>;
}

/* ------------------------------------------------------------------ */
/* Pure config + mood visuals (unit-testable without WebGL)            */
/* ------------------------------------------------------------------ */

/** Pure config — safe to import in tests without WebGL. */
export const HOLO3D_CONFIG = {
  particleCount: 260,
  discRadius: 1.18,
  gold: '#fbbf24',
  cyan: '#22d3ee',
  violet: '#8b5cf6',
} as const;

/** Brand artwork shown on the holo-disc (800px portrait, see lib/pet.ts). */
export const HOLO3D_ARTWORK_SRC = '/brand/hologram-avatar.png';

export interface HoloMoodVisual {
  /** Particle orbit speed multiplier (1 = gentle idle drift). */
  particleSpeed: number;
  /** Particle orbit radius multiplier (1 = resting ring radius). */
  particleSpread: number;
  /** 0..~0.3 holographic flicker amplitude. */
  flicker: number;
  /** Glow intensity multiplier (1 = baseline). */
  glow: number;
  /** 0..1 speaking equalizer level. */
  eqLevel: number;
  /** 0..1 celebration burst strength (1 at burst start, decays to 0). */
  burst: number;
  /** Hue shift: >0 warm/gold, <0 red/error. */
  hueShift: number;
  /** Overall brightness multiplier (1 = full, ~0.45 sleeping). */
  dim: number;
}

const IDLE_VISUAL: HoloMoodVisual = {
  particleSpeed: 1, particleSpread: 1, flicker: 0.04, glow: 1,
  eqLevel: 0, burst: 0, hueShift: 0, dim: 1,
};

/**
 * Pure mood → hologram visual mapping. `t` is absolute scene time (s),
 * `elapsed` is seconds since the mood started. Every field stays finite
 * for any input, including negative / NaN t or elapsed (sanitised the
 * same way petMoodPose clamps its inputs).
 */
export function holoMoodVisual(mood: PetMood, t: number, elapsed: number): HoloMoodVisual {
  const ts = Number.isFinite(t) ? t : 0;
  switch (mood) {
    case 'thinking':
      return { ...IDLE_VISUAL, particleSpeed: 1.8, particleSpread: 1.08, flicker: 0.09, glow: 1.15 };
    case 'working':
      return { ...IDLE_VISUAL, particleSpeed: 2.6, particleSpread: 1.14, flicker: 0.07, glow: 1.25 };
    case 'speaking': {
      // Equalizer level driven at the shared speaking cadence (7 Hz).
      const eqLevel = 0.5 + 0.5 * Math.sin(ts * PET_SPEAKING_CADENCE_HZ * Math.PI * 2);
      return { ...IDLE_VISUAL, particleSpeed: 1.3, flicker: 0.05, glow: 1.15 + eqLevel * 0.25, eqLevel };
    }
    case 'happy':
      return { ...IDLE_VISUAL, particleSpeed: 1.4, particleSpread: 1.06, flicker: 0.05, glow: 1.3, hueShift: 0.08 };
    case 'celebrating': {
      const dur = PET_CELEBRATION_DURATION_S;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= dur) return { ...IDLE_VISUAL };
      const burst = 1 - elapsed / dur; // 1 at start, decays to 0
      return { ...IDLE_VISUAL, particleSpeed: 3, particleSpread: 1 + burst * 0.35, flicker: 0.06, glow: 1.5, burst };
    }
    case 'error': {
      // High flicker with a deterministic jitter component (sin hash of t,
      // no per-frame randomness so renders stay stable / testable).
      const jitter = Math.sin(ts * 31.7) * 0.6 + Math.sin(ts * 17.3 + 1.3) * 0.4; // -1..1
      return { ...IDLE_VISUAL, particleSpeed: 1.2, particleSpread: 1.04, flicker: 0.25 + jitter * 0.03, glow: 0.9, hueShift: -0.6 };
    }
    case 'sleeping':
      return { ...IDLE_VISUAL, particleSpeed: 0.3, particleSpread: 0.85, flicker: 0.02, glow: 0.6, dim: 0.45 };
    case 'idle':
    default:
      return { ...IDLE_VISUAL };
  }
}

/* ------------------------------------------------------------------ */
/* helpers (local equivalents of Pet3D's non-exported helpers)         */
/* ------------------------------------------------------------------ */

interface InterState { leanX: number; leanY: number; bounce: number; hovering: boolean }

function applyInter(rig: THREE.Group, inter: InterState): void {
  // Lean toward the cursor + bounce impulse from clicks, on an outer rig
  // so it never fights the hologram's own animation (mirrors Pet3D).
  rig.rotation.y += (inter.leanX * 0.5 - rig.rotation.y) * 0.08;
  rig.rotation.x += (inter.leanY * 0.28 - rig.rotation.x) * 0.08;
  if (inter.bounce > 0.01) {
    rig.position.y = Math.sin(Math.min(inter.bounce, 1) * Math.PI) * 0.45;
  } else {
    rig.position.y *= 0.9;
  }
  const s = inter.hovering ? 1.06 : 1;
  rig.scale.setScalar(rig.scale.x + (s - rig.scale.x) * 0.15);
}

/** Deterministic 0..1 hash — stable particle layout, no Math.random. */
function hash01(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function trackDisposables(root: THREE.Object3D): () => void {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const obj = o as THREE.Mesh & THREE.Points & THREE.Sprite;
    if (obj.geometry) geos.add(obj.geometry);
    const m = obj.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) m.forEach((x) => mats.add(x));
    else if (m) mats.add(m);
  });
  return () => { geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose()); };
}

/** Soft radial-gradient texture (glow sprite / mote sprite). */
function makeRadialTexture(size: number, stops: Array<[number, string]>): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [at, color] of stops) grad.addColorStop(at, color);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Fallback disc texture if the brand artwork fails to load: a deep-navy
 *  medallion with a cyan ring and a gold core, drawn on a canvas. */
function makeFallbackDiscTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 8, size / 2, size / 2, size / 2);
    grad.addColorStop(0, '#1e2a52'); grad.addColorStop(0.72, '#101a38'); grad.addColorStop(1, '#0a1026');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = HOLO3D_CONFIG.cyan; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = HOLO3D_CONFIG.gold;
    ctx.beginPath(); ctx.arc(size / 2, size / 2, 16, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------------------ */
/* renderer (WebGPU where available, WebGL2 fallback — as Pet3D)       */
/* ------------------------------------------------------------------ */

type AnyRenderer = {
  setSize: (w: number, h: number) => void;
  setPixelRatio: (r: number) => void;
  setAnimationLoop: (cb: ((t: number) => void) | null) => void;
  render: (s: THREE.Scene, c: THREE.Camera) => void;
  dispose: () => void;
};

async function makeRenderer(canvas: HTMLCanvasElement): Promise<AnyRenderer> {
  const nav = navigator as Navigator & { gpu?: unknown };
  if (nav.gpu) {
    try {
      const m = (await import('three/webgpu')) as unknown as {
        WebGPURenderer: new (opts: object) => AnyRenderer & { init: () => Promise<void> };
      };
      const r = new m.WebGPURenderer({ canvas, antialias: true });
      await r.init();
      return r;
    } catch { /* fall through to WebGL */ }
  }
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  return r as unknown as AnyRenderer;
}

/* ------------------------------------------------------------------ */
/* scene                                                               */
/* ------------------------------------------------------------------ */

interface BuiltHolo {
  group: THREE.Group;
  tick: (t: number, mood: PetMood, moodElapsed: number) => void;
  /** Re-render hook wired by the component (late texture arrival). */
  refresh: () => void;
  setRefresh: (fn: () => void) => void;
  dispose: () => void;
}

function buildHologram(onTextureReady: () => void): BuiltHolo {
  const group = new THREE.Group(); // holo group (float bob lives here)
  const cfg = HOLO3D_CONFIG;
  const textures: THREE.Texture[] = [];
  let refreshFn: (() => void) | null = null;

  // Soft radial glow behind the disc (additive sprite — reads on the light
  // porcelain theme because the medallion itself is deep navy).
  const glowTex = makeRadialTexture(256, [
    [0, 'rgba(255,255,255,0.85)'], [0.4, 'rgba(255,255,255,0.32)'], [1, 'rgba(255,255,255,0)'],
  ]);
  textures.push(glowTex);
  const glowMat = new THREE.SpriteMaterial({
    map: glowTex, color: new THREE.Color(cfg.cyan), transparent: true,
    opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const glowSprite = new THREE.Sprite(glowMat);
  glowSprite.scale.setScalar(3.9);
  glowSprite.position.z = -0.4;
  group.add(glowSprite);

  // The holo-disc: circular medallion (CircleGeometry UVs map the square
  // artwork into the circle, so the centred face crop shows, no corners).
  const fallbackTex = makeFallbackDiscTexture();
  textures.push(fallbackTex);
  const discMat = new THREE.MeshBasicMaterial({ map: fallbackTex, transparent: true });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(cfg.discRadius, 64), discMat);
  group.add(disc);

  // Load the real artwork; on failure the fallback texture stays (no crash).
  let artworkTex: THREE.Texture | null = null;
  try {
    new THREE.TextureLoader().load(HOLO3D_ARTWORK_SRC, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      artworkTex = tex;
      textures.push(tex);
      discMat.map = tex;
      discMat.needsUpdate = true;
      onTextureReady();
    }, undefined, () => { /* keep the fallback disc texture */ });
  } catch { /* keep the fallback disc texture */ }

  // Thin glowing rings around the disc edge (cyan inner, violet outer).
  const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(cfg.cyan), transparent: true, opacity: 0.9 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(cfg.discRadius + 0.045, 0.016, 10, 96), ringMat);
  ring.position.z = 0.01;
  group.add(ring);
  const ring2Mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(cfg.violet), transparent: true, opacity: 0.45 });
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(cfg.discRadius + 0.14, 0.007, 8, 96), ring2Mat);
  ring2.position.z = -0.02;
  group.add(ring2);

  // Speaking equalizer: three torus arcs pulsing with the EQ level.
  const eqColors = [cfg.cyan, cfg.gold, cfg.violet];
  const eqArcs: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }> = [];
  for (let i = 0; i < 3; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(eqColors[i]), transparent: true, opacity: 0, depthWrite: false,
    });
    const arc = new THREE.Mesh(new THREE.TorusGeometry(cfg.discRadius + 0.24 + i * 0.13, 0.02, 8, 64, 1.7 + i * 0.35), mat);
    arc.rotation.z = i * 2.1 + 0.4;
    arc.position.z = -0.03 - i * 0.01;
    group.add(arc);
    eqArcs.push({ mesh: arc, mat });
  }

  // Particle field: gold/cyan/violet points on tilted orbit rings + noise.
  const count = cfg.particleCount;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(count * 3);
  const pColor = new Float32Array(count * 3);
  const baseAngle = new Float32Array(count);
  const baseRadius = new Float32Array(count);
  const baseTilt = new Float32Array(count);
  const baseSpeed = new Float32Array(count);
  const basePhase = new Float32Array(count);
  const burstPush = new Float32Array(count);
  const palette = [new THREE.Color(cfg.gold), new THREE.Color(cfg.cyan), new THREE.Color(cfg.violet)];
  for (let i = 0; i < count; i++) {
    const ringIdx = i % 5; // five tilted orbit rings
    baseAngle[i] = hash01(i * 1.7) * Math.PI * 2;
    baseRadius[i] = cfg.discRadius + 0.22 + ringIdx * 0.11 + hash01(i * 3.1) * 0.16;
    baseTilt[i] = (ringIdx - 2) * 0.16 + (hash01(i * 5.3) - 0.5) * 0.12;
    baseSpeed[i] = (0.55 + hash01(i * 7.9) * 0.8) * (i % 2 === 0 ? 1 : -0.8);
    basePhase[i] = hash01(i * 11.3) * Math.PI * 2;
    burstPush[i] = 0.35 + hash01(i * 13.7) * 0.85;
    const c = palette[i % 5 === 4 ? 2 : i % 2];
    pColor[i * 3] = c.r; pColor[i * 3 + 1] = c.g; pColor[i * 3 + 2] = c.b;
  }
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pColor, 3));
  const pMat = new THREE.PointsMaterial({
    size: 0.055, vertexColors: true, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  group.add(new THREE.Points(pGeo, pMat));

  // Sleeping motes: five soft sprites that rise slowly (Zzz-equivalent).
  const motes: Array<{ sprite: THREE.Sprite; mat: THREE.SpriteMaterial; seed: number }> = [];
  for (let i = 0; i < 5; i++) {
    const mat = new THREE.SpriteMaterial({
      map: glowTex, color: new THREE.Color(cfg.gold), transparent: true,
      opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(0.16 + hash01(i * 3.3) * 0.12);
    group.add(sprite);
    motes.push({ sprite, mat, seed: hash01(i * 9.1) });
  }

  const cyanColor = new THREE.Color(cfg.cyan);
  const redColor = new THREE.Color('#ef4444');

  const tick = (t: number, mood: PetMood, moodElapsed: number) => {
    const v = holoMoodVisual(mood, t, moodElapsed);
    const sleeping = mood === 'sleeping';

    // Gentle float (slower + lower while sleeping).
    const floatSpeed = sleeping ? 0.55 : 1.35;
    group.position.y = Math.sin(t * floatSpeed) * (sleeping ? 0.04 : 0.075) - (sleeping ? 0.08 : 0);
    group.rotation.y = Math.sin(t * 0.45) * 0.08;
    group.rotation.x = Math.sin(t * 0.32) * 0.03;

    // Holographic flicker — deterministic sin-combo jitter of t.
    const jitter01 = 0.5 + 0.5 * (Math.sin(t * 43.7) * 0.6 + Math.sin(t * 17.9 + 1.7) * 0.4);
    discMat.opacity = Math.max(0, Math.min(1, v.dim * (1 - v.flicker * jitter01)));
    // Hue shift: warm tint when positive, red tint when negative.
    const warm = Math.max(0, v.hueShift);
    const red = Math.max(0, -v.hueShift);
    discMat.color.setRGB(1, 1 - red * 0.5 - warm * 0.04, 1 - red * 0.55 - warm * 0.1);
    ringMat.color.copy(cyanColor).lerp(redColor, Math.min(1, red));
    ringMat.opacity = 0.55 + 0.35 * v.glow * v.dim;
    ring2Mat.opacity = 0.3 + 0.25 * v.glow * v.dim;
    ring.rotation.z = t * 0.12 * v.particleSpeed;
    ring2.rotation.z = -t * 0.08 * v.particleSpeed;
    glowMat.opacity = Math.max(0, 0.34 * v.glow * v.dim * (1 - v.flicker * jitter01 * 0.6));
    glowSprite.scale.setScalar(3.9 * (0.96 + 0.05 * v.glow));

    // Equalizer arcs only show when there is an EQ level (speaking).
    eqArcs.forEach(({ mesh, mat }, i) => {
      mat.opacity = v.eqLevel * (0.75 - i * 0.16) * v.dim;
      mesh.scale.setScalar(1 + v.eqLevel * 0.045 * (i + 1));
      mesh.rotation.z = i * 2.1 + 0.4 + t * (0.25 + i * 0.12);
    });

    // Particles: orbit, spread, and radial celebration burst.
    for (let i = 0; i < count; i++) {
      const a = baseAngle[i] + t * 0.35 * v.particleSpeed * baseSpeed[i];
      const r = baseRadius[i] * v.particleSpread + v.burst * burstPush[i];
      const yRaw = Math.sin(a) * r;
      pPos[i * 3] = Math.cos(a) * r;
      pPos[i * 3 + 1] = yRaw * Math.cos(baseTilt[i]) + Math.sin(t * 0.9 + basePhase[i]) * 0.03;
      pPos[i * 3 + 2] = yRaw * Math.sin(baseTilt[i]) - 0.08;
    }
    pGeo.attributes.position.needsUpdate = true;
    pMat.opacity = 0.85 * v.dim * (0.7 + 0.3 * v.glow);
    pMat.size = 0.05 + v.burst * 0.03 + v.eqLevel * 0.012;

    // Sleeping motes drift upward slowly; hidden in other moods.
    motes.forEach(({ sprite, mat, seed }, i) => {
      const cycle = (t * 0.055 + seed) % 1;
      sprite.position.set(0.55 + seed * 0.5 + Math.sin(t * 0.5 + i * 1.7) * 0.08, -0.5 + cycle * 1.7, 0.25);
      mat.opacity = sleeping ? Math.sin(cycle * Math.PI) * 0.55 * (0.5 + v.dim) : 0;
    });
  };

  const disposeScene = trackDisposables(group);
  return {
    group, tick,
    refresh: () => refreshFn?.(),
    setRefresh: (fn: () => void) => { refreshFn = fn; },
    dispose: () => {
      disposeScene();
      textures.forEach((tex) => tex.dispose());
      if (artworkTex && !textures.includes(artworkTex)) artworkTex.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

export function Hologram3D({
  size = 140, mood = 'idle', className = '', label, interactive = true, onDoubleClick,
}: Hologram3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const moodRef = useRef<PetMood>(mood);
  moodRef.current = mood;
  const interRef = useRef<InterState>({ leanX: 0, leanY: 0, bounce: 0, hovering: false });

  useEffect(() => {
    const mount = mountRef.current;
    const canvas = canvasRef.current;
    if (!mount || !canvas) return;
    let disposed = false;
    let renderer: AnyRenderer | null = null;
    let built: BuiltHolo | null = null;
    let rafPaused = true;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const boot = async () => {
      renderer = await makeRenderer(canvas);
      if (disposed || !renderer) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(size, size);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
      camera.position.set(0, 0.35, 5.4);
      camera.lookAt(0, 0, 0);

      const rig = new THREE.Group();
      // Mood pose group sits between the pointer rig and the hologram so
      // speaking/celebrating transforms never fight tick() or applyInter().
      const moodGroup = new THREE.Group();
      scene.add(rig);
      rig.add(moodGroup);

      const clock = new THREE.Clock();
      const inter = interRef.current;
      let lastMood: PetMood | null = null;
      let moodStartT = 0;

      const frame = () => {
        if (!renderer || !built) return;
        const t = clock.getElapsedTime();
        const currentMood = moodRef.current;
        if (currentMood !== lastMood) { lastMood = currentMood; moodStartT = t; }
        const moodElapsed = Math.max(0, t - moodStartT);
        inter.bounce *= 0.94;
        built.tick(t, currentMood, moodElapsed);
        const pose = petMoodPose(currentMood, moodElapsed, t);
        moodGroup.position.y = pose.offsetY;
        moodGroup.rotation.y = pose.rotationY;
        moodGroup.rotation.z = pose.rotationZ;
        moodGroup.scale.setScalar(pose.scale);
        // Speaking talk bob, applied subtly on top of the shared pose.
        if (currentMood === 'speaking') moodGroup.position.y += pose.talk * 0.012;
        applyInter(rig, inter);
        renderer.render(scene, camera);
      };

      // Reduced motion: ONE static frame with the idle visual; if the
      // artwork arrives after that frame, re-render that frame once.
      const staticFrame = () => {
        if (!renderer || !built) return;
        built.tick(0, 'idle', 0);
        renderer.render(scene, camera);
      };
      built = buildHologram(() => { if (reduced) staticFrame(); });
      built.setRefresh(staticFrame);
      moodGroup.add(built.group);

      if (reduced) {
        staticFrame();
        return;
      }

      renderer.setAnimationLoop(() => { if (!rafPaused) frame(); });
      const io = new IntersectionObserver((entries) => {
        rafPaused = !entries[0]?.isIntersecting || document.hidden;
      }, { threshold: 0.05 });
      io.observe(mount);
      const onVis = () => { rafPaused = document.hidden; };
      document.addEventListener('visibilitychange', onVis);
      return () => { io.disconnect(); document.removeEventListener('visibilitychange', onVis); };
    };

    let cleanup: (() => void) | undefined;
    boot().then((c) => { cleanup = c; });

    // Pointer interactivity (same conventions as Pet3D).
    const onMove = (e: PointerEvent) => {
      if (!interactive) return;
      const r = canvas.getBoundingClientRect();
      interRef.current.leanX = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      interRef.current.leanY = Math.max(-1, Math.min(1, -(((e.clientY - r.top) / r.height) * 2 - 1)));
      interRef.current.hovering = true;
    };
    const onLeave = () => { interRef.current.leanX = 0; interRef.current.leanY = 0; interRef.current.hovering = false; };
    const onDown = () => { if (interactive) interRef.current.bounce = 1; };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerdown', onDown);

    return () => {
      disposed = true;
      cleanup?.();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      try {
        renderer?.setAnimationLoop(null);
        built?.dispose();
        renderer?.dispose();
      } catch { /* ignore teardown races */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, interactive]);

  return (
    <div
      ref={mountRef}
      className={`pet pet-hologram pet3d-holo pet-mood-${mood}${className ? ` ${className}` : ''}`}
      data-mood={mood}
      data-pet="kriyadot"
      style={{ width: size, height: size, cursor: interactive ? 'pointer' : 'default' }}
      role="img"
      aria-label={label ?? `KriyaDot hologram companion pet (${mood})`}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}
