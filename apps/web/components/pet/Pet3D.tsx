// SPDX-License-Identifier: Apache-2.0
// Interactive 3D companion pets — WebGL2 with WebGPU where available.
// Each of the 6 pets is a procedural low-poly clay character (no model files):
// breathing/bobbing idle motion, blinking, mood-driven behavior, and pointer
// interactivity (leans toward your cursor, bounces when clicked).
//
// Performance + accessibility guards (same contract as ClayScene):
// - lazy-loaded via next/dynamic (three.js never in the initial bundle), ssr:false
// - pauses when offscreen (IntersectionObserver) or tab hidden
// - prefers-reduced-motion → single static frame, no loop
// - pixelRatio capped at 2, geometries disposed on unmount
// - 2D SVG fallback lives in Pet.tsx for tiny sizes / SSR

'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { PetId, PetMood } from '../../lib/pet';

export interface Pet3DProps {
  pet: PetId;
  mood?: PetMood;
  /** Canvas size in px (square). */
  size?: number;
  className?: string;
  label?: string;
  /** Disable pointer interactivity (e.g. decorative previews). */
  interactive?: boolean;
}

/** Pure config — safe to import in tests without WebGL. */
export const PET3D_CONFIG: Record<PetId, { body: string; accent: string; description: string }> = {
  kriyadot: { body: '#4256c8', accent: '#8b9bf5', description: 'ink-blue blob, eight tool arms' },
  ocky: { body: '#8b5cf6', accent: '#fbbf24', description: 'purple explorer, headlamp' },
  nubi: { body: '#f1efff', accent: '#f9a8d4', description: 'cloud drifter, rainbow frill' },
  plip: { body: '#2dd4bf', accent: '#a7f3d0', description: 'teardrop, six wiggly arms' },
  bolt: { body: '#64748b', accent: '#f97316', description: 'geometric robot, LED eyes' },
  wisp: { body: '#c4b5fd', accent: '#ede9fe', description: 'ethereal floater, soft glow' },
};

export const PET3D_IDS: PetId[] = ['kriyadot', 'ocky', 'nubi', 'plip', 'bolt', 'wisp'];

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function clay(color: string | number | THREE.Color, roughness = 0.85): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.04 });
}

/** Deterministic organic displacement so the blob is stable across renders. */
function displace(geo: THREE.BufferGeometry, amp: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = Math.sin(v.x * 12.9898 + v.y * 78.233 + v.z * 37.719) * 43758.5453;
    const f = 1 + amp * ((n - Math.floor(n)) - 0.5) * 2;
    pos.setXYZ(i, v.x * f, v.y * f, v.z * f);
  }
  geo.computeVertexNormals();
}

interface Eyes {
  group: THREE.Group;
  whites: THREE.Mesh[];
  pupils: THREE.Mesh[];
}

function makeEyes(ink = 0x23203a): Eyes {
  const group = new THREE.Group();
  const whites: THREE.Mesh[] = [];
  const pupils: THREE.Mesh[] = [];
  for (const x of [-0.3, 0.3]) {
    const white = new THREE.Mesh(
      new THREE.SphereGeometry(0.155, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }),
    );
    white.position.set(x, 0.18, 0.82);
    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(0.068, 14, 12),
      new THREE.MeshStandardMaterial({ color: ink, roughness: 0.25 }),
    );
    pupil.position.set(x, 0.18, 0.95);
    group.add(white, pupil);
    whites.push(white);
    pupils.push(pupil);
  }
  return { group, whites, pupils };
}

function makeBlush(parent: THREE.Group, y = -0.02, z = 0.78): void {
  const mat = new THREE.MeshStandardMaterial({ color: 0xf9a8d4, roughness: 0.9 });
  for (const x of [-0.52, 0.52]) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), mat);
    b.scale.set(1.4, 0.8, 0.5);
    b.position.set(x, y, z);
    parent.add(b);
  }
}

function blink(eyes: Eyes, t: number, mood: PetMood): void {
  const closed = mood === 'sleeping';
  const shutting = !closed && t % 3.6 < 0.14;
  const s = closed || shutting ? 0.12 : 1;
  for (const w of eyes.whites) w.scale.set(1, s, 1);
  for (const p of eyes.pupils) {
    p.scale.set(1, s, 1);
    p.visible = s > 0.2;
  }
}

