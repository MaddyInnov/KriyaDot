// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent model discovery — probes detected coding-agent CLIs for their
 * available model lists (Codync parity: model selection per agent backend).
 *
 * Security contract (hard rules):
 * - Probes are spawned WITHOUT a shell (argv arrays), with short timeouts,
 *   so a hostile binary cannot hang or inject.
 * - Never throws: every probe failure returns an empty list; the caller
 *   falls back to the provider catalog.
 * - Results are cached per agent id; rescan is explicit, never per-request.
 * - No credential bytes are read; CLIs keep their own auth.
 */

import { execFileSync } from 'node:child_process';
import { loadAgentRegistry, type AgentRegistryEntry } from './agent-detect.js';

export interface AgentModel {
  id: string;
  name: string;
  description?: string;
  /** True when the model supports reasoning effort control. */
  supportsReasoningEffort?: boolean;
  /** True when the model supports a fast/low-latency mode. */
  supportsFastMode?: boolean;
  /** True when the model supports temperature control. */
  supportsTemperature?: boolean;
}

/** Per-agent probe timeout (ms). */
const PROBE_TIMEOUT_MS = 8000;

/** Cache: agent id → models + timestamp. */
const modelCache = new Map<string, { models: AgentModel[]; at: number }>();
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

/** Reasoning-capable model id patterns (OpenAI o-series, etc.). */
const REASONING_PATTERNS = [/\bo\d/i, /\bgpt-5/i, /reasoning/i, /deepseek-r/i, /r1/i];

/** Fast/small model id patterns. */
const FAST_PATTERNS = [/mini/i, /flash/i, /haiku/i, /nano/i, /turbo/i];

function annotateModel(id: string, name?: string): AgentModel {
  return {
    id,
    name: name ?? id,
    supportsReasoningEffort: REASONING_PATTERNS.some((p) => p.test(id)),
    supportsFastMode: FAST_PATTERNS.some((p) => p.test(id)),
    supportsTemperature: true,
  };
}

function safeProbe(bin: string, args: string[]): string | null {
  try {
    const out = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

/** Parse `codex debug models` output into model entries. */
function parseCodexModels(output: string): AgentModel[] {
  const models: AgentModel[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/\b(gpt-[\w.-]+|o\d[\w.-]*)\b/i);
    if (match) {
      const id = match[1].toLowerCase();
      if (!models.some((m) => m.id === id)) models.push(annotateModel(id));
    }
  }
  return models;
}

/** Parse `opencode models` output (provider/model format). */
function parseOpencodeModels(output: string): AgentModel[] {
  const models: AgentModel[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/\b([\w-]+(?:\/[\w.-]+)+)\b/);
    if (match) {
      const id = match[1];
      if (!models.some((m) => m.id === id)) models.push(annotateModel(id));
    }
  }
  return models;
}

/** Generic `--models` / `models` probe: extract plausible model ids. */
function parseGenericModels(output: string): AgentModel[] {
  const models: AgentModel[] = [];
  for (const line of output.split('\n').slice(0, 100)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    const match = trimmed.match(/^([\w][\w./:@-]{2,60})/);
    if (match && /[a-z]/i.test(match[1]) && /\d|gpt|claude|gemini|llama|mistral|o1|o3/i.test(match[1])) {
      const id = match[1];
      if (!models.some((m) => m.id === id)) models.push(annotateModel(id));
    }
  }
  return models.slice(0, 50);
}

/**
 * Discover models for one agent by id. Best-effort: returns [] when the
 * agent is unknown, not installed, or the probe fails. Never throws.
 */
export function discoverAgentModels(agentId: string): AgentModel[] {
  const cached = modelCache.get(agentId);
  if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) return cached.models;

  let models: AgentModel[] = [];
  try {
    const registry = loadAgentRegistry();
    const entry: AgentRegistryEntry | undefined = registry.find((e) => e.id === agentId);
    if (!entry) return [];

    // Find an installed binary for this agent.
    const bin = entry.bins.find((b) => {
      try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [b], {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return true;
      } catch {
        return false;
      }
    });
    if (!bin) return [];

    if (agentId === 'codex') {
      const out = safeProbe(bin, ['debug', 'models']);
      if (out) models = parseCodexModels(out);
    } else if (agentId === 'opencode') {
      const out = safeProbe(bin, ['models']);
      if (out) models = parseOpencodeModels(out);
    } else {
      // Generic: try common model-listing flags.
      for (const args of [['models'], ['--models'], ['model', 'list']]) {
        const out = safeProbe(bin, args);
        if (out && out.trim().length > 0) {
          models = parseGenericModels(out);
          if (models.length > 0) break;
        }
      }
    }
  } catch {
    models = [];
  }

  modelCache.set(agentId, { models, at: Date.now() });
  return models;
}

/** Clear the model cache (e.g. after rescan). */
export function clearModelCache(agentId?: string): void {
  if (agentId) modelCache.delete(agentId);
  else modelCache.clear();
}
