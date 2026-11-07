// SPDX-License-Identifier: Apache-2.0
// Pure-config tests for the 3D pets (no WebGL needed — Pet3D.tsx's scene
// code only runs in the browser; this covers the static contract).

import { describe, expect, it } from 'vitest';
import {
  PET3D_CONFIG,
  PET3D_IDS,
  PET_CELEBRATION_DURATION_S,
  PET_SPEAKING_CADENCE_HZ,
  petMoodPose,
} from './Pet3D';
import { HOLO3D_CONFIG, holoMoodVisual } from './Hologram3D';
import { PETS, type PetId, type PetMood } from '../../lib/pet';

const HEX = /^#[0-9a-f]{6}$/i;

describe('Pet3D config', () => {
  it('covers exactly the pets that have a 3D builder (drawn pets + legacy kriyadot)', () => {
    expect([...PET3D_IDS].sort()).toEqual(['bolt', 'kriyadot', 'nubi', 'ocky', 'plip', 'wisp']);
    expect(new Set(PET3D_IDS).size).toBe(PET3D_IDS.length);
    // The image pets voxel/droplet have no 3D builder — <Pet> renders them as images.
    const petIds = PETS.map((p) => p.id);
    expect(petIds).toContain('voxel');
    expect(petIds).toContain('droplet');
    expect(PET3D_IDS).not.toContain('voxel');
    expect(PET3D_IDS).not.toContain('droplet');
    expect(PET3D_CONFIG.voxel).toBeUndefined();
    expect(PET3D_CONFIG.droplet).toBeUndefined();
  });

  it('every pet has valid body/accent hex colors and a description', () => {
    for (const id of PET3D_IDS) {
      const cfg = PET3D_CONFIG[id as PetId]!;
      expect(cfg, id).toBeDefined();
      expect(cfg.body, `${id} body`).toMatch(HEX);
      expect(cfg.accent, `${id} accent`).toMatch(HEX);
      expect(cfg.description.length, `${id} description`).toBeGreaterThan(8);
    }
  });

  it('body and accent differ per pet (visual identity)', () => {
    for (const id of PET3D_IDS) {
      const cfg = PET3D_CONFIG[id as PetId]!;
      expect(cfg.body.toLowerCase()).not.toBe(cfg.accent.toLowerCase());
    }
  });
});

describe('Pet3D speaking mood', () => {
  it('uses a speech cadence in the 6-8Hz range', () => {
    expect(PET_SPEAKING_CADENCE_HZ).toBeGreaterThanOrEqual(6);
    expect(PET_SPEAKING_CADENCE_HZ).toBeLessThanOrEqual(8);
  });

  it('produces a small-amplitude talk bob that oscillates over time', () => {
    const samples = [0, 0.02, 0.04, 0.07, 0.11].map((t) => petMoodPose('speaking', t, t));
    for (const pose of samples) {
      expect(Math.abs(pose.offsetY)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(pose.rotationZ)).toBeLessThanOrEqual(0.05);
      expect(pose.rotationY).toBe(0);
      expect(pose.scale).toBe(1);
    }
    // The talk value actually changes (it is driven, not static).
    const talks = new Set(samples.map((p) => p.talk.toFixed(3)));
    expect(talks.size).toBeGreaterThan(1);
  });

  it('is neutral for non-speaking/non-celebrating moods', () => {
    for (const mood of ['idle', 'thinking', 'working', 'happy', 'error', 'sleeping'] as const) {
      expect(petMoodPose(mood, 0.5, 0.5)).toEqual({
        offsetY: 0,
        rotationY: 0,
        rotationZ: 0,
        scale: 1,
        talk: 0,
      });
    }
  });
});

describe('Pet3D celebrating mood', () => {
  it('runs for ~2.4s', () => {
    expect(PET_CELEBRATION_DURATION_S).toBe(2.4);
  });

  it('bounces and spins during the choreography, driven by elapsed time', () => {
    const mid = petMoodPose('celebrating', 0.6, 10);
    expect(mid.offsetY).toBeGreaterThan(0);
    expect(mid.rotationY).toBeGreaterThan(0);
    expect(mid.rotationY).toBeLessThan(Math.PI * 2);
    const late = petMoodPose('celebrating', 2.0, 10);
    expect(late.rotationY).toBeGreaterThan(mid.rotationY);
  });

  it('settles back to neutral once the 2.4s choreography ends', () => {
    for (const elapsed of [PET_CELEBRATION_DURATION_S, 3, 10]) {
      expect(petMoodPose('celebrating', elapsed, elapsed)).toEqual({
        offsetY: 0,
        rotationY: 0,
        rotationZ: 0,
        scale: 1,
        talk: 0,
      });
    }
  });

  it('starts from neutral at elapsed 0', () => {
    const start = petMoodPose('celebrating', 0, 0);
    expect(start.offsetY).toBe(0);
    expect(start.rotationY).toBe(0);
  });
});

