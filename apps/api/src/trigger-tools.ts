// SPDX-License-Identifier: Apache-2.0
/**
 * Trigger tools from chat (item 3): create/list/delete triggers
 * (routines) from inside a turn, following the schedule-tools.ts pattern
 * and reusing RoutineStore. Results carry a live-card widget payload so
 * the chat UI renders a card for the created trigger.
 * NOTE for parent: register via tool-registry merge — add
 * `...createTriggerTools(routineStore)` where schedule tools are added.
 */
import type { ToolDefinition } from '@mvp/agent-runtime';
import type { RoutineStore } from './bot-routines.js';
import { describeSchedule, validateRoutineSchedule, type RoutineSchedule } from './routine-schedules.js';

export function triggerCard(routine: { id: string; name: string; botId: string; schedule?: RoutineSchedule | null }) {
  return {
    kind: 'table' as const,
    title: `Trigger: ${routine.name}`,
    columns: ['Field', 'Value'],
    rows: [
      ['ID', routine.id],
      ['Bot', routine.botId],
      ['When', routine.schedule ? describeSchedule(routine.schedule) : 'manual/webhook only'],
    ],
  };
}
export function createTriggerTools(store: RoutineStore): ToolDefinition[] {
  return [
    {
      name: 'create_trigger', mutating: true,
      description: 'Create a trigger (routine) for yourself: a named prompt that fires on a schedule (pass a RoutineSchedule object) or manually/by webhook when schedule is omitted.',
      parameters: { type:'object', properties:{ name:{type:'string'}, prompt:{type:'string'}, schedule:{type:'object', description:'RoutineSchedule: {kind: once|daily|cron|interval|idle|startup, timezone, enabled, overlap, ...kind fields}'} }, required:['name','prompt'] },
      handler: async (args, ctx) => {
        const name = typeof args.name==='string'?args.name.trim():''; const prompt = typeof args.prompt==='string'?args.prompt.trim():'';
        if (!name || !prompt) return { error: 'name and prompt are required' };
        let schedule: RoutineSchedule | null = null;
        if (args.schedule) { try { schedule = validateRoutineSchedule(args.schedule); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } }
        try { const r = store.create({ name, botId: ctx.botId, promptTemplate: prompt, schedule }); return { created: true, id: r.id, name: r.name, widget: triggerCard(r) }; }
        catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
      },
    },
    {
      name: 'list_triggers',
      description: 'List your triggers (routines) with ids, schedules and enabled state.',
      parameters: { type:'object', properties:{} },
      handler: async (_a, ctx) => ({ triggers: store.list().filter(r=>r.botId===ctx.botId).map(r=>({ id:r.id, name:r.name, enabled:r.enabled, when: r.schedule?describeSchedule(r.schedule):'manual/webhook only', widget: triggerCard(r) })) }),
    },
    {
      name: 'delete_trigger', mutating: true,
      description: 'Delete one of your triggers by id or exact name.',
      parameters: { type:'object', properties:{ idOrName:{type:'string'} }, required:['idOrName'] },
      handler: async (args, ctx) => {
        const needle = typeof args.idOrName==='string'?args.idOrName.trim():'';
        const mine = store.list().filter(r=>r.botId===ctx.botId);
        const found = mine.find(r=>r.id===needle) ?? mine.find(r=>r.name===needle);
        if (!found) return { error: `no trigger of yours matches "${needle}"` };
        store.remove(found.id); return { deleted: true, id: found.id, name: found.name };
      },
    },
  ];
}
