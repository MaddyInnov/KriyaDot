// SPDX-License-Identifier: Apache-2.0
/**
 * Custom stage-prompt overrides (Laya-inspired, adapted — not copied).
 *
 * `~/.kriyadot/prompts/*.md` hot-reloads pipeline stage prompts without a
 * restart. On stage-prompt resolution, the store checks for an override file
 * named after the stage (`router.md`, `summarizer.md`, `delegate.md`,
 * `governance.md`); when present it wins, otherwise the built-in prompt is
 * used.
 *
 * Hot-reload: every `resolve()` stats the override file and re-reads it when
 * the mtime changed (no restart needed; works even if the process never
 * installs a watcher). `watch()` additionally offers an fs.watch-based
 * push notification for hosts that want immediate callbacks.
 *
 * Boot logging: hosts should call `logActivePromptOverrides()` once at
 * startup so it is always visible which overrides (if any) are live.
 *
 * Security: stage names are sanitized to `[a-z0-9_-]+` so a hostile stage
 * string can never escape the prompts dir (no `../` traversal). Override
 * files are the user's own config in their home dir — they are trusted as
 * much as any other local config (they only change prompt text, never code).
 */

import { existsSync, readdirSync, readFileSync, statSync, watch as fsWatch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Stages with shipped built-in prompts. Hosts may resolve any other stage too (builtin optional). */
export const KNOWN_STAGES = ['router', 'summarizer', 'delegate', 'governance'] as const;
export type KnownStage = (typeof KNOWN_STAGES)[number];

/**
 * Built-in stage prompts (the fallback when no override file exists).
 * Deliberately concise: stage framing for the pipeline step, not bot prose.
 */
export const BUILT_IN_STAGE_PROMPTS: Record<string, string> = {
  router: [
    '# Router',
    'Classify the user request into one task type: code, chat, reasoning, or simple-qa.',
    'Reply with exactly one of: code | chat | reasoning | simple-qa. No other text.',
  ].join('\n'),
  summarizer: [
    '# Summarizer',
    'Summarize the conversation below into a compact running summary for context compaction.',
    'Keep: user goals, decisions made, open questions, and anything the assistant promised to do.',
    'Drop: pleasantries, repeated tool output, and verbatim code. Write in third person, under 400 words.',
  ].join('\n'),
  delegate: [
    '# Delegate',
    'You are handling a subtask for a parent agent. You do not see the parent conversation —',
    'work only from the task text given. Return a self-contained result: what you did, what you found,',
    'and any files you created. Do not ask clarifying questions; make reasonable assumptions and state them.',
  ].join('\n'),
  governance: [
    '# Governance classifier',
    'Classify the proposed tool call as allow, needs-approval, or deny.',
    'Deny: destructive or irreversible actions without explicit user approval, credential exfiltration,',
    'or actions outside the stated task. Otherwise allow low-risk reads; require approval for writes,',
    'network sends, and anything that spends money.',
  ].join('\n'),
};

export interface ResolvedStagePrompt {
  stage: string;
  /** Final prompt text (override or built-in). */
  text: string;
  /** Where the text came from. */
  source: 'override' | 'builtin';
  /** Present when source is 'override'. */
  path?: string;
}

export interface PromptOverrideInfo {
  stage: string;
  path: string;
  mtimeMs: number;
}

/** `~/.kriyadot/prompts` (or the test-provided home dir). */
export function resolvePromptOverridesDir(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.kriyadot', 'prompts');
}

function sanitizeStage(stage: string): string {
  const clean = stage.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(clean)) {
    throw new Error(
      `Invalid stage name "${stage}": use only lowercase letters, digits, "-" and "_" (prevents path traversal).`,
    );
  }
  return clean;
}

interface CacheEntry {
  mtimeMs: number;
  text: string;
}

/**
 * Stage-prompt store with mtime-based hot-reload. Cheap enough to call on
 * every prompt resolution: a stat per call, a re-read only when the file
 * changed.
 */
