// SPDX-License-Identifier: Apache-2.0
/**
 * Reflective dreaming (SI-2): the nightly pass that goes beyond idea
 * generation. Where NightlyDreamer (dreaming.ts) proposes ideas, the
 * ReflectiveDreamer synthesises the day: what WORKED, what RUPTURED
 * (friction, failures, corrections), what the user/system is BECOMING,
 * and REPAIR threads — concrete follow-ups opened from ruptures that a
 * human (or a later turn) can pick up and close.
 *
 * Same shape as dreaming.ts: a file-backed store, a pure generation
 * function over a mockable model fn, a runner class, briefing items,
 * and an idempotent routine registration ("Nightly reflection", 03:30).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoutineStore } from './bot-routines.js';
import type { BriefingItem } from './briefing.js';
import type { DreamModelFn } from './dreaming.js';

export interface RepairThread {
  id: string;
  botId: string;
  title: string;
  detail?: string;
  status: 'open' | 'addressed';
  createdAt: number;
  addressedAt?: number;
}

export interface Reflection {
  id: string;
  botId: string;
  worked: string[];
  ruptured: string[];
  becoming: string[];
  repairThreadIds: string[];
  createdAt: number;
}

interface ReflectionFile {
  reflections: Reflection[];
  repairs: RepairThread[];
}

export class ReflectionStore {
  private readonly file: string;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'reflections.json');
  }
  private readAll(): ReflectionFile {
    try {
      if (!existsSync(this.file)) return { reflections: [], repairs: [] };
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ReflectionFile>;
      return { reflections: parsed.reflections ?? [], repairs: parsed.repairs ?? [] };
    } catch {
      return { reflections: [], repairs: [] };
    }
  }
  private writeAll(data: ReflectionFile): void {
    writeFileSync(
      this.file,
      JSON.stringify({ reflections: data.reflections.slice(-200), repairs: data.repairs.slice(-500) }),
      'utf8',
    );
  }
  add(reflection: Reflection, repairs: RepairThread[]): void {
    const all = this.readAll();
    all.reflections.push(reflection);
    all.repairs.push(...repairs);
    this.writeAll(all);
  }
  listReflections(botId?: string, limit = 20): Reflection[] {
    return this.readAll()
      .reflections.filter((r) => !botId || r.botId === botId)
      .slice(-limit)
      .reverse();
  }
  listRepairThreads(status?: 'open' | 'addressed', botId?: string): RepairThread[] {
    return this.readAll()
      .repairs.filter((r) => (!status || r.status === status) && (!botId || r.botId === botId))
      .reverse();
  }
  addressRepairThread(id: string, now: number = Date.now()): RepairThread | undefined {
    const all = this.readAll();
    const thread = all.repairs.find((r) => r.id === id);
    if (!thread) return undefined;
    thread.status = 'addressed';
    thread.addressedAt = now;
    this.writeAll(all);
    return thread;
  }
}

const SECTION_HEADERS: Record<string, 'worked' | 'ruptured' | 'becoming' | 'repairs'> = {
  WORKED: 'worked',
  RUPTURED: 'ruptured',
  BECOMING: 'becoming',
  REPAIR: 'repairs',
  REPAIRS: 'repairs',
};

export interface GeneratedReflection {
  reflection: Reflection;
  repairs: RepairThread[];
}

/**
 * Generate one reflection from the day's episodes + outcome lines
 * (corrections, failed runs, kept/missed commitments). The model is
 * asked for WORKED / RUPTURED / BECOMING / REPAIR sections; parsing is
 * tolerant — unheaded lines before any header count as "worked".
 */
