// SPDX-License-Identifier: Apache-2.0
// P-17: read-only permission inspection tools for agents.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolContext, ToolDefinition } from '@mvp/agent-runtime';
import type { ApprovalRecord } from '@mvp/governance';
import {
  PERMISSIONS_TOOL_NAMES,
  createPermissionsTools,
  permissionsToolsPolicyRules,
  registerPermissionsTools,
} from '../src/permissions-tools.js';
import { createAllowance, putItemOverride } from '../src/permissions-pane.js';
import { rememberAllowedTool } from '../src/bot-policies.js';

const CTX = { sessionId: 's-1', botId: 'bot-1' } as ToolContext;
const BOTS = [{ id: 'bot-1', name: 'Helper', tools: [] }] as never[];

function makeTools(dir: string) {
  const pending: ApprovalRecord[] = [
    {
      id: 'ap-1',
      ts: 1234,
      sessionId: 's-1',
      botId: 'bot-1',
      actor: 'bot-1',
      toolName: 'write_file',
      args: { path: 'x', secret: 'should-not-leak' },
      status: 'pending',
    },
  ];
  return createPermissionsTools({
    dataDir: dir,
    bots: BOTS,
    listApprovals: (status) => (status === 'pending' ? pending : []),
  });
}

function byName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe('permissions inspection tools (P-17)', () => {
  it('exposes exactly the three read-only tools and an allow policy rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'permissions-tools-'));
    const tools = makeTools(dir);
    expect(tools.map((t) => t.name)).toEqual([...PERMISSIONS_TOOL_NAMES]);
    for (const tool of tools) expect(tool.mutating).toBeUndefined();
    const rules = permissionsToolsPolicyRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.effect).toBe('allow');
    const registry = new Map<string, ToolDefinition>();
    registerPermissionsTools({ registry, dataDir: dir, bots: BOTS, listApprovals: () => [] });
    expect([...registry.keys()]).toEqual([...PERMISSIONS_TOOL_NAMES]);
  });

  it('list_pending_approvals summarizes without echoing approval args', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'permissions-tools-'));
    const result = (await byName(makeTools(dir), 'list_pending_approvals').handler({}, CTX)) as {
      count: number;
      pending: Array<{ id: string; toolName: string; createdAt: number }>;
    };
    expect(result.count).toBe(1);
    expect(result.pending[0]).toEqual({ id: 'ap-1', toolName: 'write_file', botId: 'bot-1', createdAt: 1234 });
    expect(JSON.stringify(result)).not.toContain('should-not-leak');
  });

  it('list_allowances and list_active_grants reflect the pane stores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'permissions-tools-'));
    createAllowance(dir, 'default-user', { kind: 'recipient', target: 'friend@example.com', actions: ['send'], scope: {} });
    putItemOverride(dir, 'default-user', 'task', 'task-9', { send: 'allow' });
    rememberAllowedTool(dir, BOTS as never[], 'bot-1', 'web_search');

    const tools = makeTools(dir);
    const allowances = (await byName(tools, 'list_allowances').handler({}, CTX)) as { count: number; allowances: Array<{ target: string }> };
    expect(allowances.count).toBe(1);
    expect(allowances.allowances[0]!.target).toBe('friend@example.com');

    const grants = (await byName(tools, 'list_active_grants').handler({}, CTX)) as {
      alwaysAllow: Array<{ ruleId: string }>;
      allowances: unknown[];
      itemOverrides: Array<{ key: string }>;
    };
    expect(grants.alwaysAllow.map((g) => g.ruleId)).toContain('user-allow-web_search');
    expect(grants.allowances).toHaveLength(1);
    expect(grants.itemOverrides.map((i) => i.key)).toContain('task:task-9');
  });
});
