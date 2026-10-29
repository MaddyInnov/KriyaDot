// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight in-process JS sandbox for workflow `code` nodes (and `if`
 * condition expressions).
 *
 * Why node:vm instead of packages/agent-runtime's sandbox.ts:
 * `executeSandboxedCommand` there runs *shell commands* inside Docker/E2B —
 * heavyweight (container per node), fail-closed when neither backend exists,
 * and untestable without paid/cloud infra. A workflow function node needs a
 * cheap, deterministic, dependency-free evaluator that works in unit tests.
 * node:vm gives exactly that: a fresh V8 context per evaluation with no host
 * globals (no `require`, `process`, `fetch`, …).
 *
 * Hardening:
 * - A brand-new `vm.createContext` per call: fresh intrinsics, nothing shared
 *   between evaluations.
 * - `input`/`nodes` are seeded *inside* the context realm (serialized to JSON
 *   first), so user code cannot reach host objects via prototype chains
 *   (`input.constructor.constructor('return process')` sees only the
 *   context's own Object/Function).
 * - Synchronous infinite loops are killed by vm's `timeout` option.
 * - Async runaways are bounded by a wall-clock race; the promise returned to
 *   the caller rejects at the deadline. Caveat: a never-settling async loop
 *   keeps its microtask alive in the background after the race rejects —
 *   keep workflow code synchronous (or promptly-awaited) in production.
 * - Output is JSON-size-capped (1 MiB) to bound memory before it hits SQLite.
 */

import vm from 'node:vm';

export const DEFAULT_CODE_TIMEOUT_MS = 5_000;
export const MAX_CODE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1_000_000;

export interface CodeSandboxContext {
  input: unknown;
  nodes: Record<string, unknown>;
  /** Current item in a match/loop sub-execution (`item` in scope). */
  item?: unknown;
  /** 0-based item position in a match body (`index` in scope). */
  index?: number;
  /** 1-based iteration counter in a loop body (`iteration` in scope). */
  iteration?: number;
}

export function resolveCodeTimeoutMs(timeoutMs?: number): number {
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    return Math.min(Math.floor(timeoutMs), MAX_CODE_TIMEOUT_MS);
  }
  return DEFAULT_CODE_TIMEOUT_MS;
}

function toJsonLiteral(value: unknown, label: string): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch {
    throw new Error(`code sandbox: ${label} is not JSON-serializable`);
  }
  return json;
}

/**
 * Evaluate `code` as an async function body with `input` and `nodes` in
 * scope. The completion value (`return …`) is the node's output.
 */
export async function evaluateCode(
  code: string,
  context: CodeSandboxContext,
  timeoutMs?: number,
): Promise<unknown> {
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new Error('code node: config.code must be a non-empty string');
  }
  const timeout = resolveCodeTimeoutMs(timeoutMs);
  const sandbox = vm.createContext(Object.create(null));
  // Seed data inside the context realm (see header for why).
  let seedSource =
    `input = ${toJsonLiteral(context.input, 'input')};\n` +
    `nodes = ${toJsonLiteral(context.nodes, 'nodes')};`;
  // Sub-execution variables (match item / loop iteration) are seeded the
  // same way when the caller provides them, so code bodies can use them.
  if (context.item !== undefined) {
    seedSource += `\nitem = ${toJsonLiteral(context.item, 'item')};`;
  }
  if (context.index !== undefined) {
    seedSource += `\nindex = ${toJsonLiteral(context.index, 'index')};`;
  }
  if (context.iteration !== undefined) {
    seedSource += `\niteration = ${toJsonLiteral(context.iteration, 'iteration')};`;
  }
  const seed = new vm.Script(seedSource, { filename: 'workflow-code-seed.js' });
  seed.runInContext(sandbox, { timeout: 1_000 });

  const script = new vm.Script(`(async () => {\n"use strict";\n${code}\n})()`, {
    filename: 'workflow-code.js',
  });
  let result: unknown;
  try {
    result = script.runInContext(sandbox, { timeout });
  } catch (err) {
    throw new Error(`code node failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`code node timed out after ${timeout}ms`)),
      timeout,
    );
    // Don't hold the process open for a runaway async body.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  let output: unknown;
  try {
    output = await Promise.race([Promise.resolve(result), deadline]);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(output) ?? '', 'utf8');
  } catch {
    throw new Error('code node: output is not JSON-serializable');
  }
  if (size > MAX_OUTPUT_BYTES) {
    throw new Error(`code node: output exceeds ${MAX_OUTPUT_BYTES} bytes`);
  }
  return output;
}

/**
 * Evaluate a boolean condition expression (for `if` nodes) with the same
 * sandbox guarantees. Returns the truthiness of the result.
 */
export async function evaluateCondition(
  expression: string,
  context: CodeSandboxContext,
  timeoutMs = 2_000,
): Promise<boolean> {
  const output = await evaluateCode(`return (${expression});`, context, timeoutMs);
  return Boolean(output);
}