export class PromptOverrideStore {
  private readonly dir: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: { dir?: string; homeDir?: string } = {}) {
    this.dir = opts.dir ?? resolvePromptOverridesDir(opts.homeDir);
  }

  /** The directory this store reads overrides from. */
  get directory(): string {
    return this.dir;
  }

  private overridePath(stage: string): string {
    return join(this.dir, `${sanitizeStage(stage)}.md`);
  }

  /**
   * Resolve a stage prompt. Override file wins when present; otherwise the
   * built-in (explicit param wins over the shipped default table). Throws
   * when no built-in is available for an unknown stage.
   */
  resolve(stage: string, builtIn?: string): ResolvedStagePrompt {
    const name = sanitizeStage(stage);
    const path = this.overridePath(name);
    let stat: { mtimeMs: number } | undefined;
    try {
      stat = statSync(path);
    } catch {
      stat = undefined;
    }
    if (stat) {
      const cached = this.cache.get(name);
      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        const text = readFileSync(path, 'utf8');
        this.cache.set(name, { mtimeMs: stat.mtimeMs, text });
        return { stage: name, text, source: 'override', path };
      }
      return { stage: name, text: cached.text, source: 'override', path };
    }
    this.cache.delete(name);
    const fallback = builtIn ?? BUILT_IN_STAGE_PROMPTS[name];
    if (fallback === undefined) {
      throw new Error(
        `No prompt for stage "${name}": no override at ${path} and no built-in prompt. ` +
          `Pass a builtIn fallback or add ${name}.md under ${this.dir}.`,
      );
    }
    return { stage: name, text: fallback, source: 'builtin' };
  }

  /** Stages with an override file currently present. */
  activeOverrides(): PromptOverrideInfo[] {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: PromptOverrideInfo[] = [];
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const stage = file.slice(0, -3);
      if (!/^[a-z0-9_-]+$/.test(stage)) continue;
      const path = join(this.dir, file);
      try {
        out.push({ stage, path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        // raced deletion — skip
      }
    }
    return out.sort((a, b) => (a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : 0));
  }

  /** Drop cached override text (forces a re-read on next resolve). */
  invalidate(stage?: string): void {
    if (stage === undefined) this.cache.clear();
    else this.cache.delete(sanitizeStage(stage));
  }

  /**
   * Watch the overrides dir and call `onChange(stage)` when an override is
   * added/changed/removed. Best-effort (fs.watch semantics); mtime checks
   * in `resolve()` remain the correctness path. Returns an unwatch fn.
   * No-op when the dir does not exist yet.
   */
  watch(onChange: (stage: string) => void): () => void {
    if (!existsSync(this.dir)) return () => {};
    let watcher: ReturnType<typeof fsWatch> | undefined;
    try {
      watcher = fsWatch(this.dir, (eventType, filename) => {
        if (typeof filename !== 'string' || !filename.endsWith('.md')) return;
        const stage = filename.slice(0, -3);
        if (!/^[a-z0-9_-]+$/.test(stage)) return;
        this.invalidate(stage);
        if (eventType === 'rename' && !existsSync(join(this.dir, filename))) {
          this.cache.delete(stage);
        }
        onChange(stage);
      });
    } catch {
      return () => {};
    }
    return () => {
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
    };
  }
}

/** Default store against `~/.kriyadot/prompts` (honors $HOME via os.homedir). */
export const defaultPromptStore = new PromptOverrideStore();

/** Convenience: resolve via the default store. */
export function resolveStagePrompt(stage: string, builtIn?: string): ResolvedStagePrompt {
  return defaultPromptStore.resolve(stage, builtIn);
}

/**
 * Log which prompt overrides are active — hosts call this once at boot so
 * the live configuration is always visible in startup logs.
 */
export function logActivePromptOverrides(
  logger: (line: string) => void = console.log,
  store: PromptOverrideStore = defaultPromptStore,
): void {
  const active = store.activeOverrides();
  if (active.length === 0) {
    logger(`[prompts] no overrides in ${store.directory} — using built-in stage prompts`);
    return;
  }
  for (const o of active) {
    logger(`[prompts] override active: ${o.stage}.md (${o.path})`);
  }
}
