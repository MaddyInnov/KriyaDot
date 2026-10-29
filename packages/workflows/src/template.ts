// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal mustache-style template interpolation for workflow configs.
 *
 * Supported placeholders inside strings:
 *   {{input}}                -> the whole run input
 *   {{input.some.path}}      -> dot-path into the run input
 *   {{nodes.<id>.output}}    -> the whole output of node <id>
 *   {{nodes.<id>.output.a.b}} -> dot-path into that node's output
 *   {{item}} / {{item.a.b}}  -> current item (match/loop sub-executions)
 *   {{index}}                -> 0-based item position (match bodies)
 *   {{iteration}}            -> 1-based loop iteration (loop bodies)
 *
 * If a string consists of exactly one placeholder, the resolved value is
 * returned as-is (preserving objects/arrays). Otherwise placeholders are
 * interpolated into the surrounding string (non-strings are JSON-encoded).
 * Unknown paths resolve to an empty string.
 */

export interface TemplateContext {
  input: unknown;
  nodes: Record<string, unknown>;
  /**
   * Current item while a `match` body (or `loop` body) executes:
   * `{{item}}` / `{{item.some.path}}`. Undefined outside sub-executions.
   */
  item?: unknown;
  /** 0-based position of `item` in a `match` fan-out: `{{index}}`. */
  index?: number;
  /** 1-based iteration counter inside a `loop`: `{{iteration}}`. */
  iteration?: number;
}

const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const SINGLE_PLACEHOLDER_RE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

function getPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const NODES_OUTPUT_RE = /^nodes\.([^.]+)\.output(?:\.(.+))?$/;

function resolveRef(ref: string, ctx: TemplateContext): unknown {
  if (ref === 'input') return ctx.input;
  if (ref.startsWith('input.')) return getPath(ctx.input, ref.slice('input.'.length));
  if (ref === 'item') return ctx.item;
  if (ref.startsWith('item.')) return getPath(ctx.item, ref.slice('item.'.length));
  if (ref === 'index') return ctx.index;
  if (ref === 'iteration') return ctx.iteration;
  const m = NODES_OUTPUT_RE.exec(ref);
  if (m) {
    const output = ctx.nodes[m[1]];
    if (m[2] === undefined) return output;
    return getPath(output, m[2]);
  }
  return undefined;
}

function stringifyForInterpolation(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function renderString(value: string, ctx: TemplateContext): unknown {
  const single = SINGLE_PLACEHOLDER_RE.exec(value);
  if (single) {
    const resolved = resolveRef(single[1], ctx);
    return resolved === undefined ? '' : resolved;
  }
  return value.replace(PLACEHOLDER_RE, (_match, ref: string) =>
    stringifyForInterpolation(resolveRef(ref, ctx)),
  );
}

/**
 * Recursively render templates in any JSON-like value.
 */
export function renderTemplate(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === 'string') return renderString(value, ctx);
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, ctx));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = renderTemplate(val, ctx);
    }
    return out;
  }
  return value;
}