interface InterState {
  leanX: number;
  leanY: number;
  bounce: number;
  hovering: boolean;
}

function themeDim(): number {
  try {
    const th = document.documentElement.dataset.theme || 'light';
    return th === 'light' || th === 'porcelain' ? 1 : 0.82;
  } catch {
    return 1;
  }
}

function shade(hex: string, f: number): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(f);
}

interface BuiltPet {
  group: THREE.Group;
  tick: (t: number, mood: PetMood) => void;
  dispose: () => void;
}

function baseLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8aa8, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbfa8ff, 0.5);
  rim.position.set(-4, 2, -3);
  scene.add(rim);
}

function trackDisposables(group: THREE.Group): () => void {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      if (mesh.geometry) geos.add(mesh.geometry);
      const m = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((x) => mats.add(x));
      else if (m) mats.add(m);
    }
  });
  return () => {
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
  };
}

/* ------------------------------------------------------------------ */
/* pet builders                                                        */
/* ------------------------------------------------------------------ */

function buildKriyaDot(dim: number): BuiltPet {
  const group = new THREE.Group();
  const bodyGeo = new THREE.IcosahedronGeometry(1, 4);
  displace(bodyGeo, 0.09);
  const body = new THREE.Mesh(bodyGeo, clay(shade('#4256c8', dim)));
  group.add(body);

  // Eight stubby arms, each holding a tiny tool.
  const arms: THREE.Group[] = [];
  const armMat = clay(shade('#4256c8', dim * 0.92));
  const toolMat = clay(shade('#8b9bf5', dim), 0.5);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const arm = new THREE.Group();
    const seg = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.34, 6, 12), armMat);
    seg.position.y = 0.24;
    arm.add(seg);
    const tool = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), toolMat);
    tool.position.y = 0.48;
    tool.rotation.set(0.4, a, 0.2);
    arm.add(tool);
    arm.position.set(Math.cos(a) * 0.95, -0.1 + (i % 2) * 0.35, Math.sin(a) * 0.95);
    arm.rotation.z = -Math.cos(a) * 1.15;
    arm.rotation.x = Math.sin(a) * 1.15;
    group.add(arm);
    arms.push(arm);
  }

  const eyes = makeEyes();
  group.add(eyes.group);
  makeBlush(group);

  const tick = (t: number, mood: PetMood) => {
    const speed = mood === 'sleeping' ? 0.45 : mood === 'working' ? 1.7 : 1;
    const br = 1 + Math.sin(t * 2.1 * speed) * 0.028;
    body.scale.set(br, 1 / Math.sqrt(br), br);
    group.position.y = Math.sin(t * 1.7 * speed) * 0.07 + (mood === 'sleeping' ? -0.18 : 0);
    arms.forEach((arm, i) => {
      arm.rotation.y = Math.sin(t * (mood === 'working' ? 6 : 2.6) + i * 0.9) * 0.35;
    });
    if (mood === 'thinking') group.rotation.z = 0.14;
    else if (mood === 'error') group.position.x = Math.sin(t * 28) * 0.05;
    else group.rotation.z = 0;
    if (mood !== 'error') group.position.x = 0;
    blink(eyes, t, mood);
  };
  return { group, tick, dispose: trackDisposables(group) };
}

function buildOcky(dim: number): BuiltPet {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 22), clay(shade('#8b5cf6', dim)));
  body.scale.set(1, 0.92, 1);
  group.add(body);

  // Tentacles.
  const tentacles: THREE.Mesh[] = [];
  const tMat = clay(shade('#8b5cf6', dim * 0.9));
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const ten = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.62, 10), tMat);
    ten.position.set(Math.cos(a) * 0.62, -0.85, Math.sin(a) * 0.62);
    ten.rotation.x = Math.PI;
    ten.rotation.z = Math.cos(a) * 0.25;
    group.add(ten);
    tentacles.push(ten);
  }

  // Headlamp.
  const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.18, 14), clay(0x3b3654, 0.5));
  lampBase.position.set(0, 0.98, 0);
  const lampGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xfbbf24, emissive: 0xfbbf24, emissiveIntensity: 1.6 }),
  );
  lampGlow.position.set(0, 1.08, 0);
  group.add(lampBase, lampGlow);

  const eyes = makeEyes();
  eyes.group.position.y = 0.1;
  group.add(eyes.group);
  makeBlush(group, 0.02);

  const tick = (t: number, mood: PetMood) => {
    const speed = mood === 'sleeping' ? 0.45 : 1;
    group.position.y = Math.sin(t * 1.5 * speed) * 0.09 + (mood === 'sleeping' ? -0.15 : 0.05);
    group.rotation.y = Math.sin(t * 0.5) * 0.25;
    tentacles.forEach((ten, i) => {
      ten.rotation.x = Math.PI + Math.sin(t * 2.4 + i * 1.1) * 0.22;
    });
    lampGlow.material.emissiveIntensity = 1.3 + Math.sin(t * 3) * 0.4;
    if (mood === 'thinking') group.rotation.z = 0.12;
    else group.rotation.z = 0;
    blink(eyes, t, mood);
  };
  return { group, tick, dispose: trackDisposables(group) };
}

