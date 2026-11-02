// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FREE_MODELS_ONLY_ENV_VAR, isFreeModel } from '../src/providers/catalog.js';
import { freeOnlyActive, routeModel } from '../src/routing.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('routeModel', () => {
  it('routes code tasks to a code-capable model', () => {
    const r = routeModel({ taskType: 'code' });
    expect(r.providerId).toBe('groq');
    expect(r.modelId).toBe('gpt-oss-120b');
    expect(r.reason).toContain('code');
  });

  it('routes reasoning tasks to a reasoning-capable model', () => {
    const r = routeModel({ taskType: 'reasoning' });
    expect(r.providerId).toBe('groq');
    expect(r.modelId).toBe('gpt-oss-120b');
    expect(r.reason).toContain('reasoning');
  });

  it('routes chat to the strongest general model', () => {
    const r = routeModel({ taskType: 'chat' });
    expect(r.providerId).toBe('groq');
    expect(r.modelId).toBe('gpt-oss-120b');
    expect(r.reason).toContain('chat');
  });

  it('routes simple-qa to a free ($0) model', () => {
    const r = routeModel({ taskType: 'simple-qa' });
    expect(isFreeModel(r.providerId, r.modelId)).toBe(true);
    expect(r.reason).toMatch(/free/i);
  });

  it('explicit override (provider/model) always wins', () => {
    const r = routeModel({ taskType: 'code', botModel: 'openai/gpt-4o-mini' });
    expect(r.providerId).toBe('openai');
    expect(r.modelId).toBe('gpt-4o-mini');
    expect(r.reason).toContain('override');
  });

  it('explicit override accepts a bare model id', () => {
    const r = routeModel({ taskType: 'simple-qa', botModel: 'gpt-4o-mini' });
    expect(r.providerId).toBe('openai');
    expect(r.modelId).toBe('gpt-4o-mini');
  });

  it('bare model id prefers the direct provider over a templated preset carrying the same id', () => {
    // "gpt-4o" exists both on openai (direct) and on azure-openai as a
    // deployment-name example (templated). The bare id must mean OpenAI.
    const r = routeModel({ taskType: 'chat', botModel: 'gpt-4o' });
    expect(r.providerId).toBe('openai');
    expect(r.modelId).toBe('gpt-4o');
    // The templated preset stays reachable with an explicit provider prefix.
    const az = routeModel({ taskType: 'chat', botModel: 'azure-openai/gpt-4o' });
    expect(az.providerId).toBe('azure-openai');
    expect(az.modelId).toBe('gpt-4o');
  });

  it('override of an unknown model throws (fail closed)', () => {
    expect(() => routeModel({ taskType: 'chat', botModel: 'nope/ghost-9000' })).toThrow(
      /does not match any catalog model/,
    );
    expect(() => routeModel({ taskType: 'chat', botModel: 'ghost-9000' })).toThrow(/not found/);
  });

  it('freeOnly param constrains every task type to free models', () => {
    for (const taskType of ['code', 'chat', 'reasoning', 'simple-qa'] as const) {
      const r = routeModel({ taskType, freeOnly: true });
      expect(isFreeModel(r.providerId, r.modelId)).toBe(true);
      expect(r.reason).toMatch(/free-only/);
    }
  });

  it('FREE_MODELS_ONLY=1 env constrains routing without the param', () => {
    vi.stubEnv(FREE_MODELS_ONLY_ENV_VAR, '1');
    expect(freeOnlyActive()).toBe(true);
    const r = routeModel({ taskType: 'code' });
    expect(isFreeModel(r.providerId, r.modelId)).toBe(true);
    expect(r.providerId).toBe('opencode-zen');
  });

  it('FREE_MODELS_ONLY=true (any case) also activates the guard', () => {
    vi.stubEnv(FREE_MODELS_ONLY_ENV_VAR, 'TRUE');
    expect(freeOnlyActive()).toBe(true);
  });

  it('freeOnly + non-free override throws instead of silently routing paid', () => {
    expect(() =>
      routeModel({ taskType: 'chat', botModel: 'openai/gpt-4o-mini', freeOnly: true }),
    ).toThrow(new RegExp(FREE_MODELS_ONLY_ENV_VAR));
  });

  it('freeOnly + free override still wins', () => {
    const r = routeModel({ taskType: 'code', botModel: 'opencode-zen/big-pickle', freeOnly: true });
    expect(r.providerId).toBe('opencode-zen');
    expect(r.modelId).toBe('big-pickle');
  });

  it('freeOnly env + non-free override throws', () => {
    vi.stubEnv(FREE_MODELS_ONLY_ENV_VAR, '1');
    expect(() => routeModel({ taskType: 'chat', botModel: 'groq/gpt-oss-20b' })).toThrow(
      /not a free model/,
    );
  });

  it('always returns a non-empty reason', () => {
    for (const taskType of ['code', 'chat', 'reasoning', 'simple-qa'] as const) {
      expect(routeModel({ taskType }).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('freeOnlyActive', () => {
  it('is false by default', () => {
    expect(freeOnlyActive()).toBe(false);
    expect(freeOnlyActive(false)).toBe(false);
  });

  it('param wins over env', () => {
    vi.stubEnv(FREE_MODELS_ONLY_ENV_VAR, '1');
    expect(freeOnlyActive(true)).toBe(true);
  });
});
