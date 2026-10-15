// SPDX-License-Identifier: Apache-2.0
// Teach-by-recording: compile a recorded computer-view interaction into a
// reusable KriyaDot workflow definition.
//
// Input contract (produced by the per-bot computer view — workstream A — via
// POST /api/computer/record/:id/events): coordinate-based input events
// captured while the user demonstrates a task in the computer view.
// Each event becomes a node in a linear chain:
//
//   trigger(manual) -> [tool(computer_*) | delay]*
//
// Delay nodes are inserted between consecutive action nodes using the
// recorded inter-event gaps (clamped to [minDelaySeconds, maxDelaySeconds]),
// so the replayed workflow preserves the demonstrator's pacing. Explicit
// `computer_wait` events become their own delay nodes with the recorded
// duration.
//
// The compiled definition passes WorkflowRunner.register() validation
// (exactly one trigger node, acyclic) and its tool nodes reference the
// canonical computer_* tools from @mvp/agent-runtime
// (computer_click/computer_type/computer_key/computer_screenshot), so a saved
// workflow runs through the normal tool + governance path.

import { randomUUID } from 'node:crypto';

import type { WorkflowDefinition, WorkflowNode } from './types.js';

/** Input events recorded from the computer view (coordinate-based). */
export type ComputerRecordedEventType =
  | 'computer_click'
  | 'computer_type'
  | 'computer_key'
  | 'computer_screenshot'
  | 'computer_wait';

export const COMPUTER_RECORDED_EVENT_TYPES: ReadonlySet<ComputerRecordedEventType> = new Set([
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_screenshot',
  'computer_wait',
]);

export interface ComputerRecordedEvent {
  type: ComputerRecordedEventType;
  /** Click coordinates in physical pixels (computer_click). */
  x?: number;
  y?: number;
  /** Text to type (computer_type). */
  text?: string;
  /** Named key to press, e.g. 'Enter' (computer_key). */
  key?: string;
  /** Milliseconds to wait (computer_wait). */
  ms?: number;
  /** Capture timestamp (ms epoch); drives inter-action delay nodes. */
  timestamp: number;
}

export interface RecordingCompilerOptions {
  /** Workflow id; defaults to `recording-<uuid>`. */
  workflowId?: string;
  /** Workflow name; defaults to the recording name. */
  name?: string;
  /** Workflow description; defaults to a recorded-workflow summary. */
  description?: string;
  /** Floor for inter-action delay nodes, seconds. Default 0.5. */
  minDelaySeconds?: number;
  /** Ceiling for inter-action delay nodes, seconds. Default 10. */
  maxDelaySeconds?: number;
}

const DEFAULT_MIN_DELAY_SECONDS = 0.5;
const DEFAULT_MAX_DELAY_SECONDS = 10;

/** Canonical computer-use tool names (mirror @mvp/agent-runtime). */
const COMPUTER_TOOLS = {
  click: 'computer_click',
  type: 'computer_type',
  key: 'computer_key',
  screenshot: 'computer_screenshot',
} as const;

function clampDelay(seconds: number, min: number, max: number): number {
  if (!Number.isFinite(seconds)) return min;
  return Math.min(max, Math.max(min, seconds));
}

function toolNode(id: string, name: string, tool: string, args: Record<string, unknown>): WorkflowNode {
  return { id, type: 'tool', name, config: { tool, args } };
}

/**
 * Map one recorded event to its workflow node. Returns undefined for
 * unknown event types (defensive: the API validates before compiling).
 */
function eventToNode(event: ComputerRecordedEvent, id: string): WorkflowNode | undefined {
  switch (event.type) {
    case 'computer_click':
      return toolNode(id, `Click (${event.x}, ${event.y})`, COMPUTER_TOOLS.click, { x: event.x, y: event.y });
    case 'computer_type':
      return toolNode(id, 'Type text', COMPUTER_TOOLS.type, { text: event.text ?? '' });
    case 'computer_key':
      return toolNode(id, `Press ${event.key ?? 'key'}`, COMPUTER_TOOLS.key, { key: event.key ?? '' });
    case 'computer_screenshot':
      return toolNode(id, 'Screenshot', COMPUTER_TOOLS.screenshot, {});
    case 'computer_wait':
      return { id, type: 'delay', name: 'Wait', config: { seconds: (event.ms ?? 1000) / 1000 } };
    default:
      return undefined;
  }
}

/**
 * Compile recorded computer-view events into a KriyaDot workflow definition.
 *
 * Shape: exactly one manual trigger node, then a linear chain of tool nodes
 * (computer_click / computer_type / computer_key / computer_screenshot) with
 * delay nodes between consecutive actions derived from the recorded
 * inter-event gaps. An empty recording compiles to a trigger-only workflow.
 */
export function compileComputerRecordingToWorkflow(
  events: readonly ComputerRecordedEvent[],
  opts: RecordingCompilerOptions = {},
): WorkflowDefinition {
  const minDelay = opts.minDelaySeconds ?? DEFAULT_MIN_DELAY_SECONDS;
  const maxDelay = opts.maxDelaySeconds ?? DEFAULT_MAX_DELAY_SECONDS;

  const nodes: WorkflowNode[] = [
    { id: 'trigger', type: 'trigger', name: 'Manual trigger', config: { kind: 'manual' } },
  ];
  const edges: [string, string][] = [];

  const actionEvents = events.filter((e) => COMPUTER_RECORDED_EVENT_TYPES.has(e.type));

  let prevId = 'trigger';
  let actionIndex = 0;
  let prevTimestamp: number | undefined;

  for (const event of actionEvents) {
    // Inter-action pacing: delay node between consecutive actions, clamped.
    if (prevTimestamp !== undefined) {
      const gapSeconds = (event.timestamp - prevTimestamp) / 1000;
      const delayId = `delay-${actionIndex}`;
      nodes.push({
        id: delayId,
        type: 'delay',
        name: 'Recorded pause',
        config: { seconds: clampDelay(gapSeconds, minDelay, maxDelay) },
      });
      edges.push([prevId, delayId]);
      prevId = delayId;
    }

    actionIndex += 1;
    const nodeId = `step-${actionIndex}`;
    const node = eventToNode(event, nodeId);
    if (node) {
      nodes.push(node);
      edges.push([prevId, nodeId]);
      prevId = nodeId;
    }
    prevTimestamp = event.timestamp;
  }

  const name = opts.name?.trim() || 'Recorded computer workflow';
  return {
    id: opts.workflowId ?? `recording-${randomUUID()}`,
    name: name.slice(0, 100),
    description:
      opts.description ??
      `Recorded workflow: ${actionEvents.length} computer actions captured from a user demonstration. Trigger manually.`,
    nodes,
    edges,
  };
}
