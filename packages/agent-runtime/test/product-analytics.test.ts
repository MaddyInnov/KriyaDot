// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  ProductAnalytics,
  LocalOnlySink,
  HttpSink,
  redactStack,
  ANALYTICS_EVENTS,
  DEFAULT_ANALYTICS_SETTINGS,
} from '../src/product-analytics.js';

describe('ProductAnalytics — disabled by default', () => {
  it('defaults to off', () => {
    const pa = new ProductAnalytics();
    expect(pa.isEnabled).toBe(false);
    expect(pa.getSettings()).toEqual(DEFAULT_ANALYTICS_SETTINGS);
    pa.dispose();
  });

  it('track() is a no-op when disabled (no queue growth, no throw)', () => {
    const pa = new ProductAnalytics();
    pa.track('bot_created', { botId: 'x' });
    pa.track('workflow_run_started', {});
    expect(pa.queueSize).toBe(0);
    expect(pa.getQueuedEvents()).toEqual([]);
    pa.dispose();
  });

  it('reportCrash() is a no-op when crashReporting is off', () => {
    const pa = new ProductAnalytics();
    pa.reportCrash(new Error('boom'));
    expect(pa.getCrashes()).toEqual([]);
    pa.dispose();
  });

  it('flush() does nothing when disabled', async () => {
    const send = vi.fn();
    const pa = new ProductAnalytics({}, { name: 'spy', send });
    await pa.flush();
    expect(send).not.toHaveBeenCalled();
    pa.dispose();
  });
});

describe('ProductAnalytics — enabled', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function enabledPa() {
    return new ProductAnalytics({ enabled: true });
  }

  it('queues allowlisted events with sanitized scalar properties', () => {
    const pa = enabledPa();
    pa.track('bot_created', { botId: 'scout', provider: 'groq', count: 3, ok: true });
    const events = pa.getQueuedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('bot_created');
    expect(events[0].properties).toEqual({ botId: 'scout', provider: 'groq', count: 3, ok: true });
    expect(typeof events[0].timestamp).toBe('number');
    expect(typeof events[0].sessionId).toBe('string');
    pa.dispose();
  });

  it('rejects unknown event names (allowlist enforcement)', () => {
    const pa = enabledPa();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // @ts-expect-error — intentionally passing an invalid event
    pa.track('user_typed_secret_message', { text: 'hello' });
    expect(pa.queueSize).toBe(0);
    expect(warn).toHaveBeenCalled();
    pa.dispose();
  });

  it('drops nested objects/arrays from properties (scalar-only)', () => {
    const pa = enabledPa();
    pa.track('attachment_added', {
      fileName: 'doc.pdf',
      nested: { secret: 'x' },
      list: [1, 2, 3],
      size: 1024,
    });
    const props = pa.getQueuedEvents()[0].properties;
    expect(props).toEqual({ fileName: 'doc.pdf', size: 1024 });
    pa.dispose();
  });

  it('redacts secret-like property keys', () => {
    const pa = enabledPa();
    pa.track('oauth_connected', {
      provider: 'github',
      apiKey: 'sk-live-12345',
      token: 'tok_abc',
      userId: 'u1',
    });
    const props = pa.getQueuedEvents()[0].properties;
    expect(props.apiKey).toBe('[REDACTED]');
    expect(props.token).toBe('[REDACTED]');
    expect(props.provider).toBe('github');
    expect(props.userId).toBe('u1');
    pa.dispose();
  });

  it('truncates long string properties', () => {
    const pa = enabledPa();
    pa.track('bot_created', { botId: 'x'.repeat(1000) });
    expect(pa.getQueuedEvents()[0].properties.botId).toHaveLength(256);
    pa.dispose();
  });

  it('bounds the queue at 1000 events', () => {
    const pa = enabledPa();
    for (let i = 0; i < 1200; i++) pa.track('bot_created', { i });
    expect(pa.queueSize).toBe(1000);
    pa.dispose();
  });

  it('flush() sends batch to sink and clears queue', async () => {
    const sent: unknown[][] = [];
    const pa = new ProductAnalytics({ enabled: true }, {
      name: 'spy',
      send: async (events) => { sent.push(events); },
    });
    pa.track('bot_created', { botId: 'a' });
    pa.track('bot_created', { botId: 'b' });
    await pa.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    expect(pa.queueSize).toBe(0);
    pa.dispose();
  });

  it('clearQueue() empties the queue', () => {
    const pa = enabledPa();
    pa.track('bot_created', {});
    pa.clearQueue();
    expect(pa.queueSize).toBe(0);
    pa.dispose();
  });

  it('flush() re-queues the batch instead of dropping it on sink failure', async () => {
    let calls = 0;
    const pa = new ProductAnalytics({ enabled: true }, {
      name: 'flaky',
      send: async () => {
        calls += 1;
        throw new Error('endpoint down');
      },
    });
    pa.track('bot_created', { botId: 'a' });
    pa.track('bot_created', { botId: 'b' });
    await pa.flush();
    expect(calls).toBe(1);
    // Nothing lost: both events are back in the queue, in order.
    expect(pa.queueSize).toBe(2);
    expect(pa.getQueuedEvents().map((e) => (e.properties as Record<string, unknown>)['botId'])).toEqual([
      'a',
      'b',
    ]);
    pa.dispose();
  });
});

