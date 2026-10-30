// SPDX-License-Identifier: Apache-2.0
// Layer-B closure verification (second pass, 2026-10-30): rows #17 (ACP
// async + cap), #18 (named-agent tools), #28 (evaluate in validators +
// routing), #34 (provider-native items in bedrock/cohere/mock), #40
// (template variables), #46 (session standing rules). Mock providers /
// fake fetch / fake ACP agent only — no paid APIs, no network.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findTemplateVariables,
  inspectTemplateVariables,
  listTemplateVariables,
  resolveTemplateVariables,
} from '../src/template-vars.js';
import {
  FileStandingRuleStore,
  MemoryStandingRuleStore,
  SessionStandingRules,
  renderStandingRules,
} from '../src/session-rules.js';
import { runEvaluateValidator, validatorFailureMessage } from '../src/validators.js';
import { routeModel, routeModelWithEvaluate } from '../src/routing.js';
import { createNamedAgentTools } from '../src/tools/background.js';
import { NamedAgentRegistry } from '../src/subagent-profiles.js';
import { buildConverseRequest, parseConverseResponse } from '../src/providers/bedrock.js';
import { CohereProvider } from '../src/providers/cohere.js';
import { MockProvider } from '../src/providers/mock.js';
import { AcpSessionManager, AcpSessionStore } from '../src/acp-sessions.js';
import type { BotConfig, ChatMessage, LLMProvider, ToolCall, ToolDefinition } from '../src/types.js';

// --- helpers ---------------------------------------------------------------

