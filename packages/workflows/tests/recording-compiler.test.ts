// SPDX-License-Identifier: Apache-2.0
// Tests for the teach-by-recording compiler: recorded computer-view events
// (fixture) -> KriyaDot workflow definition. Zero paid APIs; pure function,
// no network, no filesystem.

import { describe, expect, it } from 'vitest';

import {
  compileComputerRecordingToWorkflow,
  COMPUTER_RECORDED_EVENT_TYPES,
  type ComputerRecordedEvent,
} from '../src/recording-compiler.js';
import type { WorkflowDefinition } from '../src/types.js';

/** Fixture: user clicks a field, types, presses Enter, screenshots — 1s apart. */
function fixtureRecording(): ComputerRecordedEvent[] {
  const t0 = 1_700_000_000_000;
  return [
    { type: 'computer_click', x: 640, y: 480, timestamp: t0 },
    { type: 'computer_type', text: 'hello world', timestamp: t0 + 1000 },
    { type: 'computer_key', key: 'Enter', timestamp: t0 + 2000 },
    { type: 'computer_screenshot', timestamp: t0 + 3000 },
  ];
}

function nodeIds(def: WorkflowDefinition): string[] {
  return def.nodes.map((n) => n.id);
}

describe('compileComputerRecordingToWorkflow', () => {
  it('builds a linear chain: manual trigger -> tool nodes with delay nodes between', () => {
    const def = compileComputerRecordingToWorkflow(fixtureRecording(), {
      name: 'Demo flow',
      workflowId: 'rec-test-1',
    });

    expect(def.id).toBe('rec-test-1');
    expect(def.name).toBe('Demo flow');
    expect(def.description).toContain('4 computer actions');

    const triggers = def.nodes.filter((n) => n.type === 'trigger');
    expect(triggers).toHaveLength(1);
    expect(triggers[0].config['kind']).toBe('manual');

    // 4 action nodes + 3 inter-action delay nodes + trigger = 8 nodes.
    expect(def.nodes).toHaveLength(8);
    expect(new Set(nodeIds(def)).size).toBe(8); // unique ids

    // Linear chain: every edge links the previous node to the next.
    const order = nodeIds(def);
    expect(def.edges).toEqual(order.slice(0, -1).map((id, i) => [id, order[i + 1]]));
    expect(order[0]).toBe('trigger');

    const tools = def.nodes.filter((n) => n.type === 'tool');
    expect(tools.map((n) => n.config['tool'])).toEqual([
      'computer_click',
      'computer_type',
      'computer_key',
      'computer_screenshot',
    ]);
    expect(tools[0].config['args']).toEqual({ x: 640, y: 480 });
    expect(tools[1].config['args']).toEqual({ text: 'hello world' });
    expect(tools[2].config['args']).toEqual({ key: 'Enter' });

    // 1s recorded gaps -> 1s delay nodes.
    const delays = def.nodes.filter((n) => n.type === 'delay');
    expect(delays).toHaveLength(3);
    for (const d of delays) expect(d.config['seconds']).toBe(1);
  });

  it('clamps inter-action delays to [minDelaySeconds, maxDelaySeconds]', () => {
    const t0 = 1_700_000_000_000;
    const events: ComputerRecordedEvent[] = [
      { type: 'computer_click', x: 1, y: 1, timestamp: t0 },
      { type: 'computer_click', x: 2, y: 2, timestamp: t0 + 50 }, // 0.05s -> floor
      { type: 'computer_click', x: 3, y: 3, timestamp: t0 + 50 + 60_000 }, // 60s -> ceiling
    ];
    const def = compileComputerRecordingToWorkflow(events, {
      minDelaySeconds: 0.5,
      maxDelaySeconds: 5,
    });
    const delays = def.nodes.filter((n) => n.type === 'delay');
    expect(delays.map((d) => d.config['seconds'])).toEqual([0.5, 5]);
  });

  it('maps computer_wait events to their own delay nodes', () => {
    const t0 = 1_700_000_000_000;
    const def = compileComputerRecordingToWorkflow(
      [
        { type: 'computer_click', x: 10, y: 20, timestamp: t0 },
        { type: 'computer_wait', ms: 2500, timestamp: t0 + 100 },
        { type: 'computer_key', key: 'Tab', timestamp: t0 + 3000 },
      ],
      { workflowId: 'rec-wait' },
    );
    const delays = def.nodes.filter((n) => n.type === 'delay');
    // explicit 2.5s wait + 2 inter-action delays (0.1s->0.5 floor, 2.9s)
    expect(delays.map((d) => d.config['seconds'])).toEqual([0.5, 2.5, 2.9]);
  });

  it('ignores unknown event types defensively', () => {
    const t0 = 1_700_000_000_000;
    const def = compileComputerRecordingToWorkflow([
      { type: 'computer_click', x: 5, y: 5, timestamp: t0 },
      { type: 'bogus' as unknown as ComputerRecordedEvent['type'], timestamp: t0 + 1000 },
      { type: 'computer_type', text: 'x', timestamp: t0 + 2000 },
    ]);
    const tools = def.nodes.filter((n) => n.type === 'tool');
    expect(tools.map((n) => n.config['tool'])).toEqual(['computer_click', 'computer_type']);
  });

  it('compiles an empty recording to a trigger-only workflow', () => {
    const def = compileComputerRecordingToWorkflow([], { workflowId: 'rec-empty' });
    expect(def.nodes).toHaveLength(1);
    expect(def.nodes[0].type).toBe('trigger');
    expect(def.edges).toEqual([]);
  });

  it('generates a stable id when workflowId is omitted and trims long names', () => {
    const a = compileComputerRecordingToWorkflow(fixtureRecording());
    const b = compileComputerRecordingToWorkflow(fixtureRecording());
    expect(a.id).toMatch(/^recording-[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
    const long = compileComputerRecordingToWorkflow([], { name: 'x'.repeat(200) });
    expect(long.name).toHaveLength(100);
  });

  it('exposes the recorded event type contract', () => {
    expect([...COMPUTER_RECORDED_EVENT_TYPES].sort()).toEqual([
      'computer_click',
      'computer_key',
      'computer_screenshot',
      'computer_type',
      'computer_wait',
    ]);
  });
});
