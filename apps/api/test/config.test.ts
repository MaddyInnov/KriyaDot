// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, parsePublicBaseUrl } from '../src/config.js';

describe('parsePublicBaseUrl', () => {
  it('accepts a clean https URL', () => {
    expect(parsePublicBaseUrl('https://kriyadot.example.com')).toBe('https://kriyadot.example.com');
  });

  it('strips trailing slashes', () => {
    expect(parsePublicBaseUrl('https://kriyadot.example.com///')).toBe('https://kriyadot.example.com');
  });

  it('lowercases scheme and host but keeps the path', () => {
    expect(parsePublicBaseUrl('HTTPS://KriyaDot.Example.COM/app')).toBe('https://kriyadot.example.com/app');
  });

  it('keeps an explicit port', () => {
    expect(parsePublicBaseUrl('https://kriyadot.example.com:8443')).toBe('https://kriyadot.example.com:8443');
  });

  it('accepts http (with a cleartext warning) so LAN tunnels still work', () => {
    expect(parsePublicBaseUrl('http://192.168.1.5:4000')).toBe('http://192.168.1.5:4000');
  });

  it('rejects missing or malformed values', () => {
    expect(parsePublicBaseUrl(undefined)).toBeUndefined();
    expect(parsePublicBaseUrl('')).toBeUndefined();
    expect(parsePublicBaseUrl('   ')).toBeUndefined();
    expect(parsePublicBaseUrl('not-a-url')).toBeUndefined();
    expect(parsePublicBaseUrl('ftp://x.example.com')).toBeUndefined();
    expect(parsePublicBaseUrl('https://')).toBeUndefined();
    expect(parsePublicBaseUrl('https://exa mple.com')).toBeUndefined();
  });
});

describe('loadConfig KRIYADOT_PUBLIC_URL', () => {
  const OLD = process.env.KRIYADOT_PUBLIC_URL;
  afterEach(() => {
    if (OLD === undefined) delete process.env.KRIYADOT_PUBLIC_URL;
    else process.env.KRIYADOT_PUBLIC_URL = OLD;
  });

  it('exposes publicBaseUrl from the environment', () => {
    process.env.KRIYADOT_PUBLIC_URL = 'https://kriyadot.example.com/';
    expect(loadConfig().publicBaseUrl).toBe('https://kriyadot.example.com');
  });

  it('is undefined when the env var is absent', () => {
    delete process.env.KRIYADOT_PUBLIC_URL;
    expect(loadConfig().publicBaseUrl).toBeUndefined();
  });
});
