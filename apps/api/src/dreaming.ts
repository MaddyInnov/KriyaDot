// SPDX-License-Identifier: Apache-2.0
/**
 * Nightly dreaming (item 13): per bot with memory, generate 'dream'
 * brief ideas from recent memory episodes with a cheap model, store
 * them as briefing idea items the daily briefing includes.
 *
 * Registration with the existing routine infra: ensureDreamRoutine()
 * creates (once) a daily RoutineStore routine per bot named
 * "Nightly dreaming" — visible/editable in Routines like any other.
 * The generation itself can also be driven directly via
 * NightlyDreamer.runForBot (the routine turn / tests use it), and
 * dreamBriefingItems() is the helper the briefing reads.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoutineStore } from './bot-routines.js';
import type { BriefingItem } from './briefing.js';

export interface DreamIdea { id: string; botId: string; title: string; detail?: string; createdAt: number; }
export class DreamStore {
  private readonly file: string;
  constructor(dataDir: string) { mkdirSync(dataDir, { recursive: true }); this.file = join(dataDir, 'dreams.json'); }
  private readAll(): DreamIdea[] { try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as DreamIdea[] : []; } catch { return []; } }
  add(ideas: DreamIdea[]): void { const all = [...this.readAll(), ...ideas].slice(-500); writeFileSync(this.file, JSON.stringify(all), 'utf8'); }
  list(botId?: string, limit = 20): DreamIdea[] { return this.readAll().filter(d => !botId || d.botId === botId).slice(-limit).reverse(); }
}
export function dreamBriefingItems(store: DreamStore, botId?: string): BriefingItem[] {
  return store.list(botId, 10).map(d => ({ id: `dream-${d.id}`, title: d.title, detail: d.detail, ts: d.createdAt, kind: 'dream' }));
}
export type DreamModelFn = (prompt: string) => Promise<string>;
export async function generateDreamIdeas(input: { botId: string; episodes: string[]; model: DreamModelFn; now?: number }): Promise<DreamIdea[]> {
  const episodes = input.episodes.filter(e => e.trim()).slice(0, 50);
  if (episodes.length === 0) return [];
  const prompt = [
    'You are dreaming over recent memory episodes. Propose brief, concrete ideas the user might act on tomorrow.',
    'Reply with one idea per line, format: Title — one-line detail. At most 5 lines, no preamble.',
    '', 'Episodes:', ...episodes.map(e => `- ${e}`),
  ].join('\n');
  const raw = await input.model(prompt);
  const now = input.now ?? Date.now();
  return raw.split('\n').map(l => l.trim().replace(/^[-*\d. ]+/, '')).filter(Boolean).slice(0, 5).map((line, i) => {
    const [title, ...rest] = line.split(' — ');
    return { id: `${now}-${i}`, botId: input.botId, title: (title ?? line).slice(0, 120), detail: rest.join(' — ').slice(0, 240) || undefined, createdAt: now };
  });
}
export class NightlyDreamer {
  constructor(private readonly deps: { store: DreamStore; episodesForBot: (botId: string) => string[] | Promise<string[]>; model: DreamModelFn }) {}
  async runForBot(botId: string): Promise<DreamIdea[]> {
    const episodes = await this.deps.episodesForBot(botId);
    const ideas = await generateDreamIdeas({ botId, episodes, model: this.deps.model });
    if (ideas.length) this.deps.store.add(ideas);
    return ideas;
  }
  async runForBots(botIds: string[]): Promise<Record<string, DreamIdea[]>> {
    const out: Record<string, DreamIdea[]> = {};
    for (const id of botIds) { try { out[id] = await this.runForBot(id); } catch { out[id] = []; } }
    return out;
  }
}
/** Register (idempotently) a nightly dreaming routine per bot in the RoutineStore. */
export function ensureDreamRoutine(routineStore: RoutineStore, botId: string, timezone = 'UTC'): boolean {
  const name = 'Nightly dreaming';
  if (routineStore.list().some(r => r.botId === botId && r.name === name)) return false;
  routineStore.create({
    name, botId,
    promptTemplate: 'Nightly dreaming: review today\'s memory episodes and propose brief ideas for tomorrow\'s briefing.',
    schedule: { kind: 'daily', time: '03:00', weekdays: [0,1,2,3,4,5,6], timezone, enabled: true, overlap: 'skip' },
  });
  return true;
}