class DispatchProvider implements LLMProvider {
  readonly providerId = 'mock';
  readonly calls: Array<{ messages: ChatMessage[]; opts: Record<string, unknown> }> = [];
  constructor(private readonly reply: string | ((msgs: ChatMessage[]) => string)) {}
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], opts: Record<string, unknown>) {
    this.calls.push({ messages, opts });
    const content = typeof this.reply === 'function' ? this.reply(messages) : this.reply;
    return { content, toolCalls: [] as ToolCall[], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async listModels() {
    return [{ id: 'mock-model', name: 'Mock' }];
  }
}

const evalProfile = { modelId: 'mock-model' };

// --- #40 template variables --------------------------------------------------

describe('#40 system template variables + vars inspector', () => {
  const ctx = {
    cwd: '/work/proj',
    role: 'Reviewer',
    botName: 'Kriya',
    botId: 'bot-1',
    sessionId: 'sess-9',
    model: 'mock-model',
    providerId: 'mock',
    gitTree: 'clean',
    now: new Date('2026-10-30T05:00:00.000Z'),
  };

  it('resolves the full system set', () => {
    const out = resolveTemplateVariables(
      'cwd={{CWD}} role={{ROLE}} ws={{WORKSPACE}} bot={{BOT_NAME}}/{{BOT_ID}} s={{SESSION_ID}} m={{PROVIDER}}/{{MODEL}} git={{GIT_TREE}} d={{DATE}} t={{TIME}}',
      ctx,
    );
    expect(out).toBe(
      'cwd=/work/proj role=Reviewer ws=/work/proj bot=Kriya/bot-1 s=sess-9 m=mock/mock-model git=clean d=2026-10-30 t=05:00:00',
    );
  });

  it('leaves unknown variables and missing values untouched', () => {
    expect(resolveTemplateVariables('a {{NOPE}} b {{CWD}}', {})).toBe('a {{NOPE}} b {{CWD}}');
    expect(resolveTemplateVariables('json {"k":1} and {{input}} stay', ctx)).toBe('json {"k":1} and {{input}} stay');
  });

  it('inspector lists every variable with its resolved value', () => {
    const infos = inspectTemplateVariables(ctx);
    expect(infos.map((i) => i.name)).toEqual(listTemplateVariables());
    expect(infos.find((i) => i.name === 'GIT_TREE')?.value).toBe('clean');
    expect(infos.find((i) => i.name === 'ROLE')?.value).toBe('Reviewer');
    expect(inspectTemplateVariables({}).find((i) => i.name === 'CWD')?.value).toBeUndefined();
    expect(findTemplateVariables('{{CWD}} x {{ROLE}} {{CWD}}')).toEqual(['CWD', 'ROLE']);
  });
});

// --- #46 session standing rules ----------------------------------------------

describe('#46 session standing rules store', () => {
  it('adds, dedupes, merges bot+session scopes, and renders', () => {
    const rules = new SessionStandingRules({ store: new MemoryStandingRuleStore() });
    rules.addForBot('bot-1', 'Always answer in Hindi');
    const own = rules.addForSession('sess-1', 'Never touch prod');
    rules.addForSession('sess-1', 'Never touch prod'); // dupe — no second entry
    expect(rules.listScope('session:sess-1')).toHaveLength(1);
    const effective = rules.rulesFor('sess-1', 'bot-1');
    expect(effective.map((r) => r.text)).toEqual(['Always answer in Hindi', 'Never touch prod']);
    const rendered = renderStandingRules(effective);
    expect(rendered).toContain('Standing rules for this session');
    expect(rendered).toContain('1. Always answer in Hindi');
    expect(renderStandingRules([])).toBe('');
    expect(rules.remove(own.id)).toBe(true);
    expect(rules.remove(own.id)).toBe(false);
    expect(rules.rulesFor('sess-1', 'bot-1').map((r) => r.text)).toEqual(['Always answer in Hindi']);
  });

  it('carries session rules across sessions via bot scope', () => {
    const rules = new SessionStandingRules();
    rules.addForSession('sess-1', 'Cite sources');
    const carried = rules.carryAcrossSessions('sess-1', 'bot-1');
    expect(carried.map((r) => r.text)).toEqual(['Cite sources']);
    // A brand-new session of the same bot inherits the carried rule.
    expect(rules.rulesFor('sess-2', 'bot-1').map((r) => r.text)).toEqual(['Cite sources']);
    expect(rules.clearScope('bot:bot-1')).toBe(1);
  });

  it('persists through the file store across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'standing-rules-'));
    const path = join(dir, 'rules.json');
    const a = new SessionStandingRules({ store: new FileStandingRuleStore(path) });
    a.addForSession('sess-1', 'Be terse');
    const b = new SessionStandingRules({ store: new FileStandingRuleStore(path) });
    expect(b.rulesFor('sess-1').map((r) => r.text)).toEqual(['Be terse']);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

// --- #28 evaluate seam in validators + routing --------------------------------

describe('#28 evaluate-backed validator (probability thresholds)', () => {
  it('confident YES passes, confident NO fails with an injectable message', async () => {
    const yes = new DispatchProvider('{"answer": true, "probability": 92, "reason": "covers it"}');
    const pass = await runEvaluateValidator(yes, { name: 'coverage', criterion: 'answers the question' }, { request: 'q', output: 'a' }, { profile: evalProfile });
    expect(pass.passed).toBe(true);

    const no = new DispatchProvider('{"answer": false, "probability": 88, "reason": "misses the ask"}');
    const fail = await runEvaluateValidator(no, { name: 'coverage', criterion: 'answers the question' }, { request: 'q', output: 'a' }, { profile: evalProfile });
    expect(fail.passed).toBe(false);
    expect(fail.output).toContain('misses the ask');
    expect(validatorFailureMessage([fail])).toContain('Validator "coverage" FAILED');
  });

  it('unsure judge abstains (passes); unavailable judge passes with a note', async () => {
    const unsure = new DispatchProvider('{"answer": false, "probability": 40}');
    const abstained = await runEvaluateValidator(unsure, { name: 'v', criterion: 'x' }, { request: '', output: '' }, { profile: evalProfile });
    expect(abstained.passed).toBe(true);
    expect(abstained.output).toContain('abstained');

    const junk = new DispatchProvider('not json at all');
    const skipped = await runEvaluateValidator(junk, { name: 'v', criterion: 'x' }, { request: '', output: '' }, { profile: evalProfile });
    expect(skipped.passed).toBe(true);
    expect(skipped.output).toContain('unavailable');
  });
});

describe('#28 evaluate-assisted routing', () => {
  const candidates = [
    { providerId: 'prov', modelId: 'model-a', reason: 'deterministic candidate A' },
    { providerId: 'prov', modelId: 'model-b', reason: 'deterministic candidate B' },
  ];

  it('accepts the judge pick at/above threshold', async () => {
    const provider = new DispatchProvider('{"answer": "prov/model-b", "probability": 85, "reason": "better fit"}');
    const out = await routeModelWithEvaluate(provider, { taskType: 'code' }, { candidates, profile: evalProfile });
    expect(out.via).toBe('evaluate');
    expect(out.result.modelId).toBe('model-b');
    expect(out.probability).toBe(0.85);
  });

  it('abstains below threshold and keeps the deterministic route', async () => {
    const provider = new DispatchProvider('{"answer": "prov/model-b", "probability": 30}');
    const out = await routeModelWithEvaluate(provider, { taskType: 'code' }, { candidates, profile: evalProfile });
    expect(out.via).toBe('abstained');
    expect(out.result).toEqual(routeModel({ taskType: 'code' }));
  });

  it('never calls the judge for a single candidate', async () => {
    const provider = new DispatchProvider('{"answer": "prov/model-a", "probability": 99}');
    const out = await routeModelWithEvaluate(provider, { taskType: 'code' }, { candidates: [candidates[0]!], profile: evalProfile });
    expect(out.via).toBe('deterministic');
    expect(provider.calls).toHaveLength(0);
  });
});

// --- #18 named-agent lifecycle tools -------------------------------------------

describe('#18 named-agent lifecycle tools', () => {
  function makeTools() {
    const registry = new NamedAgentRegistry();
    const started: Array<Record<string, unknown>> = [];
    const bot = { id: 'origin', name: 'Origin' } as BotConfig;
    const tools = createNamedAgentTools({
      namedAgents: registry,
      getBot: () => bot,
      startBackgroundRun: (input) => {
        started.push(input as unknown as Record<string, unknown>);
        return { runId: 'bgr-test', botName: input.ephemeral?.name ?? 'x' };
      },
    });
    const byName = new Map(tools.map((t) => [t.name, t]));
    const ctx = { botId: 'origin', sessionId: 'sess-1' } as Parameters<NonNullable<(typeof tools)[number]['handler']>>[1];
    return { registry, started, byName, ctx };
  }

  it('register → invoke by name → disable blocks → remove', async () => {
    const { registry, started, byName, ctx } = makeTools();
    const reg = await byName.get('register_named_agent')!.handler({ name: 'Scout', systemPrompt: 'You scout.', tools: ['read_file'] }, ctx);
    expect(reg).toMatchObject({ registered: true, name: 'Scout', enabled: true });

    const inv = await byName.get('invoke_named_agent')!.handler({ name: 'Scout', task: 'find X' }, ctx);
    expect(inv).toMatchObject({ runId: 'bgr-test', agent: 'Scout' });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ task: 'find X', tools: ['read_file'] });
    expect(registry.get('Scout')?.invokeCount).toBe(1);

    await byName.get('set_named_agent_enabled')!.handler({ name: 'Scout', enabled: false }, ctx);
    const blocked = await byName.get('invoke_named_agent')!.handler({ name: 'Scout', task: 'again' }, ctx);
    expect(blocked).toMatchObject({ error: 'named agent "Scout" is disabled' });
    expect(started).toHaveLength(1);

    const list = (await byName.get('list_named_agents')!.handler({}, ctx)) as { agents: Array<{ name: string; enabled: boolean }> };
    expect(list.agents).toEqual([{ name: 'Scout', description: '', enabled: false, invokeCount: 1 }]);

    await byName.get('remove_named_agent')!.handler({ name: 'Scout' }, ctx);
    const gone = await byName.get('invoke_named_agent')!.handler({ name: 'Scout', task: 'again' }, ctx);
    expect(gone).toMatchObject({ error: 'no named agent "Scout" — register it first' });
  });
});

// --- #34 provider-native items --------------------------------------------------

describe('#34 native items round-trip in owned drivers', () => {
  it('bedrock: parse captures raw blocks; build replays them verbatim', () => {
    const blocks = [
      { text: 'draft reasoning kept native' },
      { toolUse: { toolUseId: 'tu-1', name: 'read_file', input: { path: '/x' } } },
    ];
    const parsed = parseConverseResponse({
      output: { message: { content: blocks } },
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
    expect(parsed.nativeItems).toEqual(blocks);
    expect(parsed.content).toBe('draft reasoning kept native');

    const req = buildConverseRequest(
      [
        { role: 'user', content: 'go' },
        // Stored form: flattened content DIFFERS from the native blocks —
        // replay must use the native blocks, not the flattened text.
        { role: 'assistant', content: 'FLATTENED', nativeItems: blocks } as ChatMessage,
        { role: 'tool', content: '{"ok":true}', toolCallId: 'tu-1', toolName: 'read_file' },
      ],
      [],
      {},
    );
    const msgs = req.messages as Array<{ role: string; content: unknown[] }>;
    const assistant = msgs.find((m) => m.role === 'assistant');
    expect(assistant?.content).toEqual(blocks);
    expect(JSON.stringify(req)).not.toContain('FLATTENED');
  });

  it('bedrock: foreign-shaped native items are ignored, never crossed', () => {
    const req = buildConverseRequest(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'plain text', nativeItems: [{ type: 'thinking', thinking: 'secret' }] } as unknown as ChatMessage,
      ],
      [],
      {},
    );
    const msgs = req.messages as Array<{ role: string; content: unknown[] }>;
    expect(msgs.find((m) => m.role === 'assistant')?.content).toEqual([{ text: 'plain text' }]);
  });

  it('cohere: capture the raw message; replay it verbatim on the next call', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const nativeMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'native hello' }],
      tool_calls: [{ id: 'ct-1', function: { name: 'lookup', arguments: '{"q":1}' } }],
    };
    const fetchFn = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ message: nativeMessage, usage: { tokens: { input_tokens: 2, output_tokens: 3 } } }),
        text: async () => '',
      } as Response;
    }) as unknown as typeof fetch;
    const provider = new CohereProvider({ apiKey: 'test', fetchFn });
    const first = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'command-r' });
    expect(first.nativeItems).toEqual([nativeMessage]);
    expect(first.toolCalls).toEqual([{ id: 'ct-1', name: 'lookup', args: { q: 1 } }]);

    await provider.chat(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'FLATTENED', nativeItems: first.nativeItems } as ChatMessage,
        { role: 'tool', content: 'done', toolCallId: 'ct-1', toolName: 'lookup' },
      ],
      [],
      { model: 'command-r' },
    );
    const sent = bodies[1]?.messages as Array<{ role: string; content: unknown }>;
    const assistant = sent.find((m) => m.role === 'assistant');
    expect(assistant?.content).toEqual([
      { type: 'text', text: 'native hello' },
      { type: 'tool-call', id: 'ct-1', function: { name: 'lookup', arguments: '{"q":1}' } },
    ]);
  });

  it('mock: step native items are returned; stored items ride back in calls', async () => {
    const native = [{ type: 'reasoning', id: 'rs-1' }];
    const provider = new MockProvider([{ content: 'one', nativeItems: native }, { content: 'two' }]);
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'mock-model' });
    expect(res.nativeItems).toEqual(native);
    await provider.chat(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'one', nativeItems: native } as ChatMessage,
      ],
      [],
      { model: 'mock-model' },
    );
    expect((provider.calls[1]?.messages[1] as ChatMessage).nativeItems).toEqual(native);
  });
});

