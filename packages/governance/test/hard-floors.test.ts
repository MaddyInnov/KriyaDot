// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { GovernanceGateway } from '../src/gateway.js';
import { DEFAULT_POLICY } from '../src/default-policy.js';
import { checkHardFloor, HARD_FLOOR_PATTERNS } from '../src/hard-floors.js';

function makeGateway() {
  return new GovernanceGateway({ dbPath: ':memory:', policy: DEFAULT_POLICY });
}

describe('hard floors', () => {
  it('has built-in patterns', () => {
    expect(HARD_FLOOR_PATTERNS.length).toBeGreaterThan(0);
    const ids = HARD_FLOOR_PATTERNS.map((p) => p.id);
    expect(ids).toContain('catastrophic-shell');
    expect(ids).toContain('destructive-shell');
    expect(ids).toContain('file-escape-workspace');
  });

  it('hits on destructive shell commands', () => {
    expect(checkHardFloor('run_command', { command: 'rm -rf /' })).not.toBeNull();
    expect(checkHardFloor('run_command', { command: 'sudo apt update' })).not.toBeNull();
    expect(checkHardFloor('run_command', { command: 'echo hello' })).toBeNull();
  });

  it('hits on absolute/escaping file paths', () => {
    expect(checkHardFloor('write_file', { path: '/etc/passwd' })).not.toBeNull();
    expect(checkHardFloor('delete_file', { path: '../../secret' })).not.toBeNull();
    expect(checkHardFloor('write_file', { path: 'notes/todo.md' })).toBeNull();
  });

  it('classifies shell floors into catastrophic vs destructive tiers', () => {
    // Tier 1: unconditional denial, never approvable.
    for (const command of [
      'rm -rf /',
      'rm -rf ~',
      'rm -rf $HOME',
      'rm -rf ${HOME}/',
      'mkfs.ext4 /dev/sda1',
      'dd if=/dev/zero of=/dev/sda bs=1M',
      'cat backup.iso > /dev/sdb',
      'find / -delete',
      'shred -u secret.txt',
      'wipefs -a /dev/sdb',
      'fdisk /dev/sda',
      ':(){ :|:& };:',
    ]) {
      const hit = checkHardFloor('run_command', { command });
      expect(hit?.tier).toBe('catastrophic');
      expect(hit?.patternId).toBe('catastrophic-shell');
    }
    // Tier 2: destructive-but-recoverable → human approval.
    for (const command of ['sudo apt update', 'shutdown -h now', 'chmod -R 777 /']) {
      const hit = checkHardFloor('run_command', { command });
      expect(hit?.tier).toBe('destructive');
      expect(hit?.patternId).toBe('destructive-shell');
    }
    // A dd read (no raw-device write) is destructive, not catastrophic.
    expect(checkHardFloor('run_command', { command: 'dd if=/dev/sda of=backup.img' })?.tier).toBe(
      'destructive',
    );
  });

  it('catches rm flag variants (M1): -rfv, extra long flags, --preserve-root=no', () => {
    // These used to slip past the (-r -f | -rf?) flag group and become
    // merely human-approvable instead of never-approvable denials.
    for (const command of [
      'rm -rfv /etc',
      'rm -rf --one-file-system /',
      'rm -rfv --preserve-root=no /',
      'rm --recursive --force /',
      'rm -rfi /tmp/cache',
      'sudo rm -rfv /usr',
    ]) {
      const hit = checkHardFloor('run_command', { command });
      expect(hit?.tier).toBe('catastrophic');
      expect(hit?.patternId).toBe('catastrophic-shell');
    }
  });

  it('keeps existing rm semantics: system-dir targets stay catastrophic, workspace paths stay clean', () => {
    // Existing behavior preserved: /tmp is a listed system dir, so this was
    // (and stays) catastrophic, not merely dangerous.
    expect(checkHardFloor('run_command', { command: 'rm -rf /tmp/foo' })?.tier).toBe(
      'catastrophic',
    );
    expect(checkHardFloor('run_command', { command: 'rm -r /var/log' })?.tier).toBe(
      'catastrophic',
    );
    // A `--` ends flag parsing: `rm -- -rf /` deletes a file literally
    // named "-rf" (and fails on `/` without -r) — not catastrophic.
    expect(checkHardFloor('run_command', { command: 'rm -- -rf /' })).toBeNull();
    // Workspace-relative deletes are untouched by the catastrophic floor.
    expect(checkHardFloor('run_command', { command: 'rm -rf ./build' })).toBeNull();
    expect(checkHardFloor('run_command', { command: 'rm -rf workspace/out.txt' })).toBeNull();
    // Force without recursive on a directory is not catastrophic.
    expect(checkHardFloor('run_command', { command: 'rm -f /' })).toBeNull();
  });

  it('scopes ${IFS} to destructive combinations only (L3)', () => {
    // Bare ${IFS} is a legitimate shell feature — no longer a floor hit.
    expect(checkHardFloor('run_command', { command: 'echo ${IFS}hello' })).toBeNull();
    expect(checkHardFloor('run_command', { command: 'for w in a${IFS}b; do echo $w; done' })).toBeNull();
    // Combined with a destructive payload it stays catastrophic.
    expect(
      checkHardFloor('run_command', { command: 'eval${IFS}rm${IFS}-rf${IFS}/' })?.tier,
    ).toBe('catastrophic');
    expect(
      checkHardFloor('run_command', { command: 'x=${IFS}; dd${x}if=/dev/zero${x}of=/dev/sda' })
        ?.tier,
    ).toBe('catastrophic');
  });

  it('gateway denies catastrophic hard floors even with allow-all policy', async () => {
    const gw = makeGateway();
    const res = await gw.evaluate(
      'run_command',
      { command: 'rm -rf /' },
      { sessionId: 's1', botId: 'b1', actor: 'a1' },
    );
    expect(res.effect).toBe('deny');
    expect(res.approvalId).toBeUndefined();
  });

  it('gateway still escalates destructive hard floors to human approval', async () => {
    const gw = makeGateway();
    const res = await gw.evaluate(
      'write_file',
      { path: '/etc/passwd' },
      { sessionId: 's1', botId: 'b1', actor: 'a1' },
    );
    expect(res.effect).toBe('require-approval');
    expect(res.approvalId).toBeDefined();
    const rec = gw.getApproval(res.approvalId!);
    expect(rec?.provenance).toBe('hard-floor-escalated');
    gw.close();
  });

  it('respects enabled: false', () => {
    expect(
      checkHardFloor('run_command', { command: 'rm -rf /' }, { enabled: false }),
    ).toBeNull();
  });

  it('allows user-added extra patterns but never removal of built-ins', () => {
    const hit = checkHardFloor(
      'custom_tool',
      { action: 'nuke' },
      { enabled: true, extraPatterns: [{ id: 'custom', toolPattern: '^custom_tool$' }] },
    );
    expect(hit?.patternId).toBe('custom');
    // Built-ins still active alongside extras.
    expect(
      checkHardFloor(
        'run_command',
        { command: 'sudo x' },
        { enabled: true, extraPatterns: [{ id: 'custom', toolPattern: '^custom_tool$' }] },
      ),
    ).not.toBeNull();
  });
});
