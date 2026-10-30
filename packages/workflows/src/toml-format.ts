// SPDX-License-Identifier: Apache-2.0

/**
 * TOML variant of the KriyaDot workflow file format (#143).
 *
 * Octomind defines workflows in TOML; this module gives the
 * `kriyadot.workflow` v1 format a TOML serialization alongside the
 * canonical JSON one (src/format.ts):
 *
 * ```toml
 * format = "kriyadot.workflow"
 * version = 1
 *
 * [workflow]
 * id = "wf-toml"
 * name = "TOML workflow"
 * maxParallel = 4
 *
 * [workflow.budget]
 * maxCostUsd = 1.5
 *
 * [[workflow.nodes]]
 * id = "trigger"
 * type = "trigger"
 * name = "Start"
 * config = {}
 *
 * [[workflow.nodes]]
 * id = "draft"
 * type = "agent"
 * name = "Draft"
 * config = { botId = "writer", prompt = "Hi", role = "copywriter", model = "gpt-4o", toolset = ["web_search"], skills = ["seo"] }
 * ```
 *
 * `serializeWorkflowToml` / `parseWorkflowToml` round-trip losslessly
 * for definitions whose values are TOML-representable (strings,
 * finite numbers, booleans, arrays and plain objects). `null` has no
 * TOML equivalent: serializing a definition containing `null` throws
 * a clear error instead of silently dropping the value (the JSON
 * format remains the lossless home for such definitions). Validation
 * is shared with the JSON format — parsing ends by running the same
 * `parseWorkflowFile` checks, so both variants accept exactly the
 * same definitions, including per-step role/model/toolset/skills and
 * the `maxParallel` / `max_parallel` cap (#145).
 */

import { parseWorkflowFile, serializeWorkflow } from './format.js';
import type { WorkflowDefinition } from './types.js';

function fail(message: string): never {
  throw new Error(`workflow TOML: ${message}`);
}

// -- serialization -----------------------------------------------------------

function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function tomlValue(value: unknown, path: string): string {
  if (value === null || value === undefined) {
    fail(`value at ${path} is null/undefined, which TOML cannot represent; use the JSON format for this definition`);
  }
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`value at ${path} is a non-finite number, which TOML cannot represent`);
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => tomlValue(v, `${path}[${i}]`)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v, `${path}.${k}`)}`).join(', ')} }`;
  }
  fail(`value at ${path} has unsupported type ${typeof value}`);
}

/**
 * Serialize a workflow definition to the TOML variant of the
 * KriyaDot workflow file format. The definition is validated with the
 * JSON format's rules first, so invalid definitions throw the usual
 * `workflow file: …` errors.
 */
export function serializeWorkflowToml(def: WorkflowDefinition): string {
  // Validate + detach (canonical field handling lives in format.ts).
  const validated = parseWorkflowFile(serializeWorkflow(def));
  const lines: string[] = [
    '# KriyaDot workflow (TOML variant of the kriyadot.workflow v1 format)',
    'format = "kriyadot.workflow"',
    'version = 1',
    '',
    '[workflow]',
    `id = ${tomlString(validated.id)}`,
    `name = ${tomlString(validated.name)}`,
  ];
  if (validated.description !== undefined) lines.push(`description = ${tomlString(validated.description)}`);
  if (validated.maxParallel !== undefined) lines.push(`maxParallel = ${validated.maxParallel}`);
  lines.push(`edges = ${tomlValue(validated.edges, 'workflow.edges')}`);
  if (validated.budget !== undefined) {
    lines.push('', '[workflow.budget]', `maxCostUsd = ${tomlValue(validated.budget.maxCostUsd, 'workflow.budget.maxCostUsd')}`);
  }
  for (const node of validated.nodes) {
    lines.push('', '[[workflow.nodes]]');
    lines.push(`id = ${tomlString(node.id)}`);
    lines.push(`type = ${tomlString(node.type)}`);
    lines.push(`name = ${tomlString(node.name)}`);
    lines.push(`config = ${tomlValue(node.config ?? {}, `workflow.nodes.${node.id}.config`)}`);
    if (node.retry !== undefined) lines.push(`retry = ${tomlValue(node.retry, `workflow.nodes.${node.id}.retry`)}`);
    if (node.timeoutMs !== undefined) lines.push(`timeoutMs = ${tomlValue(node.timeoutMs, `workflow.nodes.${node.id}.timeoutMs`)}`);
  }
  return lines.join('\n') + '\n';
}

// -- parsing -----------------------------------------------------------------

class TomlParser {
  private pos = 0;
  constructor(private readonly text: string) {}