// --- #17 async ACP + concurrency cap ---------------------------------------------

const SLOW_AGENT = `
let buf = '';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', (d) => {
  buf += d.toString();
  const lines = buf.split('\\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'slow-agent' } } });
    } else if (m.method === 'prompt') {
      const id = m.id; const prompt = m.params.prompt;
      setTimeout(() => send({ jsonrpc: '2.0', id, result: { text: 'done:' + prompt } }), 250);
    }
  }
});
`;

describe('#17 async ACP prompts + cross-session concurrency cap', () => {
  let dir: string;
  let store: AcpSessionStore;
  let manager: AcpSessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acp-async-'));
    writeFileSync(join(dir, 'slow-agent.mjs'), SLOW_AGENT);
    store = new AcpSessionStore(dir);
    manager = new AcpSessionManager(store, { maxConcurrentPrompts: 1 });
  });

  afterEach(() => {
    manager.closeAll();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const create = () =>
    manager.createSession({ command: process.execPath, args: [join(dir, 'slow-agent.mjs')], label: 'slow', cwd: dir });

  it('sync prompt() refuses beyond the cap with a busy error', async () => {
    const a = await create();
    const b = await create();
    const first = manager.prompt(a.id, 'one');
    // Let session A actually get its prompt in flight.
    await new Promise((r) => setTimeout(r, 50));
    await expect(manager.prompt(b.id, 'two')).rejects.toMatchObject({ kind: 'busy' });
    await expect(first).resolves.toBe('done:one');
    expect(manager.activePromptCount).toBe(0);
  });

  it('promptAsync accepts immediately and delivers completions via onComplete, queued FIFO', async () => {
    const a = await create();
    const b = await create();
    const completions: string[] = [];
    const done = new Promise<void>((resolve) => {
      const onComplete = (r: { ok: boolean; text?: string }) => {
        if (r.ok) completions.push(r.text!);
        if (completions.length === 2) resolve();
      };
      void manager.promptAsync(a.id, 'first', { onComplete });
      void manager.promptAsync(b.id, 'second', { onComplete });
    });
    await done;
    expect(completions).toEqual(['done:first', 'done:second']);
  });

  it('promptAsync on an unknown session rejects at acceptance time', async () => {
    await expect(manager.promptAsync('acp_nope', 'x')).rejects.toMatchObject({ kind: 'not-found' });
  });
});
