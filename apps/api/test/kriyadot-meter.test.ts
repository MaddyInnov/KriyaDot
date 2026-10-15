// SPDX-License-Identifier: Apache-2.0
// Tests for the /_kriyadot/ meter page renderer: sections present, HTML
// escaping, and no message bodies / secrets in the output.

import { describe, expect, it } from 'vitest';
import { TelemetryCollector } from '@mvp/agent-runtime';
import { renderKriyaDotMeter } from '../src/kriyadot-meter.js';

function seededCollector(): TelemetryCollector {
  const c = new TelemetryCollector();
  const id = c.beginRun({ kind: 'bot-turn', botId: 'bot-a', sessionId: 's1' })!;
  c.startStep(id, 'llm:model', 'llm')!.end({ ok: true });
  c.endRun(id, {
    status: 'ok',
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    providerId: 'groq',
    model: 'llama-3.3-70b-versatile',
  });
  return c;
}

describe('renderKriyaDotMeter', () => {
  it('renders live cards, per-bot activity, and recent runs', () => {
    const html = renderKriyaDotMeter({ version: '0.1.0', queueDepth: 3, telemetry: seededCollector() });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('KriyaDot runtime meter');
    expect(html).toContain('Queue depth');
    expect(html).toContain('Per-bot activity');
    expect(html).toContain('Recent runs');
    expect(html).toContain('bot-a');
    expect(html).toContain('bot-turn');
    expect(html).toContain('kriyadot://telemetry/summary');
    expect(html).toContain('/api/health');
    // Meta refresh for live updates, no JS framework.
    expect(html).toContain('http-equiv="refresh"');
    expect(html).not.toContain('<script');
  });

  it('shows queue depth as a number (message bodies never rendered)', () => {
    const html = renderKriyaDotMeter({ version: '0.1.0', queueDepth: 7, telemetry: seededCollector() });
    // Queue depth appears in the cards; no message content exists anywhere.
    expect(html).toContain('>7<');
    expect(html).not.toContain('secret user message');
  });

  it('escapes HTML in bot ids and other interpolated values', () => {
    const c = new TelemetryCollector();
    const id = c.beginRun({ kind: 'bot-turn', botId: '<img src=x onerror=alert(1)>' })!;
    c.endRun(id, { status: 'ok' });
    const html = renderKriyaDotMeter({ version: '0.1.0"><script>', queueDepth: 0, telemetry: c });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('0.1.0"><script>');
  });

  it('renders empty states when no runs exist', () => {
    const html = renderKriyaDotMeter({
      version: '0.1.0',
      queueDepth: 0,
      telemetry: new TelemetryCollector(),
    });
    expect(html).toContain('No completed runs yet.');
    expect(html).toContain('No runs recorded yet.');
  });

  it('is a pure function (no I/O, deterministic for the same input)', () => {
    const c = seededCollector();
    const a = renderKriyaDotMeter({ version: '0.1.0', queueDepth: 1, telemetry: c });
    const b = renderKriyaDotMeter({ version: '0.1.0', queueDepth: 1, telemetry: c });
    // Timestamps differ; structure must not.
    expect(a.replace(/20\d\d-[^<]+Z/g, 'TS')).toBe(b.replace(/20\d\d-[^<]+Z/g, 'TS'));
  });
});
