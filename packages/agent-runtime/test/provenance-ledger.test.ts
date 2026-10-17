// SPDX-License-Identifier: Apache-2.0
// Tests for provenance.ts additions (guarded external messages):
// - OnBehalfOfLedger records + lists relayed messages (who on whose behalf)
// - isRelayedSource / isRelayedOrigin classify origins
// - ProvenanceNote round-trips the relayed flag

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isRelayedOrigin,
  isRelayedSource,
  OnBehalfOfLedger,
  parseProvenanceNote,
  serializeProvenanceNote,
} from '../src/provenance.js';

describe('OnBehalfOfLedger', () => {
  let dir: string;
  let ledger: OnBehalfOfLedger;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'obol-'));
    ledger = new OnBehalfOfLedger(dir);
  });
  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records who sent what on whose behalf', () => {
    const rec = ledger.record({
      messageId: 'm-1',
      source: 'messaging',
      from: 'user-123',
      onBehalfOf: 'channel-abc',
      note: 'inbound telegram message',
    });
    expect(rec.relayed).toBe(true);
    const entry = ledger.get('m-1');
    expect(entry).toMatchObject({ from: 'user-123', onBehalfOf: 'channel-abc' });
    expect(ledger.isRelayed('m-1')).toBe(true);
  });

  it('dedupes repeat records for the same message id', () => {
    const input = { messageId: 'm-2', source: 'webhook' as const, from: 'u', onBehalfOf: 'c' };
    ledger.record(input);
    ledger.record(input);
    expect(ledger.list(10).filter((e) => e.messageId === 'm-2')).toHaveLength(1);
  });
});

describe('relayed classification', () => {
  it('isRelayedSource', () => {
    expect(isRelayedSource('webhook')).toBe(true);
    expect(isRelayedSource('acp')).toBe(true);
    expect(isRelayedSource('email')).toBe(true);
    expect(isRelayedSource('webchat')).toBe(false);
    expect(isRelayedSource('api')).toBe(false);
  });
  it('isRelayedOrigin', () => {
    expect(isRelayedOrigin('webhook')).toBe(true);
    expect(isRelayedOrigin('external')).toBe(true);
    expect(isRelayedOrigin('peer')).toBe(false);
    expect(isRelayedOrigin(undefined)).toBe(false);
  });
});

describe('ProvenanceNote relayed flag', () => {
  it('round-trips through serialize/parse', () => {
    const note = {
      origin: 'external' as const,
      relayPath: ['telegram'],
      relayNames: ['Telegram'],
      timestamp: new Date().toISOString(),
      relayed: true,
    };
    const parsed = parseProvenanceNote(serializeProvenanceNote(note));
    expect(parsed?.relayed).toBe(true);
  });
});