function buildNubi(dim: number): BuiltPet {
  const group = new THREE.Group();
  const mat = clay(shade('#f1efff', dim), 0.95);
  const puffs: Array<[number, number, number, number]> = [
    [0, 0.15, 0, 0.72], [-0.62, -0.05, 0, 0.5], [0.62, -0.05, 0, 0.5],
    [-0.3, 0.5, 0, 0.46], [0.3, 0.5, 0, 0.46],
  ];
  for (const [x, y, z, r] of puffs) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 16), mat);
    p.position.set(x, y, z);
    group.add(p);
  }
  // Rainbow frill.
  const frillColors = [0xf9a8d4, 0xfda4af, 0xfcd34d, 0xa7f3d0, 0xa5b4fc];
  frillColors.forEach((c, i) => {
    const f = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.055, 10, 18), clay(shade(new THREE.Color(c).getStyle(), dim), 0.7));
    const a = (i / frillColors.length) * Math.PI * 2;
    f.position.set(Math.cos(a) * 0.95, -0.42, Math.sin(a) * 0.3);
    f.rotation.x = Math.PI / 2.4;
    group.add(f);
  });

  const eyes = makeEyes();
  eyes.group.position.set(0, 0.05, 0.55);
  group.add(eyes.group);
  makeBlush(group, -0.12, 1.15);

  const tick = (t: number, mood: PetMood) => {
    const speed = mood === 'sleeping' ? 0.4 : 1;
    group.position.y = Math.sin(t * 1.2 * speed) * 0.12 + 0.1;
    group.position.x = Math.sin(t * 0.7) * 0.08;
    group.rotation.z = Math.sin(t * 0.9) * 0.06;
    const br = 1 + Math.sin(t * 1.8 * speed) * 0.02;
    group.scale.set(br, br, br);
    blink(eyes, t, mood);
  };
  return { group, tick, dispose: trackDisposables(group) };
}

function buildPlip(dim: number): BuiltPet {
  const group = new THREE.Group();
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 20; i++) {
    const u = i / 20;
    // Teardrop profile: point at top, round at bottom.
    const r = Math.sin(u * Math.PI) * (1 - u * 0.55) * 0.95;
    pts.push(new THREE.Vector2(Math.max(r, 0.001), (u - 0.5) * 1.9));
  }
  const dropGeo = new THREE.LatheGeometry(pts, 26);
  displace(dropGeo, 0.03);
  const body = new THREE.Mesh(dropGeo, clay(shade('#2dd4bf', dim), 0.6));
  group.add(body);

  const arms: THREE.Group[] = [];
  const armMat = clay(shade('#2dd4bf', dim * 0.9), 0.6);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const arm = new THREE.Group();
    const seg = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.4, 6, 10), armMat);
    seg.position.y = 0.26;
    arm.add(seg);
    arm.position.set(Math.cos(a) * 0.8, -0.15, Math.sin(a) * 0.8);
    arm.rotation.z = -Math.cos(a) * 1.3;
    arm.rotation.x = Math.sin(a) * 1.3;
    group.add(arm);
    arms.push(arm);
  }

  const eyes = makeEyes();
  eyes.group.position.y = -0.1;
  group.add(eyes.group);
  makeBlush(group, -0.28, 0.72);

  const tick = (t: number, mood: PetMood) => {
    const energetic = mood === 'working' || mood === 'happy';
    const speed = mood === 'sleeping' ? 0.4 : energetic ? 2.2 : 1.3;
    // Plip cannot sit still: constant squash-and-stretch.
    const sq = Math.sin(t * 3.2 * speed);
    body.scale.set(1 + sq * 0.05, 1 - sq * 0.06, 1 + sq * 0.05);
    group.position.y = Math.abs(Math.sin(t * 2.4 * speed)) * 0.16 + (mood === 'sleeping' ? -0.2 : 0);
    arms.forEach((arm, i) => {
      arm.rotation.y = Math.sin(t * 5 * speed + i * 1.3) * 0.5;
    });
    blink(eyes, t, mood);
  };
  return { group, tick, dispose: trackDisposables(group) };
}