export async function generateReflection(input: {
  botId: string;
  episodes: string[];
  outcomes?: string[];
  model: DreamModelFn;
  now?: number;
}): Promise<GeneratedReflection | null> {
  const episodes = input.episodes.filter((e) => e.trim()).slice(0, 50);
  const outcomes = (input.outcomes ?? []).filter((e) => e.trim()).slice(0, 30);
  if (episodes.length === 0 && outcomes.length === 0) return null;
  const prompt = [
    'You are reflecting overnight on today. Synthesise — do not propose new product ideas.',
    'Reply with four sections, each introduced by its header line exactly: WORKED:, RUPTURED:, BECOMING:, REPAIR:',
    'Under each header, one item per line, at most 3 lines. REPAIR lines are concrete follow-ups for something that ruptured.',
    '',
    'Episodes:',
    ...episodes.map((e) => `- ${e}`),
    ...(outcomes.length ? ['', 'Outcomes (corrections, failures, kept/missed commitments):', ...outcomes.map((e) => `- ${e}`)] : []),
  ].join('\n');
  const raw = await input.model(prompt);
  const now = input.now ?? Date.now();
  const sections: Record<'worked' | 'ruptured' | 'becoming' | 'repairs', string[]> = {
    worked: [],
    ruptured: [],
    becoming: [],
    repairs: [],
  };
  let current: keyof typeof sections = 'worked';
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim().replace(/^[-*•]\s*/, '');
    if (!line) continue;
    const headerMatch = line.match(/^([A-Z]+):\s*(.*)$/);
    const header = headerMatch ? SECTION_HEADERS[headerMatch[1]!] : undefined;
    if (header) {
      current = header;
      const rest = (headerMatch![2] ?? '').trim();
      if (rest) sections[current].push(rest.slice(0, 240));
      continue;
    }
    if (sections[current].length < 3) sections[current].push(line.slice(0, 240));
  }
  const repairs: RepairThread[] = sections.repairs.map((line, i) => {
    const [title, ...rest] = line.split(' — ');
    return {
      id: `repair-${now}-${i}`,
      botId: input.botId,
      title: (title ?? line).slice(0, 120),
      detail: rest.join(' — ').slice(0, 240) || undefined,
      status: 'open' as const,
      createdAt: now,
    };
  });
  const reflection: Reflection = {
    id: `reflection-${now}`,
    botId: input.botId,
    worked: sections.worked,
    ruptured: sections.ruptured,
    becoming: sections.becoming,
    repairThreadIds: repairs.map((r) => r.id),
    createdAt: now,
  };
  return { reflection, repairs };
}

export class ReflectiveDreamer {
  constructor(
    private readonly deps: {
      store: ReflectionStore;
      episodesForBot: (botId: string) => string[] | Promise<string[]>;
      outcomesForBot?: (botId: string) => string[] | Promise<string[]>;
      model: DreamModelFn;
    },
  ) {}

  async runForBot(botId: string): Promise<GeneratedReflection | null> {
    const episodes = await this.deps.episodesForBot(botId);
    const outcomes = this.deps.outcomesForBot ? await this.deps.outcomesForBot(botId) : [];
    const generated = await generateReflection({ botId, episodes, outcomes, model: this.deps.model });
    if (generated) this.deps.store.add(generated.reflection, generated.repairs);
    return generated;
  }

  async runForBots(botIds: string[]): Promise<Record<string, GeneratedReflection | null>> {
    const out: Record<string, GeneratedReflection | null> = {};
    for (const id of botIds) {
      try {
        out[id] = await this.runForBot(id);
      } catch {
        out[id] = null;
      }
    }
    return out;
  }
}

/** Briefing view of the latest reflection + its open repair threads. */
export function reflectionBriefingItems(store: ReflectionStore, botId?: string): BriefingItem[] {
  const items: BriefingItem[] = [];
  const latest = store.listReflections(botId, 1)[0];
  if (latest) {
    const lines = [
      ...latest.worked.map((w) => `Worked: ${w}`),
      ...latest.ruptured.map((r) => `Ruptured: ${r}`),
      ...latest.becoming.map((b) => `Becoming: ${b}`),
    ];
    if (lines.length) {
      items.push({ id: `reflection-${latest.id}`, title: 'Overnight reflection', detail: lines.join(' · '), ts: latest.createdAt, kind: 'reflection' });
    }
  }
  for (const repair of store.listRepairThreads('open', botId).slice(0, 5)) {
    items.push({ id: `repair-${repair.id}`, title: `Repair: ${repair.title}`, detail: repair.detail, ts: repair.createdAt, kind: 'repair' });
  }
  return items;
}

/** Register (idempotently) the nightly reflection routine per bot. */
export function ensureReflectionRoutine(routineStore: RoutineStore, botId: string, timezone = 'UTC'): boolean {
  const name = 'Nightly reflection';
  if (routineStore.list().some((r) => r.botId === botId && r.name === name)) return false;
  routineStore.create({
    name,
    botId,
    promptTemplate:
      'Nightly reflection: synthesise today — what worked, what ruptured, what is becoming — and open repair threads for ruptures.',
    schedule: { kind: 'daily', time: '03:30', weekdays: [0, 1, 2, 3, 4, 5, 6], timezone, enabled: true, overlap: 'skip' },
  });
  return true;
}
