// SPDX-License-Identifier: Apache-2.0
// Domain-bound egress (#122): a tool's egress scope can be bound to a
// domain allowlist. Enforcement is fail-closed when a binding exists
// and the destination is unknown or off-list; unbound tools keep the
// pre-#122 boolean behaviour.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  McpScopeStore,
  domainMatchesAllowlist,
  extractEgressHost,
  parseScopePatch,
} from '../src/mcp-scopes.js';

function store(): McpScopeStore {
  const dir = mkdtempSync(join(tmpdir(), 'scopes-'));
  return new McpScopeStore(join(dir, 'scopes.db'));
}

describe('domain allowlist matching', () => {
  it('matches exact hosts and *.suffix wildcards (incl. bare domain)', () => {
    expect(domainMatchesAllowlist('api.example.com', ['api.example.com'])).toBe(true);
    expect(domainMatchesAllowlist('API.example.com', ['api.example.com'])).toBe(true);
    expect(domainMatchesAllowlist('deep.api.example.com', ['*.example.com'])).toBe(true);
    expect(domainMatchesAllowlist('example.com', ['*.example.com'])).toBe(true);
    expect(domainMatchesAllowlist('example.com.evil.net', ['*.example.com'])).toBe(false);
    expect(domainMatchesAllowlist('other.org', ['api.example.com'])).toBe(false);
  });

  it('extracts hosts from conventional URL args', () => {
    expect(extractEgressHost({ url: 'https://hooks.slack.com/services/T1' })).toBe('hooks.slack.com');
    expect(extractEgressHost({ endpoint: 'api.example.com/v1' })).toBe('api.example.com');
    expect(extractEgressHost({ path: '/tmp/x' })).toBeUndefined();
    expect(extractEgressHost(undefined)).toBeUndefined();
  });
});

describe('McpScopeStore domain binding', () => {
  it('persists domains and enforces them in checkEgress', () => {
    const s = store();
    s.set('web_fetch', { domains: ['*.example.com', 'hooks.slack.com'] });
    expect(s.get('web_fetch').domains).toEqual(['*.example.com', 'hooks.slack.com']);
    expect(s.listOverrides()[0]?.scopes.domains).toEqual(['*.example.com', 'hooks.slack.com']);

    expect(s.checkEgress('web_fetch', { url: 'https://docs.example.com/a' }).granted).toBe(true);
    expect(s.checkEgress('web_fetch', { url: 'https://hooks.slack.com/x' }).granted).toBe(true);
    const denied = s.checkEgress('web_fetch', { url: 'https://evil.net/steal' });
    expect(denied.granted).toBe(false);
    expect(denied.host).toBe('evil.net');
    // Fail-closed when the destination cannot be determined.
    expect(s.checkEgress('web_fetch', { q: 'no url here' }).granted).toBe(false);
    s.close();
  });

  it('unbound tools keep boolean behaviour; clearing the binding restores it', () => {
    const s = store();
    expect(s.checkEgress('web_fetch', { url: 'https://anything.net/' }).granted).toBe(true);
    s.set('web_fetch', { domains: ['only.example.com'] });
    expect(s.checkEgress('web_fetch', { url: 'https://anything.net/' }).granted).toBe(false);
    s.set('web_fetch', { domains: [] });
    expect(s.get('web_fetch').domains).toBeUndefined();
    expect(s.checkEgress('web_fetch', { url: 'https://anything.net/' }).granted).toBe(true);
    // Egress toggle still dominates.
    s.set('web_fetch', { egress: false });
    expect(s.checkEgress('web_fetch', { url: 'https://only.example.com/' }).granted).toBe(false);
    s.close();
  });

  it('parseScopePatch accepts domains and rejects bad shapes', () => {
    expect(parseScopePatch({ domains: ['a.com'] })).toEqual({ domains: ['a.com'] });
    expect(parseScopePatch({ egress: true, domains: [] })).toEqual({ egress: true, domains: [] });
    expect(() => parseScopePatch({ domains: 'a.com' })).toThrow(/domains/);
    expect(() => parseScopePatch({ domains: [''] })).toThrow(/domains/);
    expect(() => parseScopePatch({})).toThrow(/at least one of/);
  });
});