function buildBolt(dim: number): BuiltPet {
  const group = new THREE.Group();
  const hull = clay(shade('#64748b', dim), 0.45);
  const dark = clay(shade('#334155', dim), 0.6);
  const accent = new THREE.MeshStandardMaterial({ color: shade('#f97316', dim), roughness: 0.4, metalness: 0.3 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.25, 0.9), hull);
  group.add(torso);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.06), accent);
  chest.position.set(0, 0.1, 0.46);
  group.add(chest);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.62, 0.72), hull);
  head.position.y = 1.02;
  group.add(head);
  // LED eyes.
  const ledMat = new THREE.MeshStandardMaterial({ color: 0x67e8f9, emissive: 0x22d3ee, emissiveIntensity: 2 });
  const leds: THREE.Mesh[] = [];
  for (const x of [-0.2, 0.2]) {
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.05), ledMat);
    led.position.set(x, 1.06, 0.37);
    group.add(led);
    leds.push(led);
  }
  // Antenna.
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8), dark);
  ant.position.y = 1.58;
  group.add(ant);
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xf97316, emissive: 0xf97316, emissiveIntensity: 1.8 }),
  );
  tip.position.y = 1.86;
  group.add(tip);
  // Treads.
  for (const x of [-0.42, 0.42]) {
    const tread = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 1.0), dark);
    tread.position.set(x, -0.78, 0);
    group.add(tread);
  }
  // Arms.
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.8, 0.22), hull);
  armL.position.set(-0.72, 0.1, 0);
  const armR = armL.clone();
  armR.position.x = 0.72;
  group.add(armL, armR);

  const tick = (t: number, mood: PetMood) => {
    group.position.y = Math.sin(t * 2) * 0.03 + 0.1;
    head.rotation.y = Math.sin(t * 0.8) * (mood === 'thinking' ? 0.5 : 0.2);
    const active = mood === 'working' || mood === 'happy';
    ledMat.emissiveIntensity = active ? 2.6 + Math.sin(t * 8) * 0.8 : 2;
    tip.material.emissiveIntensity = 1.4 + Math.sin(t * 3) * 0.5;
    armL.rotation.z = 0.15 + Math.sin(t * (active ? 6 : 2)) * 0.2;
    armR.rotation.z = -0.15 - Math.sin(t * (active ? 6 : 2) + 1) * 0.2;
    if (mood === 'error') group.position.x = Math.sin(t * 26) * 0.04;
    else group.position.x = 0;
  };
  return { group, tick, dispose: trackDisposables(group) };
}

function buildWisp(dim: number): BuiltPet {
  const group = new THREE.Group();
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 20; i++) {
    const u = i / 20;
    // Flame/wisp profile: wide soft base tapering to a curling tip.
    const r = Math.sin(u * Math.PI * 0.92) * (0.85 - u * 0.45) + 0.02;
    pts.push(new THREE.Vector2(Math.max(r, 0.001), (u - 0.35) * 2.1));
  }
  const geo = new THREE.LatheGeometry(pts, 24);
  displace(geo, 0.06);
  const mat = new THREE.MeshPhysicalMaterial({
    color: shade('#c4b5fd', dim),
    roughness: 0.35,
    transparent: true,
    opacity: 0.82,
    emissive: shade('#8b5cf6', dim * 0.7),
    emissiveIntensity: 0.35,
  });
  const body = new THREE.Mesh(geo, mat);
  group.add(body);

  const glow = new THREE.PointLight(0xa78bfa, 6, 6);
  glow.position.set(0, 0.2, 0.6);
  group.add(glow);

  const eyes = makeEyes();
  eyes.group.position.set(0, -0.1, 0.35);
  eyes.group.scale.setScalar(0.85);
  group.add(eyes.group);

  const tick = (t: number, mood: PetMood) => {
    const speed = mood === 'sleeping' ? 0.35 : 0.9;
    group.position.y = Math.sin(t * 1.1 * speed) * 0.16 + 0.12;
    group.position.x = Math.sin(t * 0.6 * speed) * 0.1;
    group.rotation.y = Math.sin(t * 0.5 * speed) * 0.4;
    body.rotation.y = t * 0.4 * speed;
    const br = 1 + Math.sin(t * 1.6 * speed) * 0.04;
    body.scale.set(br, 1, br);
    (mat as THREE.MeshPhysicalMaterial).emissiveIntensity = 0.3 + Math.sin(t * 2.2) * 0.12;
    blink(eyes, t, mood);
  };
  const dispose = () => {
    trackDisposables(group)();
    glow.dispose();
  };
  return { group, tick, dispose };
}

