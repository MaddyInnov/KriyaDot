// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyBotApprovalModes,
  getBotApprovalMode,
  sanitizeApprovalMode,
  saveBotApprovalModeForBot,
} from '../src/bot-approval-modes.js';
import type { BotConfig } from '@mvp/agent-runtime';

function testBot(id: string): BotConfig {
  return {
    id,
    name: id,
    description: '',
    systemPrompt: '',
    provider: 'mock',
    model: 'mock',
    skills: [],
    tools: [],
    mcpServers: [],
  };
}

describe('sanitizeApprovalMode', () => {
  it('accepts the three modes, rejects the rest', () => {
    expect(sanitizeApprovalMode('plan')).toBe('plan');
    expect(sanitizeApprovalMode('auto')).toBe('auto');
    expect(sanitizeApprovalMode('bypass')).toBe('bypass');
    expect(sanitizeApprovalMode('yolo')).toBeUndefined();
    expect(sanitizeApprovalMode(undefined)).toBeUndefined();
  });
});

describe('saveBotApprovalModeForBot', () => {
  it('persists and applies to the in-memory bot', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'approval-modes-'));
    const bots = [testBot('b1')];
    const mode = saveBotApprovalModeForBot(dataDir, bots, 'b1', 'plan');
    expect(mode).toBe('plan');
    expect(bots[0]?.approvalMode).toBe('plan');
    expect(getBotApprovalMode(dataDir, 'b1')).toBe('plan');
  });
  it('throws on unknown bot', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'approval-modes-'));
    expect(() => saveBotApprovalModeForBot(dataDir, [testBot('b1')], 'nope', 'plan')).toThrow(
      /Unknown bot/,
    );
  });
  it('throws on invalid mode', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'approval-modes-'));
    expect(() => saveBotApprovalModeForBot(dataDir, [testBot('b1')], 'b1', 'yolo')).toThrow(
      /plan\|auto\|bypass/,
    );
  });
});

describe('applyBotApprovalModes', () => {
  it('applies persisted modes at boot', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'approval-modes-'));
    const bots = [testBot('b1'), testBot('b2')];
    saveBotApprovalModeForBot(dataDir, bots, 'b1', 'bypass');
    // Fresh bots (as at boot) get the overlay applied.
    const fresh = [testBot('b1'), testBot('b2')];
    applyBotApprovalModes(fresh, dataDir);
    expect(fresh[0]?.approvalMode).toBe('bypass');
    expect(fresh[1]?.approvalMode).toBeUndefined();
  });
});