describe('HttpSink', () => {
  it('POSTs batches as JSON without throwing on failure', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true } as Response;
    });
    const sink = new HttpSink('https://example.com/analytics', fetchFn as unknown as typeof fetch);
    await sink.send([{ event: 'bot_created', properties: {}, timestamp: 1, sessionId: 's' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/analytics');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.events).toHaveLength(1);
  });

  it('never throws on network failure', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('down'); });
    const sink = new HttpSink('https://example.com/x', fetchFn as unknown as typeof fetch);
    await expect(sink.send([])).resolves.toBeUndefined();
  });
});

describe('LocalOnlySink', () => {
  it('is a no-op', async () => {
    const sink = new LocalOnlySink();
    await expect(sink.send([{ event: 'bot_created', properties: {}, timestamp: 1, sessionId: 's' }])).resolves.toBeUndefined();
  });
});

describe('crash reporting', () => {
  it('stores redacted crash records when enabled', () => {
    const pa = new ProductAnalytics({ crashReporting: true });
    const err = new Error('something failed');
    err.stack = `Error: something failed\n    at foo (/home/testuser/secret-project/index.js:10:5)`;
    pa.reportCrash(err);
    const crashes = pa.getCrashes();
    expect(crashes).toHaveLength(1);
    expect(crashes[0].message).toContain('something failed');
    // home dir redacted
    expect(crashes[0].stack).not.toContain('testuser');
    pa.dispose();
  });

  it('redacts secret-like values from crash messages', () => {
    const pa = new ProductAnalytics({ crashReporting: true });
    pa.reportCrash(new Error('request failed with apiKey=sk-live-999'));
    const crashes = pa.getCrashes();
    expect(crashes[0].message).not.toContain('sk-live-999');
    pa.dispose();
  });

  it('bounds crash records at 100', () => {
    const pa = new ProductAnalytics({ crashReporting: true });
    for (let i = 0; i < 150; i++) pa.reportCrash(new Error(`e${i}`));
    expect(pa.getCrashes()).toHaveLength(100);
    pa.dispose();
  });
});

describe('redactStack', () => {
  it('replaces home directory with ~', () => {
    const home = process.env.HOME ?? '';
    if (!home) return;
    const out = redactStack(`at foo (${home}/proj/index.js:10:5)`);
    expect(out).not.toContain(home);
    expect(out).toContain('~');
  });

  it('collapses absolute paths to basename with location', () => {
    const out = redactStack('    at foo (/some/deep/dir/index.js:10:5)');
    expect(out).not.toContain('/some/deep/dir');
    expect(out).toContain('index.js:10:5');
  });
});

describe('ANALYTICS_EVENTS allowlist', () => {
  it('contains only feature-use names (no content-carrying names)', () => {
    // "message" appears in bot_messaged / message_reacted which describe the
    // *action*, not content. What we must never see: prompt text, bodies, content.
    const joined = ANALYTICS_EVENTS.join(' ');
    expect(joined).not.toMatch(/prompt|content|text|body/i);
    // Every event is snake_case action-style
    for (const e of ANALYTICS_EVENTS) {
      expect(e).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
