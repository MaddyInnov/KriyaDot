// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  parseModelProfiles,
  profileModelForProvider,
  resolvePurposeProfile,
} from '../src/model-profiles.js';

describe('parseModelProfiles', () => {
  it('parses purposes and knobs, skipping junk', () => {
    const profiles = parseModelProfiles(
      JSON.stringify({
        supervisor: { providerId: 'groq', modelId: 'gpt-oss-20b', temperature: 0, timeoutMs: 5000 },
        compression: { model: 'openai/gpt-4o-mini' },
        bogus: { modelId: 'x' },
        routing: 'not-an-object',
      }),
    );
    expect(profiles.supervisor).toEqual({
      providerId: 'groq',
      modelId: 'gpt-oss-20b',
      temperature: 0,
      timeoutMs: 5000,
    });
    expect(profiles.compression).toEqual({ providerId: 'openai', modelId: 'gpt-4o-mini' });
    expect(profiles.routing).toBeUndefined();
    expect((profiles as Record<string, unknown>).bogus).toBeUndefined();
  });

  it('returns {} on invalid JSON', () => {
    expect(parseModelProfiles('{nope')).toEqual({});
  });
});

describe('resolvePurposeProfile', () => {
  it('table wins over env, env wins over legacy', () => {
    const env = {
      MODEL_PROFILE_SUPERVISOR: 'groq/env-model',
      REVIEWER_MODEL: 'openai/legacy-model',
    } as NodeJS.ProcessEnv;
    expect(resolvePurposeProfile('supervisor', { env })?.modelId).toBe('env-model');
    expect(
      resolvePurposeProfile('supervisor', {
        env,
        profiles: { supervisor: { providerId: 'anthropic', modelId: 'table-model' } },
      }),
    ).toEqual({ providerId: 'anthropic', modelId: 'table-model' });
    expect(resolvePurposeProfile('reviewer', { env })?.modelId).toBe('legacy-model');
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolvePurposeProfile('triage', { env: {} as NodeJS.ProcessEnv })).toBeUndefined();
  });
});

describe('profileModelForProvider', () => {
  it('matches only when the provider agrees or is unnamed', () => {
    expect(profileModelForProvider({ providerId: 'groq', modelId: 'm' }, 'groq')).toBe('m');
    expect(profileModelForProvider({ providerId: 'groq', modelId: 'm' }, 'openai')).toBeUndefined();
    expect(profileModelForProvider({ modelId: 'm' }, 'anything')).toBe('m');
    expect(profileModelForProvider(undefined, 'groq')).toBeUndefined();
  });
});
