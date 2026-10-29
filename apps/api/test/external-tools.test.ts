// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { createXTools, mapXSearchResponse, xToolPolicyRules } from '../src/x-tools.js';
import { createPostizTools, postizToolPolicyRules } from '../src/postiz-tools.js';
import { createWhopTools } from '../src/whop-tools.js';

const ctx = { botId: 'b1', sessionId: 's1' } as never;
type Call = { url: string; init?: RequestInit };
function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }): { calls: Call[]; fetchImpl: (url: string, init?: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const r = handler(url, init);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    },
  };
}
const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe('x-tools', () => {
  it('maps search results with author usernames and metrics', async () => {
    const { calls, fetchImpl } = stubFetch(() => ({ body: { data: [{ id: '1', text: 'hello', author_id: 'u1', created_at: '2026-01-01T00:00:00Z', public_metrics: { like_count: 3, retweet_count: 1, reply_count: 2 } }], includes: { users: [{ id: 'u1', username: 'asha' }] }, meta: { result_count: 1 } } }));
    const [search] = createXTools({ fetchImpl, getBearerToken: () => 'tok' });
    const out = await search.handler({ query: 'kriyadot' }, ctx) as { tweets: Array<Record<string, unknown>> };
    expect(out.tweets[0]).toMatchObject({ id: '1', authorUsername: 'asha', likeCount: 3 });
    expect(calls[0].url).toContain('/2/tweets/search/recent?');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(mapXSearchResponse({}).resultCount).toBe(0);
  });
  it('x_post is mutating, approval-ruled, and returns the status url; errors surface cleanly', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: { data: { id: '99', text: 'hi' } } }));
    const tools = createXTools({ fetchImpl, getAccessToken: () => 'utok' });
    const post = tools.find((t) => t.name === 'x_post')!;
    expect(post.mutating).toBe(true);
    expect(xToolPolicyRules().find((r) => r.toolPattern.includes('x_post'))?.effect).toBe('require-approval');
    await expect(post.handler({ text: 'hi' }, ctx)).resolves.toMatchObject({ ok: true, id: '99', url: 'https://x.com/i/web/status/99' });
    const bad = createXTools({ fetchImpl: stubFetch(() => ({ status: 403, body: { detail: 'forbidden' } })).fetchImpl, getBearerToken: () => 't' });
    await expect(bad[0].handler({ query: 'x' }, ctx)).rejects.toThrow(/X API error \(403\): forbidden/);
  });
  it('missing config errors without any fetch', async () => {
    delete process.env.X_BEARER_TOKEN; delete process.env.X_ACCESS_TOKEN;
    const { calls, fetchImpl } = stubFetch(() => ({ body: {} }));
    const [search] = createXTools({ fetchImpl });
    await expect(search.handler({ query: 'x' }, ctx)).rejects.toThrow(/not configured/);
    expect(calls).toHaveLength(0);
  });
});

describe('postiz-tools', () => {
  it('lists integrations and schedules a post with the Postiz payload shape', async () => {
    const { calls, fetchImpl } = stubFetch((url) => url.includes('/integrations')
      ? { body: [{ id: 'int1', name: 'X', identifier: 'twitter', disabled: false }] }
      : { body: [{ postId: 'p1', integration: 'int1' }] });
    const tools = createPostizTools({ fetchImpl, getApiKey: () => 'pk' });
    const list = tools.find((t) => t.name === 'postiz_list_integrations')!;
    await expect(list.handler({}, ctx)).resolves.toMatchObject({ integrations: [{ id: 'int1', identifier: 'twitter' }] });
    const sched = tools.find((t) => t.name === 'postiz_schedule_post')!;
    expect(sched.mutating).toBe(true);
    expect(postizToolPolicyRules().find((r) => r.toolPattern.includes('schedule'))?.effect).toBe('require-approval');
    await expect(sched.handler({ integrationId: 'int1', content: 'hello', date: '2026-11-01T10:00:00Z' }, ctx)).resolves.toMatchObject({ ok: true, postId: 'p1', immediate: false });
    const body = JSON.parse(String(calls[1].init?.body)) as { type: string; posts: Array<{ integration: { id: string }; value: Array<{ content: string }> }> };
    expect(body.type).toBe('schedule');
    expect(body.posts[0].integration.id).toBe('int1');
    expect(body.posts[0].value[0].content).toBe('hello');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('pk');
  });
  it('missing key and API errors are clean', async () => {
    delete process.env.POSTIZ_API_KEY;
    const [list] = createPostizTools({ fetchImpl: stubFetch(() => ({ body: {} })).fetchImpl });
    await expect(list.handler({}, ctx)).rejects.toThrow(/not configured/);
    const bad = createPostizTools({ fetchImpl: stubFetch(() => ({ status: 500, body: { msg: 'boom' } })).fetchImpl, getApiKey: () => 'k' });
    await expect(bad[0].handler({}, ctx)).rejects.toThrow(/Postiz API error \(500\): boom/);
  });
});

describe('whop-tools', () => {
  it('lists products and memberships (ids/status only) for a company', async () => {
    const { calls, fetchImpl } = stubFetch((url) => url.includes('/products')
      ? { body: { data: [{ id: 'prod_1', title: 'Pro', visibility: 'visible' }], page_info: { has_next_page: false } } }
      : { body: { data: [{ id: 'mem_1', status: 'active', product: { id: 'prod_1' }, user: { id: 'user_1' }, email: 'a@b.c' }], page_info: {} } });
    const tools = createWhopTools({ fetchImpl, getApiKey: () => 'wk', getCompanyId: () => 'biz_12345678' });
    const products = tools.find((t) => t.name === 'whop_list_products')!;
    expect(products.mutating).toBeUndefined();
    await expect(products.handler({}, ctx)).resolves.toMatchObject({ products: [{ id: 'prod_1', title: 'Pro' }] });
    const mems = tools.find((t) => t.name === 'whop_list_memberships')!;
    const out = await mems.handler({}, ctx) as { memberships: Array<Record<string, unknown>> };
    expect(out.memberships[0]).toMatchObject({ id: 'mem_1', status: 'active', productId: 'prod_1', userId: 'user_1' });
    expect(JSON.stringify(out)).not.toContain('a@b.c');
    expect(calls[0].url).toContain('/api/v5/companies/biz_12345678/products');
  });
  it('missing key / bad company errors', async () => {
    delete process.env.WHOP_API_KEY;
    const [p] = createWhopTools({ fetchImpl: stubFetch(() => ({ body: {} })).fetchImpl, getCompanyId: () => 'biz_12345678' });
    await expect(p.handler({}, ctx)).rejects.toThrow(/not configured/);
    const [p2] = createWhopTools({ fetchImpl: stubFetch(() => ({ body: {} })).fetchImpl, getApiKey: () => 'k' });
    await expect(p2.handler({ companyId: 'nope' }, ctx)).rejects.toThrow(/biz_/);
  });
});