function applyInter(rig: THREE.Group, inter: InterState): void {
  // Lean toward the cursor + bounce impulse from clicks. Applied to an outer
  // rig so it never fights the pet's own body animation.
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

const BUILDERS: Record<PetId, (dim: number) => BuiltPet> = {
  kriyadot: buildKriyaDot,
  ocky: buildOcky,
  nubi: buildNubi,
  plip: buildPlip,
  bolt: buildBolt,
  wisp: buildWisp,
};

/* ------------------------------------------------------------------ */
/* renderer (WebGPU where available, WebGL2 fallback)                  */
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
    } catch {
      /* fall through to WebGL */
    }
  }
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  return r as unknown as AnyRenderer;
}

/* ------------------------------------------------------------------ */
/* component                                                           */
/* ------------------------------------------------------------------ */

export function Pet3D({ pet, mood = 'idle', size = 140, className = '', label, interactive = true }: Pet3DProps) {
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
    let built: BuiltPet | null = null;
    let rafPaused = true;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const boot = async () => {
      renderer = await makeRenderer(canvas);
      if (disposed || !renderer) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(size, size);

      const scene = new THREE.Scene();
      baseLights(scene);
      const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
      camera.position.set(0, 0.4, 5.2);
      camera.lookAt(0, 0.1, 0);

      built = BUILDERS[pet](themeDim());
      const rig = new THREE.Group();
      rig.add(built.group);
      scene.add(rig);

      const clock = new THREE.Clock();
      const inter = interRef.current;

      const frame = () => {
        if (!renderer || !built) return;
        const t = clock.getElapsedTime();
        inter.bounce *= 0.94;
        built.tick(t, moodRef.current);
        applyInter(rig, inter);
        renderer.render(scene, camera);
      };

      if (reduced) {
        frame(); // single static frame
        return;
      }

      const loop = () => {
        if (!rafPaused) frame();
      };
      renderer.setAnimationLoop(loop);

      const io = new IntersectionObserver(
        (entries) => {
          rafPaused = !entries[0]?.isIntersecting || document.hidden;
        },
        { threshold: 0.05 },
      );
      io.observe(mount);
      const onVis = () => {
        rafPaused = document.hidden;
      };
      document.addEventListener('visibilitychange', onVis);

      return () => {
        io.disconnect();
        document.removeEventListener('visibilitychange', onVis);
      };
    };

    let cleanup: (() => void) | undefined;
    boot().then((c) => {
      cleanup = c;
    });

    // Pointer interactivity.
    const onMove = (e: PointerEvent) => {
      if (!interactive) return;
      const r = canvas.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      interRef.current.leanX = Math.max(-1, Math.min(1, nx));
      interRef.current.leanY = Math.max(-1, Math.min(1, -ny));
      interRef.current.hovering = true;
    };
    const onLeave = () => {
      interRef.current.leanX = 0;
      interRef.current.leanY = 0;
      interRef.current.hovering = false;
    };
    const onDown = () => {
      if (!interactive) return;
      interRef.current.bounce = 1; // happy bounce impulse
    };
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
      } catch {
        /* ignore teardown races */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet, size, interactive]);

  return (
    <div
      ref={mountRef}
      className={`pet3d${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, cursor: interactive ? 'pointer' : 'default' }}
      role="img"
      aria-label={label ?? `3D ${pet} companion pet (${mood})`}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}
