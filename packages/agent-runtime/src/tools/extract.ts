// SPDX-License-Identifier: Apache-2.0
/**
 * Typed extraction helper (item 11): `extract_values` uses structured
 * output (responseFormat) + the 'extraction' purpose profile to pull
 * typed values from text (and image references described in text) per a
 * caller-supplied JSON Schema. The provider is injected — tests use a
 * mock, production wires the runtime's provider for the profile model.
 */
import type { LLMProvider, ToolDefinition } from '../types.js';
import { resolvePurposeProfile, profileModelForProvider, type ModelProfiles } from '../model-profiles.js';

export interface ExtractHost {
  provider: LLMProvider;
  model?: string;
  profiles?: ModelProfiles;
}
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): string[] {
  const errs: string[] = [];
  const type = schema.type as string | undefined;
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) { errs.push('expected object'); return errs; }
    const req = (schema.required as string[] | undefined) ?? [];
    for (const k of req) if (!(k in (value as Record<string, unknown>))) errs.push(`missing required "${k}"`);
    const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [k, sub] of Object.entries(props)) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined && sub.type && typeof v !== sub.type && !(sub.type==='number' && typeof v==='number')) errs.push(`"${k}" should be ${String(sub.type)}`);
    }
  } else if (type && typeof value !== type) errs.push(`expected ${type}`);
  return errs;
}
export function createExtractTools(host: ExtractHost): ToolDefinition[] {
  return [{
    name: 'extract_values',
    description: 'Extract typed values from text per a JSON Schema you supply. Returns the parsed values validated against the schema. Use for invoices, resumes, forms, screenshots described in text, etc.',
    parameters: { type:'object', properties:{ text:{type:'string'}, schema:{type:'object', description:'JSON Schema for the values to extract'}, imageRef:{type:'string', description:'Optional image reference/URL whose visible content should be treated as source text context'} }, required:['text','schema'] },
    handler: async (args) => {
      const text = typeof args.text === 'string' ? args.text : '';
      const schema = (args.schema && typeof args.schema === 'object') ? args.schema as Record<string, unknown> : null;
      if (!text || !schema) return { error: 'text and schema are required' };
      const profile = resolvePurposeProfile('extraction', { profiles: host.profiles });
      const model = profileModelForProvider(profile, host.provider.providerId) ?? host.model ?? 'default';
      const source = args.imageRef ? `${text}\n[image: ${String(args.imageRef)}]` : text;
      const res = await host.provider.chat(
        [{ role:'system', content:'Extract values exactly per the schema. Reply with exactly one JSON value.' }, { role:'user', content: source }],
        [],
        { model, responseFormat: { type:'json_schema', name:'extraction', schema, strict:false }, temperature: profile?.temperature },
      );
      let parsed: unknown;
      try { parsed = JSON.parse(res.content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); } catch { return { error: 'extraction did not return valid JSON', raw: res.content.slice(0,500) }; }
      const errors = validateAgainstSchema(parsed, schema);
      if (errors.length) return { error: `extracted values failed schema validation: ${errors.join('; ')}`, values: parsed };
      return { values: parsed, model };
    },
  }];
}
