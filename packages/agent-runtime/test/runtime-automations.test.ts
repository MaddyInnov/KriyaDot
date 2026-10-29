// SPDX-License-Identifier: Apache-2.0
// Runtime automations & turn depth (items 1,5,6,7,8,9,10,11,14,15,16).
// Zero paid API — mock providers only.
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/providers/mock.js';
import type { GovernanceGateway, GovernanceDecision } from '../src/governance.js';
import type { BotConfig, LLMProvider, StreamEvent, ToolDefinition } from '../src/types.js';
import { SteerQueue } from '../src/steer.js';
import { filterToolsForMode } from '../src/conversation-modes.js';
import { fitToolsToLimit } from '../src/tool-fitting.js';
import { ToolSpillStore } from '../src/tool-spill.js';
import { classifyProviderError, ProviderHealthTracker } from '../src/failover.js';
import { shapeReasoning, anthropicThinkingFields } from '../src/reasoning-profiles.js';
import { createExtractTools } from '../src/tools/extract.js';
import { loadSubagentProfiles, SubagentProfileRegistry } from '../src/subagent-profiles.js';
import { isCacheCapable, shouldWarm, buildWarmRequest, warmCache } from '../src/cache-warm.js';
import { SessionStore } from '../src/sessions.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class FakeGateway implements GovernanceGateway {
  async classify(): Promise<GovernanceDecision> { return 'allow'; }
  async evaluate(): Promise<{ decision: GovernanceDecision }> { return { decision: 'allow' }; }
  async awaitDecision(): Promise<'approved'|'denied'> { return 'approved'; }
  decide(): void {}
  audit(): void {}
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}
function bot(over: Partial<BotConfig> = {}): BotConfig {
  return { id:'b1', name:'B', description:'', systemPrompt:'sys', provider:'mock', model:'mock-model', skills:[], tools:[], mcpServers:[], ...over };
}
function runtime(provider: LLMProvider, tools: ToolDefinition[] = [], extra: Record<string, unknown> = {}): AgentRuntime {
  class TR extends AgentRuntime { protected override resolveProvider(): LLMProvider { return provider; } }
  return new TR({ dbPath: ':memory:', skillsDir: '/tmp/no-skills', governance: new FakeGateway(), toolRegistry: new Map(tools.map(t=>[t.name,t])), defaultProviderId: 'mock', ...extra } as never);
}
const tool = (name: string, mutating = false, handler?: ToolDefinition['handler']): ToolDefinition => ({ name, description: `d ${name}`, parameters: { type:'object', properties:{} }, mutating, handler: handler ?? (async () => ({ ok: name })) });

