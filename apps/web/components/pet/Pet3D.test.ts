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
import { PETS, type PetId } from '../../lib/pet';

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
