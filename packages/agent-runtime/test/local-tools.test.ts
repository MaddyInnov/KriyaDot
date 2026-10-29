// SPDX-License-Identifier: Apache-2.0
// Local project tools: .kriyadot/tools/ auto-registration.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLocalToolsCache, discoverLocalTools } from '../src/local-tools.js';

let dir: string;
let toolsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-local-tools-'));
  toolsDir = join(dir, '.kriyadot', 'tools');
  mkdirSync(toolsDir, { recursive: true });
  clearLocalToolsCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearLocalToolsCache();
});

function writeTool(name: string, content: string, executable = true): void {
  const path = join(toolsDir, name);
  writeFileSync(path, content);
  if (executable) chmodSync(path, 0o755);
}

const ECHO_TOOL = `#!/usr/bin/env node
// @tool
// name: echo-args
// description: Echo the JSON args back
// parameters: {"type":"object","properties":{"text":{"type":"string"}}}
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const args = JSON.parse(input || '{}');
  console.log(JSON.stringify({ echoed: args }));
});
`;

describe('discoverLocalTools', () => {
  it('returns empty when the tools dir does not exist', () => {
    const other = mkdtempSync(join(tmpdir(), 'mvp-local-none-'));
    try {
      expect(discoverLocalTools(other)).toEqual({ tools: [], errors: [] });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('registers declared tools with the local: prefix and runs them', async () => {
    writeTool('echo-args.mjs', ECHO_TOOL);
    const { tools, errors } = discoverLocalTools(dir);
    expect(errors).toEqual([]);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('local:echo-args');
    expect(tools[0]!.description).toBe('Echo the JSON args back');
    expect(tools[0]!.mutating).toBe(false);
    const result = await tools[0]!.handler({ text: 'hello' }, { sessionId: 's', botId: 'b' } as never);
    expect(result).toEqual({ echoed: { text: 'hello' } });
  });

  it('skips non-executable declarations with an error', () => {
    writeTool('noexec.mjs', ECHO_TOOL, false);
    const { tools, errors } = discoverLocalTools(dir);
    expect(tools).toEqual([]);
    expect(errors[0]).toContain('not executable');
  });

  it('ignores files without an @tool header', () => {
    writeTool('random.mjs', '#!/usr/bin/env node\nconsole.log(1);\n');
    expect(discoverLocalTools(dir).tools).toEqual([]);
  });

  it('reports invalid parameters JSON and duplicate names', () => {
    writeTool(
      'bad.mjs',
      '#!/usr/bin/env node\n// @tool\n// name: bad\n// parameters: {not json}\nconsole.log(1);\n',
    );
    writeTool('a.mjs', ECHO_TOOL.replace('echo-args', 'dup'));
    writeTool('b.mjs', ECHO_TOOL.replace('echo-args', 'dup'));
    const { tools, errors } = discoverLocalTools(dir);
    expect(tools.map((t) => t.name)).toEqual(['local:dup']);
    expect(errors.some((e) => e.includes('invalid "parameters"'))).toBe(true);
    expect(errors.some((e) => e.includes('duplicate'))).toBe(true);
  });

  it('surfaces non-zero exits as error results', async () => {
    writeTool(
      'fail.mjs',
      '#!/usr/bin/env node\n// @tool\n// name: failer\ndescript: x\nconsole.error("it broke");\nprocess.exit(3);\n'.replace(
        'descript: x',
        '// description: Always fails',
      ),
    );
    const { tools } = discoverLocalTools(dir);
    const result = (await tools[0]!.handler({}, { sessionId: 's', botId: 'b' } as never)) as {
      error?: string;
    };
    expect(result.error).toContain('exited 3');
    expect(result.error).toContain('it broke');
  });

  it('honors the mutating flag', () => {
    writeTool(
      'mut.mjs',
      '#!/usr/bin/env node\n// @tool\n// name: mutator\n// mutating: true\nconsole.log("{}");\n',
    );
    expect(discoverLocalTools(dir).tools[0]!.mutating).toBe(true);
  });
});