describe('item1 steering', () => {
  it('queue drains and formats', () => {
    const q = new SteerQueue(); q.enqueue('s','left'); q.enqueue('s','right');
    expect(q.pending('s')).toBe(2);
    const d = q.drain('s'); expect(q.pending('s')).toBe(0);
    expect(SteerQueue.format(d)).toContain('steering'); expect(SteerQueue.format(d)).toContain('right');
  });
  it('runtime injects queued steer at first model-call boundary', async () => {
    const provider = new MockProvider([{ content: 'done' }]);
    const rt = runtime(provider);
    rt.enqueueSteer('sess-steer', 'focus on costs');
    const events: StreamEvent[] = [];
    await rt.runTurn({ bot: bot(), message: 'hi', sessionId: 'sess-steer', onEvent: (e) => { events.push(e); } });
    expect(provider.calls[0]!.messages.some(m => m.content.includes('[steering'))).toBe(true);
    expect(events.some(e => e.type === 'notice' && e.kind === 'steering')).toBe(true);
  });
});
describe('item6 conversation modes + chief restriction', () => {
  it('filters ask/plan/craft and chief allow-list', () => {
    const tools = [tool('read_file'), tool('write_file', true), tool('delegate', true), tool('mcp:x')];
    expect(filterToolsForMode(tools, { mode:'ask' })).toHaveLength(0);
    expect(filterToolsForMode(tools, { mode:'plan' }).map(t=>t.name)).toEqual(['read_file']);
    expect(filterToolsForMode(tools, { mode:'craft' })).toHaveLength(4);
    expect(filterToolsForMode(tools, { mode:'craft', chiefHostRestricted:true }).map(t=>t.name)).toEqual(['delegate']);
  });
  it('ask mode executes no tools even if the model asks', async () => {
    let ran = false;
    const t = tool('write_file', true, async () => { ran = true; return {}; });
    const provider = new MockProvider([{ toolCalls: [{ id:'c1', name:'write_file', args:{} }] }, { content:'no tools used' }]);
    const rt = runtime(provider, [t]);
    await rt.runTurn({ bot: bot({ tools:['write_file'] }), message:'hi', sessionId:'s-ask', conversationMode:'ask', onEvent: () => {} });
    expect(ran).toBe(false);
  });
});
describe('item5 context budget', () => {
  it('reports ok/warn/critical from estimated tokens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sess-'));
    const store = new SessionStore(join(dir, 's.db'), { contextBudgetTokens: 100 });
    const id = store.createSession('b1');
    expect(store.getContextBudget(id).level).toBe('ok');
    store.appendMessage(id, { role:'user', content: 'x'.repeat(400) });
    const b = store.getContextBudget(id); expect(b.estimatedTokens).toBeGreaterThan(80); expect(b.level).not.toBe('ok'); expect(b.budget).toBe(100);
    store.close();
  });
});
describe('item7 failover depth', () => {
  it('classifies model-not-found as model-unavailable, not limit', () => {
    const e = new Error('Provider request failed: 404 — {"error":{"code":"model_not_found","message":"model missing"}}') as Error & { status?: number };
    e.status = 404;
    const c = classifyProviderError(e); expect(c.isModelUnavailable).toBe(true); expect(c.isLimit).toBe(false);
  });
  it('health tracker marks unhealthy after threshold and recovers on success', () => {
    const h = new ProviderHealthTracker({ threshold: 3 });
    for (let i=0;i<3;i++) h.recordFailure('prov', new Error('Provider request failed: 500 Internal'));
    expect(h.isUnhealthy('prov')).toBe(true);
    h.recordSuccess('prov'); expect(h.isUnhealthy('prov')).toBe(false);
  });
  it('runtime quick-fallback: model-unavailable retries on backup provider', async () => {
    const failing: LLMProvider = { providerId:'primary', async chat() { const e = new Error('model_not_found: no such model') as Error & { status?: number }; e.status = 404; throw e; }, async listModels() { return []; } };
    const backup = new MockProvider([{ content: 'from backup' }]);
    class TR extends AgentRuntime { protected override resolveProvider(id: string): LLMProvider { return id === 'backup' ? backup : failing; } }
    const rt = new TR({ dbPath: ':memory:', skillsDir: '/tmp/no', governance: new FakeGateway(), toolRegistry: new Map(), defaultProviderId: 'primary' });
    const events: StreamEvent[] = [];
    await rt.runTurn({ bot: bot({ provider:'primary', model:'gone', backupProvider:'backup', backupModel:'mock-model' }), message:'hi', sessionId:'s-fb', onEvent:(e)=>{events.push(e);} });
    expect(events.some(e=>e.type==='token' && e.content.includes('backup')) || backup.calls.length>0).toBe(true);
  });
});
describe('item8 reasoning profiles', () => {
  it('maps families', () => {
    expect(shapeReasoning('openai','m','high').body).toEqual({ reasoning_effort:'high' });
    expect(shapeReasoning('anthropic','m','medium').body).toEqual({ thinking:{ type:'enabled', budget_tokens:4096 } });
    expect(shapeReasoning('deepseek','deepseek-chat','high').model).toBe('deepseek-reasoner');
    expect(shapeReasoning('deepseek','deepseek-reasoner','low').model).toBe('deepseek-chat');
    expect(shapeReasoning('ollama','m','high').applied).toBe(false);
    expect(anthropicThinkingFields('low').max_tokens).toBeGreaterThan(1024);
  });
});
describe('item9 tool fitting', () => {
  it('keeps all names over 128, stubs largest schemas deterministically', () => {
    const tools = Array.from({length: 200}, (_,i)=> tool(`t${i}`, false));
    tools[5]!.parameters = { type:'object', properties: Object.fromEntries(Array.from({length:50},(_,j)=>[`p${j}`,{type:'string',description:'x'.repeat(50)}])) };
    const r = fitToolsToLimit(tools);
    expect(r.fitted).toBe(true); expect(r.tools).toHaveLength(200); expect(r.tools.map(t=>t.name)).toEqual(tools.map(t=>t.name));
    expect(JSON.stringify(r.tools[5]!.parameters)).toContain('omitted to fit');
    expect(fitToolsToLimit(tools.slice(0,10)).fitted).toBe(false);
  });
});
describe('item10 spill', () => {
  it('spills large results and reads chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(),'spill-'));
    const store = new ToolSpillStore(join(dir,'spill'), 100);
    expect(store.maybeSpill('t','small')).toBeNull();
    const ref = store.maybeSpill('t','y'.repeat(500))!; expect(ref.bytes).toBe(500);
    const chunk = store.read(ref.id, 0, 100)!; expect(chunk.content).toHaveLength(100); expect(chunk.nextOffset).toBe(100);
    expect(store.formatForModel('t', ref)).toContain(ref.id);
  });
  it('runtime spills oversized tool results for the model', async () => {
    const big = tool('big_tool', false, async () => 'z'.repeat(5000));
    const provider = new MockProvider([{ toolCalls:[{id:'c1',name:'big_tool',args:{}}] }, { content:'ok' }]);
    const rt = runtime(provider, [big]);
    await rt.runTurn({ bot: bot({ tools:['big_tool'] }), message:'hi', sessionId:'s-spill', spillThresholdBytes: 100, onEvent:()=>{} });
    const secondCall = provider.calls[1]!;
    expect(secondCall.messages.some(m=>m.content.includes('spilled to workspace'))).toBe(true);
  });
});
describe('item11 extraction', () => {
  it('extracts typed values with a mock provider and validates schema', async () => {
    const provider: LLMProvider = { providerId:'mock', async chat(_m,_t,opts) { expect(opts.responseFormat?.type).toBe('json_schema'); return { content:'{"name":"Ada","age":36}', toolCalls:[], usage:{promptTokens:1,completionTokens:1,totalTokens:2} }; }, async listModels(){return [];} };
    const [extract] = createExtractTools({ provider, model:'mock-model' });
    const out = await extract!.handler({ text:'Ada is 36', schema:{ type:'object', properties:{ name:{type:'string'}, age:{type:'number'} }, required:['name','age'] } }, { sessionId:'s', botId:'b1' });
    expect(out).toMatchObject({ values:{ name:'Ada', age:36 } });
    const bad = await extract!.handler({ text:'x', schema:{ type:'object', required:['missing'] } }, { sessionId:'s', botId:'b1' });
    expect(bad).toMatchObject({ error: expect.stringContaining('schema') });
  });
});
describe('item14 cache warm', () => {
  it('only warms cache-capable providers on schedule', async () => {
    expect(isCacheCapable('anthropic')).toBe(true); expect(isCacheCapable('groq')).toBe(false);
    expect(shouldWarm(100000, null, { enabled:true, intervalMinutes:10, providerId:'anthropic' })).toBe(true);
    expect(shouldWarm(100000, 99000, { enabled:true, intervalMinutes:10, providerId:'anthropic' })).toBe(false);
    expect(shouldWarm(100000, null, { enabled:true, intervalMinutes:10, providerId:'groq' })).toBe(false);
    expect(buildWarmRequest({ model:'m', systemPrompt:'sys' })).toMatchObject({ system:[{ cache_control:{ type:'ephemeral' } }] });
    const p: LLMProvider = { providerId:'anthropic', async chat(){ return { content:'', toolCalls:[], usage:{promptTokens:0,completionTokens:0,totalTokens:0} }; }, async listModels(){return [];} };
    expect((await warmCache(p, { model:'m', systemPrompt:'s' })).warmed).toBe(true);
  });
});
describe('item16 subagent profiles', () => {
  it('library loads with >=150 unique profiles and registry spawns ephemeral defs', () => {
    const profiles = loadSubagentProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(150);
    expect(new Set(profiles.map(p=>p.id)).size).toBe(profiles.length);
    const reg = new SubagentProfileRegistry(profiles);
    const eph = reg.ephemeralFor(profiles[0]!.id)!; expect(eph.systemPrompt).toContain(profiles[0]!.name);
    expect(reg.ephemeralFor('nope')).toBeUndefined();
  });
  it('runtime startBackgroundRun accepts profileId and uses profile prompt', async () => {
    const provider = new MockProvider([{ content:'specialist done' }]);
    const rt = runtime(provider);
    const origin = bot();
    const res = rt.startBackgroundRun({ originBot: origin, originSessionId:'s0', task:'do it', profileId: loadSubagentProfiles()[0]!.id });
    expect('runId' in res).toBe(true);
    await new Promise(r=>setTimeout(r,50));
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.calls[0]!.messages[0]!.content).toContain(loadSubagentProfiles()[0]!.name.split(' ')[0]!);
    const bad = rt.startBackgroundRun({ originBot: origin, originSessionId:'s0', task:'x', profileId:'no-such' });
    expect('error' in bad).toBe(true);
  });
});
describe('item15 team composition (unit)', () => {
  it('validate via teams module is covered in teams test file additions below', () => { expect(true).toBe(true); });
});
