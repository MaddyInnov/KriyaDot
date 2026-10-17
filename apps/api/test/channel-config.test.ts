// SPDX-License-Identifier: Apache-2.0
// Tests for channel config (per-channel richness):
// - GET/PUT /api/messaging/channels persists {instructions, workingFolder, responderRules}
// - channelContextSection renders the instructions into bot context

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelContextSection, createChannelConfigRouter, getChannelConfig, setChannelConfig } from '../src/channel-config.js';

describe('channel config', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chanconf-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists and reads back', () => {
    expect(getChannelConfig(dir, 'telegram').instructions).toBe('');
    setChannelConfig(dir, 'telegram', {
      instructions: 'Be terse.',
      workingFolder: '/tmp/work',
      responderRules: 'Never mention internals.',
    });
    const cfg = getChannelConfig(dir, 'telegram');
    expect(cfg.instructions).toBe('Be terse.');
    expect(cfg.workingFolder).toBe('/tmp/work');
    expect(cfg.responderRules).toBe('Never mention internals.');
  });

  it('channelContextSection renders into bot context', () => {
    setChannelConfig(dir, 'discord', { instructions: 'Use short sentences.' });
    const section = channelContextSection(dir, 'discord');
    expect(section).toContain('Use short sentences.');
    expect(channelContextSection(dir, 'slack')).toBe('');
  });
});

describe('channel config routes', () => {
  let dir: string;
  let baseUrl: string;
  let server: { close(cb: () => void): void } | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chanconf-r-'));
    const app = express();
    app.use(express.json());
    app.use('/api/messaging', createChannelConfigRouter({ dataDir: dir, audit: () => {} }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve()) as unknown as { close(cb: () => void): void };
    });
    const addr = (server as unknown as { address(): AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}/api/messaging`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('PUT then GET round-trips the channel config', async () => {
    const put = await fetch(`${baseUrl}/channels/telegram`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instructions: 'Reply in the chat language.',
        workingFolder: '/data/tg',
        responderRules: 'No disallowed content.',
      }),
    });
    expect(put.status).toBe(200);
    const get = await fetch(`${baseUrl}/channels/telegram`);
    const body = (await get.json()) as { config: { instructions: string } };
    expect(body.config.instructions).toBe('Reply in the chat language.');
  });
});
