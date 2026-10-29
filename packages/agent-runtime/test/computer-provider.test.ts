// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { isComputerProvider, resolveComputerProvider, surfaceForComputerBackend } from '../src/tools/computer-surfaces.js';

describe('resolveComputerProvider', () => {
  it('per-bot config wins over env', () => {
    const r = resolveComputerProvider({ configProvider: 'playwright', env: { COMPUTER_USE_DOCKER: '1' } as NodeJS.ProcessEnv });
    expect(r).toMatchObject({ backend: 'playwright', source: 'config' });
  });
  it('env is the fallback when config is auto/absent', () => {
    expect(resolveComputerProvider({ env: { COMPUTER_USE_DOCKER: '1' } as NodeJS.ProcessEnv })).toMatchObject({ backend: 'docker', source: 'env' });
    expect(resolveComputerProvider({ configProvider: 'auto', env: { COMPUTER_USE_PLAYWRIGHT: '1' } as NodeJS.ProcessEnv })).toMatchObject({ backend: 'playwright', source: 'env' });
    expect(resolveComputerProvider({ env: { COMPUTER_USE_REAL: '1' } as NodeJS.ProcessEnv })).toMatchObject({ backend: 'desktop', source: 'env' });
  });
  it('auto defaults to the safe mock', () => {
    expect(resolveComputerProvider({ env: {} as NodeJS.ProcessEnv })).toMatchObject({ backend: 'mock', source: 'auto' });
  });
  it('surface off reports unavailable', () => {
    expect(resolveComputerProvider({ configProvider: 'docker', surface: 'off', env: {} as NodeJS.ProcessEnv })).toMatchObject({ backend: null, source: 'unavailable' });
  });
  it('validates provider names and maps backends to surfaces', () => {
    expect(isComputerProvider('desktop')).toBe(true);
    expect(isComputerProvider('vps')).toBe(false);
    expect(surfaceForComputerBackend('playwright')).toBe('browser');
    expect(surfaceForComputerBackend('docker')).toBe('docker');
    expect(surfaceForComputerBackend('mock')).toBe('local');
  });
});