describe('Hologram3D pure visual model', () => {
  it('HOLO3D_CONFIG has a sane particle count, disc radius and brand hex colours', () => {
    expect(HOLO3D_CONFIG.particleCount).toBeGreaterThanOrEqual(200);
    expect(HOLO3D_CONFIG.particleCount).toBeLessThanOrEqual(400);
    expect(HOLO3D_CONFIG.discRadius).toBeGreaterThan(0);
    expect(HOLO3D_CONFIG.gold).toMatch(HEX);
    expect(HOLO3D_CONFIG.cyan).toMatch(HEX);
    expect(HOLO3D_CONFIG.violet).toMatch(HEX);
    expect(HOLO3D_CONFIG.gold).toBe('#fbbf24');
    expect(HOLO3D_CONFIG.cyan).toBe('#22d3ee');
    expect(HOLO3D_CONFIG.violet).toBe('#8b5cf6');
  });

  it('orders particle speed working > thinking > idle, with sleeping slower and dimmer', () => {
    const idle = holoMoodVisual('idle', 0, 0);
    const thinking = holoMoodVisual('thinking', 0, 0);
    const working = holoMoodVisual('working', 0, 0);
    const sleeping = holoMoodVisual('sleeping', 0, 0);
    expect(idle.particleSpeed).toBe(1);
    expect(idle.dim).toBe(1);
    expect(idle.burst).toBe(0);
    expect(idle.eqLevel).toBe(0);
    expect(thinking.particleSpeed).toBeGreaterThan(idle.particleSpeed);
    expect(working.particleSpeed).toBeGreaterThan(thinking.particleSpeed);
    expect(sleeping.particleSpeed).toBeLessThan(idle.particleSpeed);
    expect(sleeping.dim).toBeLessThan(0.6);
  });

  it('error shifts hue negative and flickers harder; happy glows brighter than idle', () => {
    const idle = holoMoodVisual('idle', 0, 0);
    const error = holoMoodVisual('error', 0, 0);
    const happy = holoMoodVisual('happy', 0, 0);
    expect(error.hueShift).toBeLessThan(0);
    expect(error.flicker).toBeGreaterThan(idle.flicker);
    expect(happy.glow).toBeGreaterThan(idle.glow);
  });

  it('speaking eqLevel oscillates within [0,1] over t and glows above idle', () => {
    const idle = holoMoodVisual('idle', 0, 0);
    const levels = [0, 0.05, 0.1].map((t) => holoMoodVisual('speaking', t, t).eqLevel);
    for (const level of levels) {
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
    }
    expect(new Set(levels.map((l) => l.toFixed(3))).size).toBeGreaterThan(1);
    expect(holoMoodVisual('speaking', 0, 0).glow).toBeGreaterThan(idle.glow);
  });

  it('celebrating burst starts near 1, decays, and is 0 at/after the celebration duration', () => {
    expect(holoMoodVisual('celebrating', 0, 0).burst).toBeGreaterThan(0.9);
    const early = holoMoodVisual('celebrating', 0.6, 0.6).burst;
    const late = holoMoodVisual('celebrating', 1.8, 1.8).burst;
    expect(late).toBeLessThan(early);
    expect(holoMoodVisual('celebrating', PET_CELEBRATION_DURATION_S, PET_CELEBRATION_DURATION_S).burst).toBe(0);
    expect(holoMoodVisual('celebrating', 3, 3).burst).toBe(0);
    expect(holoMoodVisual('celebrating', 10, 10).burst).toBe(0);
  });

  it('returns all-finite numbers for NaN inputs', () => {
    const visual = holoMoodVisual('idle', NaN, NaN);
    for (const [field, value] of Object.entries(visual)) {
      expect(typeof value, field).toBe('number');
      expect(Number.isFinite(value), field).toBe(true);
    }
  });

  it('returns all-finite numbers for every mood with NaN / negative inputs', () => {
    const moods: PetMood[] = [
      'idle',
      'thinking',
      'working',
      'happy',
      'error',
      'sleeping',
      'speaking',
      'celebrating',
    ];
    for (const mood of moods) {
      for (const visual of [holoMoodVisual(mood, NaN, NaN), holoMoodVisual(mood, -1, -1)]) {
        for (const [field, value] of Object.entries(visual)) {
          expect(Number.isFinite(value), `${mood} ${field}`).toBe(true);
        }
      }
    }
  });
});
