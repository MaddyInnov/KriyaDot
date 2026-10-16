// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  detectAgentSources,
  loadImportPayload,
  previewAgentImport,
  redactSecrets,
  renderKriyaDotSkill,
  sanitizeSkillName,
  type ImportFs,
} from '../src/agent-import.js';

/** In-memory filesystem for tests — never touches the real home dir. */
function makeFs(files: Record<string, string>): ImportFs {
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    exists: (p) => p in files || dirs.has(p),
    isDir: (p) => dirs.has(p),
    readDir: (p) => {
      const prefix = p.endsWith('/') ? p : p + '/';
      const out = new Set<string>();
      for (const f of Object.keys(files)) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          out.add(rest.split('/')[0]);
        }
      }
      for (const d of dirs) {
        if (d.startsWith(prefix)) {
          const rest = d.slice(prefix.length);
          if (rest && !rest.includes('/')) out.add(rest);
        }
      }
      return [...out];
    },
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
}

const HOME = '/home/testuser';

describe('redactSecrets', () => {
  it('redacts Anthropic and OpenAI-style keys', () => {
    expect(redactSecrets('key sk-ant-abc123XYZ789 here')).toContain('[REDACTED]');
    expect(redactSecrets('key sk-ant-abc123XYZ789 here')).not.toContain('sk-ant-');
  });
  it('redacts key=value secrets but keeps the key name', () => {
    const out = redactSecrets('api_key: "supersecret123"');
    expect(out).toContain('api_key:');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('supersecret123');
  });
  it('redacts Bearer tokens and passwords', () => {
    expect(redactSecrets('Authorization: Bearer abcdef123456')).toContain('Bearer [REDACTED]');
    expect(redactSecrets('password=hunter2hunter')).not.toContain('hunter2hunter');
  });
  it('leaves clean text alone', () => {
    expect(redactSecrets('Use git commit for changes.')).toBe('Use git commit for changes.');
  });
});

describe('sanitizeSkillName', () => {
  it('kebab-cases and strips unsafe chars', () => {
    expect(sanitizeSkillName('My Cool Skill!')).toBe('my-cool-skill');
    expect(sanitizeSkillName('../../evil')).toBe('evil');
  });
  it('falls back for empty names', () => {
    expect(sanitizeSkillName('!!!')).toBe('imported-skill');
  });
});

describe('detectAgentSources', () => {
  it('detects nothing on an empty home', () => {
    const detections = detectAgentSources(HOME, makeFs({}));
    expect(detections).toHaveLength(6);
    expect(detections.every((d) => !d.present)).toBe(true);
  });
  it('detects Claude Code with counts', () => {
    const fs = makeFs({
      [`${HOME}/.claude/skills/pdf/SKILL.md`]:
        '---\nname: pdf\ndescription: Work with PDFs.\n---\n\nBody.',
      [`${HOME}/.claude/CLAUDE.md`]: 'Always run tests.',
      [`${HOME}/.claude/projects/myproj/abc123.jsonl`]:
        '{"type":"user","message":{"role":"user","content":"hi"},"timestamp":1}\n',
      [`${HOME}/.claude.json`]: '{"model":"claude-x"}',
    });
    const detections = detectAgentSources(HOME, fs);
    const cc = detections.find((d) => d.id === 'claude-code')!;
    expect(cc.present).toBe(true);
    expect(cc.counts.skills).toBe(1);
    expect(cc.counts.sessions).toBe(1);
    expect(cc.counts.memoryFiles).toBe(1);
    expect(cc.counts.configs).toBe(1);
  });
  it('detects Codex and OpenCode', () => {
    const fs = makeFs({
      [`${HOME}/.codex/sessions/s1.jsonl`]: '{"role":"user","content":"hello"}\n',
      [`${HOME}/.codex/config.toml`]: 'model = "gpt-x"',
      [`${HOME}/.config/opencode/command/review.md`]: '# Review\n\nDo a review.',
      [`${HOME}/.config/opencode/opencode.json`]: '{"model":"m"}',
    });
    const detections = detectAgentSources(HOME, fs);
    expect(detections.find((d) => d.id === 'codex')!.present).toBe(true);
    expect(detections.find((d) => d.id === 'codex')!.counts.sessions).toBe(1);
    const oc = detections.find((d) => d.id === 'opencode')!;
    expect(oc.present).toBe(true);
    expect(oc.counts.skills).toBe(1);
  });
  it('never throws on unreadable layouts', () => {
    const fs: ImportFs = {
      exists: () => true,
      isDir: () => {
        throw new Error('boom');
      },
      readDir: () => [],
      readFile: () => '',
    };
    expect(() => detectAgentSources(HOME, fs)).not.toThrow();
  });
});