  parseDocument(): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    let current: Record<string, unknown> = root;
    for (;;) {
      this.skipBlank();
      if (this.pos >= this.text.length) break;
      if (this.text[this.pos] === '[') {
        current = this.parseHeader(root);
      } else {
        const key = this.parseKey();
        this.skipInlineSpace();
        this.expect('=');
        this.skipInlineSpace();
        const value = this.parseValue();
        current[key] = value;
      }
      this.expectLineEnd();
    }
    return root;
  }

  private parseHeader(root: Record<string, unknown>): Record<string, unknown> {
    const isArray = this.text.startsWith('[[', this.pos);
    this.pos += isArray ? 2 : 1;
    const end = this.text.indexOf(isArray ? ']]' : ']', this.pos);
    if (end < 0) fail('unterminated table header');
    const path = this.text.slice(this.pos, end).trim();
    this.pos = end + (isArray ? 2 : 1);
    const parts = path.split('.').map((p) => p.trim().replace(/^"|"$/g, ''));
    if (parts.length === 0 || parts.some((p) => p.length === 0)) fail(`invalid table header: [${path}]`);
    let target: unknown = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      if (Array.isArray(target)) {
        if (target.length === 0) fail(`table header [${path}] has no array element to attach to`);
        target = target[target.length - 1];
      }
      const rec = target as Record<string, unknown>;
      if (isLast && isArray) {
        const existing = rec[part];
        const arr = Array.isArray(existing) ? existing : [];
        const element: Record<string, unknown> = {};
        arr.push(element);
        rec[part] = arr;
        return element;
      }
      if (rec[part] === undefined) rec[part] = {};
      target = rec[part];
    }
    if (Array.isArray(target)) {
      if (target.length === 0) fail(`table header [${path}] has no array element to attach to`);
      return target[target.length - 1] as Record<string, unknown>;
    }
    return target as Record<string, unknown>;
  }

  private parseKey(): string {
    this.skipInlineSpace();
    if (this.text[this.pos] === '"') return this.parseBasicString();
    const start = this.pos;
    while (this.pos < this.text.length && /[A-Za-z0-9_-]/.test(this.text[this.pos]!)) this.pos++;
    if (this.pos === start) fail(`expected a key at offset ${start}`);
    return this.text.slice(start, this.pos);
  }

  private parseValue(): unknown {
    const ch = this.text[this.pos];
    if (ch === '"') return this.parseBasicString();
    if (ch === "'") return this.parseLiteralString();
    if (ch === '[') return this.parseArray();
    if (ch === '{') return this.parseInlineTable();
    // Bare scalar: read to end of line / `,` / `]` / `}` / `#`.
    const start = this.pos;
    while (this.pos < this.text.length && !/[\n,\]}#]/.test(this.text[this.pos]!)) this.pos++;
    const raw = this.text.slice(start, this.pos).trim();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const num = Number(raw.replace(/_/g, ''));
    if (raw.length > 0 && Number.isFinite(num)) return num;
    fail(`unsupported TOML value: ${raw}`);
  }

  private parseBasicString(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) fail('unterminated string');
      const ch = this.text[this.pos]!;
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch === '\\') {
        const esc = this.text[this.pos + 1];
        const map: Record<string, string> = {
          n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f',
        };
        if (esc === 'u') {
          out += String.fromCodePoint(parseInt(this.text.slice(this.pos + 2, this.pos + 6), 16));
          this.pos += 6;
        } else if (esc === 'U') {
          out += String.fromCodePoint(parseInt(this.text.slice(this.pos + 2, this.pos + 10), 16));
          this.pos += 10;
        } else if (esc !== undefined && map[esc] !== undefined) {
          out += map[esc];
          this.pos += 2;
        } else {
          fail(`invalid string escape: \\${esc ?? ''}`);
        }
        continue;
      }
      if (ch === '\n') fail('unterminated string (newline in basic string)');
      out += ch;
      this.pos++;
    }
  }

  private parseLiteralString(): string {
    this.expect("'");
    const end = this.text.indexOf("'", this.pos);
    if (end < 0) fail('unterminated literal string');
    const out = this.text.slice(this.pos, end);
    this.pos = end + 1;
    return out;
  }

  private parseArray(): unknown[] {
    this.expect('[');
    const out: unknown[] = [];
    for (;;) {
      this.skipBlank();
      if (this.text[this.pos] === ']') {
        this.pos++;
        return out;
      }
      out.push(this.parseValue());
      this.skipBlank();
      if (this.text[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.text[this.pos] === ']') {
        this.pos++;
        return out;
      }
      fail(`expected ',' or ']' in array at offset ${this.pos}`);
    }
  }

  private parseInlineTable(): Record<string, unknown> {
    this.expect('{');
    const out: Record<string, unknown> = {};
    for (;;) {
      this.skipBlank();
      if (this.text[this.pos] === '}') {
        this.pos++;
        return out;
      }
      const key = this.parseKey();
      this.skipInlineSpace();
      this.expect('=');
      this.skipInlineSpace();
      out[key] = this.parseValue();
      this.skipBlank();
      if (this.text[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.text[this.pos] === '}') {
        this.pos++;
        return out;
      }
      fail(`expected ',' or '}' in inline table at offset ${this.pos}`);
    }
  }

  private skipBlank(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos++;
        continue;
      }
      if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++;
        continue;
      }
      break;
    }
  }

  private skipInlineSpace(): void {
    while (this.text[this.pos] === ' ' || this.text[this.pos] === '\t') this.pos++;
  }

  private expect(ch: string): void {
    if (this.text[this.pos] !== ch) fail(`expected '${ch}' at offset ${this.pos}`);
    this.pos++;
  }

  private expectLineEnd(): void {
    this.skipInlineSpace();
    if (this.text[this.pos] === '#') {
      while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++;
    }
    if (this.pos < this.text.length && this.text[this.pos] !== '\n' && this.text[this.pos] !== '\r') {
      fail(`expected end of line at offset ${this.pos}`);
    }
  }
}

/**
 * Parse the TOML variant of a KriyaDot workflow file. Returns the
 * validated definition (same validation as the JSON format). Throws
 * with a `workflow TOML: …` or `workflow file: …` message on any
 * violation.
 */
export function parseWorkflowToml(text: string): WorkflowDefinition {
  if (typeof text !== 'string') fail('input must be a TOML string');
  let doc: Record<string, unknown>;
  try {
    doc = new TomlParser(text).parseDocument();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('workflow TOML:')) throw err;
    fail(err instanceof Error ? err.message : String(err));
  }
  // Shared validation/normalization with the JSON format.
  return parseWorkflowFile(doc);
}
