// SPDX-License-Identifier: Apache-2.0
// Structured output for the kriyadot CLI (#108): --schema parsing plus a
// small, dependency-free JSON-Schema validator.
//
// The validator intentionally covers the subset scripts actually use —
// type, required, properties, additionalProperties (boolean), items,
// enum, const, pattern, min/maxLength, minimum/maximum, min/maxItems,
// allOf/anyOf/oneOf, $ref to local #/definitions|#/$defs — and reports
// every violation as a "$.path: message" string. Unknown keywords are
// ignored (documented subset), never treated as failures.
//
// HOST HOOKUP (parent, apps/api/src/cli.ts — NOT this package's file):
// mvp-server's chat command can reuse this exact flow: after its existing
// JSON-parse + one-retry step, run validateJsonSchema(parsed, schema)
// and feed any errors into the same single repair retry it already does.
// The spec shape below mirrors the runtime's StructuredOutputSpec.

export interface StructuredOutputSpec {
  type: 'json_object' | 'json_schema';
  name?: string;
  schema?: Record<string, unknown>;
  strict?: boolean;
}

export class SchemaFlagError extends Error {}

/**
 * Parse a --schema value into a StructuredOutputSpec. Accepts
 * '{"type":"json_object"}', a full json_schema spec, or a bare JSON
 * Schema object (wrapped as json_schema). Mirrors apps/api/src/cli.ts.
 */
export function parseSchemaFlag(raw: string): StructuredOutputSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SchemaFlagError('--schema needs a valid JSON value');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SchemaFlagError('--schema needs a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type === 'json_object') return { type: 'json_object' };
  if (obj.type === 'json_schema') {
    if (typeof obj.schema !== 'object' || obj.schema === null || Array.isArray(obj.schema)) {
      throw new SchemaFlagError('--schema json_schema needs a "schema" object');
    }
    return {
      type: 'json_schema',
      ...(typeof obj.name === 'string' ? { name: obj.name } : {}),
      schema: obj.schema as Record<string, unknown>,
      ...(obj.strict === true ? { strict: true } : {}),
    };
  }
  return { type: 'json_schema', schema: obj };
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number';
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    case 'array':
      return Array.isArray(v);
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    default:
      return true; // unknown type name — subset validator stays permissive
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function resolveRef(
  ref: string,
  root: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!ref.startsWith('#/')) return null;
  let cur: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof cur !== 'object' || cur === null) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'object' && cur !== null && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : null;
}

function validateInto(
  value: unknown,
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root);
    if (target) validateInto(value, target, root, path, errors);
    return;
  }
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const subs = schema[key];
    if (!Array.isArray(subs)) continue;
    if (key === 'allOf') {
      for (const sub of subs) validateInto(value, sub as Record<string, unknown>, root, path, errors);
    } else {
      let okCount = 0;
      for (const sub of subs) {
        const subErrors: string[] = [];
        validateInto(value, sub as Record<string, unknown>, root, path, subErrors);
        if (subErrors.length === 0) okCount += 1;
      }
      if (key === 'anyOf' && okCount === 0) errors.push(`${path}: does not match any anyOf schema`);
      if (key === 'oneOf' && okCount !== 1) errors.push(`${path}: matches ${okCount} oneOf schemas (expected exactly 1)`);
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    errors.push(`${path}: expected constant ${JSON.stringify(schema.const)}`);
  }
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : typeof schema.type === 'string' ? [schema.type] : [];
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    errors.push(`${path}: expected type ${types.join('|')}, got ${typeOf(value)}`);
    return; // deeper checks would be noise against the wrong type
  }
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string') {
      let re: RegExp | null = null;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        re = null;
      }
      if (re && !re.test(value)) errors.push(`${path}: "${value}" does not match pattern ${schema.pattern}`);
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      errors.push(`${path}: ${value} >= exclusiveMaximum ${schema.exclusiveMaximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: more than maxItems ${schema.maxItems}`);
    if (typeof schema.items === 'object' && schema.items !== null && !Array.isArray(schema.items)) {
      value.forEach((item, i) => validateInto(item, schema.items as Record<string, unknown>, root, `${path}[${i}]`, errors));
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as unknown[]) {
        if (typeof key === 'string' && !(key in obj)) errors.push(`${path}: missing required property "${key}"`);
      }
    }
    const props =
      typeof schema.properties === 'object' && schema.properties !== null
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) validateInto(obj[key], sub, root, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path}: unexpected additional property "${key}"`);
      }
    } else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          validateInto(obj[key], schema.additionalProperties as Record<string, unknown>, root, `${path}.${key}`, errors);
        }
      }
    }
  }
}

/** Validate a value against a JSON Schema (subset above). Returns error strings; [] = valid. */
export function validateJsonSchema(value: unknown, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  validateInto(value, schema, schema, '$', errors);
  return errors;
}

/** Extract + JSON-parse a model reply: tolerates a ```json fence and surrounding prose-free JSON. */
export function parseJsonReply(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (e) {
    return { ok: false, error: `reply is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Validate a raw reply against a spec. Returns [] when valid; otherwise
 * the list of problems (JSON parse failure counts as one problem).
 */
export function validateReplyAgainstSpec(content: string, spec: StructuredOutputSpec): string[] {
  const parsed = parseJsonReply(content);
  if (!parsed.ok) return [parsed.error];
  if (spec.type === 'json_object' || !spec.schema) {
    if (typeof parsed.value !== 'object' || parsed.value === null) return ['$: expected a JSON object'];
    return [];
  }
  return validateJsonSchema(parsed.value, spec.schema);
}

/** The single repair-retry prompt fed back to the model after a violation. */
export function buildRepairMessage(spec: StructuredOutputSpec, errors: string[]): string {
  return [
    'Your previous reply did not satisfy the required output schema.',
    'Problems:',
    ...errors.map((e) => `- ${e}`),
    ...(spec.schema ? [`Schema: ${JSON.stringify(spec.schema)}`] : []),
    'Reply with ONLY the corrected JSON value — no prose, no code fence.',
  ].join('\n');
}