describe('previewAgentImport', () => {
  const claudeFs = makeFs({
    [`${HOME}/.claude/skills/pdf/SKILL.md`]:
      '---\nname: pdf\ndescription: Work with PDF files.\n---\n\nExtract text with api_key: "secret123".',
    [`${HOME}/.claude/CLAUDE.md`]: 'Always use TypeScript. password=hunter2',
    [`${HOME}/.claude/projects/proj/sess1.jsonl`]:
      '{"type":"user","message":{"role":"user","content":"build it"},"timestamp":1}\n' +
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]},"timestamp":2}\n',
    [`${HOME}/.claude.json`]: '{"model":"claude-x","customInstructions":"Be terse."}',
  });

  it('previews skills, memory, sessions, and a bot proposal', () => {
    const preview = previewAgentImport('claude-code', HOME, claudeFs);
    expect(preview.items.some((i) => i.kind === 'skill' && i.id === 'skill:claude-code:pdf')).toBe(true);
    expect(preview.items.some((i) => i.kind === 'memory')).toBe(true);
    const session = preview.items.find((i) => i.kind === 'session')!;
    expect(session.lossy).toMatch(/Tool calls/);
    expect(preview.botProposal?.name).toBe('Claude Code Import');
    expect(preview.botProposal?.systemPrompt).toBe('Be terse.');
  });
  it('redacts secrets in excerpts', () => {
    const preview = previewAgentImport('claude-code', HOME, claudeFs);
    const skill = preview.items.find((i) => i.kind === 'skill')!;
    expect(skill.excerpt).not.toContain('secret123');
    const memory = preview.items.find((i) => i.kind === 'memory')!;
    expect(memory.excerpt).not.toContain('hunter2');
  });
  it('includes the bot proposal as a selectable item', () => {
    const preview = previewAgentImport('claude-code', HOME, claudeFs);
    const botItem = preview.items.find((i) => i.kind === 'bot');
    expect(botItem?.id).toBe('bot:claude-code');
    expect(botItem?.title).toMatch(/Create bot/);
  });
  it('throws on unknown source', () => {
    expect(() => previewAgentImport('nope' as never, HOME, claudeFs)).toThrow(/Unknown agent source/);
  });
  it('previews opencode commands as skills', () => {
    const fs = makeFs({
      [`${HOME}/.config/opencode/command/review.md`]: '# Review\n\nDo a code review.',
    });
    const preview = previewAgentImport('opencode', HOME, fs);
    expect(preview.items.some((i) => i.kind === 'skill' && i.id === 'skill:opencode:review')).toBe(true);
  });
});

describe('loadImportPayload', () => {
  const claudeFs = makeFs({
    [`${HOME}/.claude/skills/pdf/SKILL.md`]:
      '---\nname: pdf\ndescription: Work with PDF files.\n---\n\nBody with sk-ant-abc123XYZ789 inside.',
    [`${HOME}/.claude/CLAUDE.md`]: 'I prefer concise answers.',
    [`${HOME}/.claude/projects/proj/sess1.jsonl`]:
      '{"type":"user","message":{"role":"user","content":"build it"},"timestamp":1}\n' +
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]},"timestamp":2}\n',
  });

  it('loads only selected items with secrets redacted', () => {
    const payload = loadImportPayload(
      'claude-code',
      HOME,
      ['skill:claude-code:pdf', 'memory:claude-code:.claude/CLAUDE.md', 'session:claude-code:.claude/projects/proj/sess1.jsonl'],
      claudeFs,
    );
    expect(payload.skills).toHaveLength(1);
    expect(payload.skills[0].content).not.toContain('sk-ant-');
    expect(payload.memories).toHaveLength(1);
    expect(payload.memories[0].category).toBe('preference');
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0].messages).toHaveLength(2);
    expect(payload.sessions[0].messages[0]).toEqual({ role: 'user', content: 'build it' });
  });
  it('returns empty payload for unknown ids', () => {
    const payload = loadImportPayload('claude-code', HOME, ['skill:claude-code:nope'], claudeFs);
    expect(payload.skills).toHaveLength(0);
  });
  it('parses generic session files best-effort', () => {
    const fs = makeFs({
      [`${HOME}/.codex/sessions/s1.jsonl`]:
        '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi there"}\n',
    });
    const payload = loadImportPayload(
      'codex',
      HOME,
      ['session:codex:.codex/sessions/s1.jsonl'],
      fs,
    );
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0].messages.map((m) => m.content)).toEqual(['hello', 'hi there']);
  });
});

describe('renderKriyaDotSkill', () => {
  it('renders frontmatter format', () => {
    const out = renderKriyaDotSkill('pdf', 'Work with PDFs.', '---\nname: pdf\n---\n\nBody.');
    expect(out).toMatch(/^---\nname: pdf\ndescription: Work with PDFs\./);
    expect(out).toContain('Body.');
  });
});
