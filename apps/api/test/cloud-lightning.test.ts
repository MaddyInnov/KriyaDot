// SPDX-License-Identifier: Apache-2.0
// Cloud layer adapter tests — every subprocess is a fake runner and every
// client is FakeLightningClient. No real Lightning account, no network.
import { describe, it, expect } from 'vitest';
import {
  CliLightningClient,
  FakeLightningClient,
  InMemoryCloudSecretStore,
  extractPublicUrls,
  mapLightningStatus,
  readLightningCredentials,
  type CommandRunner,
} from '../src/cloud-lightning.js';
import { deployKriyadot, OLLAMA_DEFAULT_MODEL } from '../src/cloud-deploy.js';

describe('mapLightningStatus / extractPublicUrls', () => {
  it('maps raw statuses onto the KriyaDot vocabulary', () => {
    expect(mapLightningStatus('Running')).toBe('running');
    expect(mapLightningStatus('sleeping')).toBe('sleeping');
    expect(mapLightningStatus('Stopped')).toBe('stopped');
    expect(mapLightningStatus('provisioning')).toBe('starting');
    expect(mapLightningStatus('???')).toBe('unknown');
  });

  it('extracts the port-named URL, falling back to the first Lightning URL', () => {
    const text = 'app at https://studio-8080.lightning.ai/ and docs https://lightning.ai/docs';
    expect(extractPublicUrls(text, [8080])[8080]).toBe('https://studio-8080.lightning.ai/');
    expect(extractPublicUrls('see https://abc.lightning.ai/x', [9000])[9000]).toBe(
      'https://abc.lightning.ai/x',
    );
    expect(extractPublicUrls('no urls', [8080])).toEqual({});
  });
});

describe('secret store + credentials', () => {
  it('round-trips the pair and reports undefined when incomplete', () => {
    const store = new InMemoryCloudSecretStore();
    expect(readLightningCredentials(store, 'u1')).toBeUndefined();
    store.set('u1', 'lightning-user-id', 'lu-1');
    expect(readLightningCredentials(store, 'u1')).toBeUndefined();
    store.set('u1', 'lightning-api-key', 'lk-1');
    expect(readLightningCredentials(store, 'u1')).toEqual({ userId: 'lu-1', apiKey: 'lk-1' });
    store.delete('u1', 'lightning-api-key');
    expect(readLightningCredentials(store, 'u1')).toBeUndefined();
    // per-user isolation
    expect(readLightningCredentials(store, 'u2')).toBeUndefined();
  });
});

describe('CliLightningClient (injectable runner)', () => {
  function recordingRunner(handler: (cmd: string, args: string[]) => { stdout: string; stderr: string; exitCode: number }) {
    const seen: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    const runner: CommandRunner = async (cmd, args, opts) => {
      seen.push({ cmd, args, env: opts?.env });
      return handler(cmd, args);
    };
    return { runner, seen };
  }

  it('passes credentials via env only — never in argv', async () => {
    const { runner, seen } = recordingRunner(() => ({
      stdout: JSON.stringify([{ name: 'kriyadot', status: 'running', machine: 'CPU-4' }]),
      stderr: '',
      exitCode: 0,
    }));
    const client = new CliLightningClient({
      credentials: { userId: 'lu-9', apiKey: 'lk-secret' },
      runner,
    });
    const studios = await client.listStudios();
    expect(studios[0]).toMatchObject({ name: 'kriyadot', state: 'running', machine: 'CPU-4' });
    expect(seen[0].env).toEqual({ LIGHTNING_USER_ID: 'lu-9', LIGHTNING_API_KEY: 'lk-secret' });
    expect(seen.flatMap((s) => s.args).join(' ')).not.toContain('lk-secret');
    expect(seen[0].cmd).toBe('lightning');
    expect(seen[0].args.slice(0, 2)).toEqual(['studio', 'list']);
  });

  it('verifyCredentials is false on a non-zero exit', async () => {
    const { runner } = recordingRunner(() => ({ stdout: '', stderr: 'bad key', exitCode: 1 }));
    const client = new CliLightningClient({ credentials: { userId: 'x', apiKey: 'y' }, runner });
    expect(await client.verifyCredentials()).toEqual({ ok: false, detail: 'bad key' });
  });

  it('ensureStudio creates with --create only when missing', async () => {
    let listed: unknown[] = [];
    const { runner, seen } = recordingRunner((_cmd, args) => {
      if (args.includes('list')) return { stdout: JSON.stringify(listed), stderr: '', exitCode: 0 };
      if (args.includes('start')) {
        listed = [{ name: 'kriyadot', status: 'starting' }];
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const client = new CliLightningClient({ credentials: { userId: 'x', apiKey: 'y' }, runner });
    const studio = await client.ensureStudio('kriyadot');
    expect(studio.state).toBe('starting');
    const startCall = seen.find((s) => s.args.includes('start'));
    expect(startCall?.args).toContain('--create');
    // Second ensure: already exists → no further start call.
    const before = seen.filter((s) => s.args.includes('start')).length;
    await client.ensureStudio('kriyadot');
    expect(seen.filter((s) => s.args.includes('start')).length).toBe(before);
  });

  it('runInStudio goes through python lightning_sdk with name+command as argv', async () => {
    const { runner, seen } = recordingRunner(() => ({ stdout: 'ok-out', stderr: '', exitCode: 0 }));
    const client = new CliLightningClient({ credentials: { userId: 'x', apiKey: 'y' }, runner });
    const res = await client.runInStudio('kriyadot', 'echo hi');
    expect(res.stdout).toBe('ok-out');
    expect(seen[0].cmd).toBe('python3');
    expect(seen[0].args[0]).toBe('-c');
    expect(seen[0].args[1]).toContain('lightning_sdk');
    expect(seen[0].args.slice(2)).toEqual(['kriyadot', 'echo hi']);
  });
});

describe('deployKriyadot step sequence (FakeLightningClient)', () => {
  it('runs the exact scripted sequence without Ollama', async () => {
    const fake = new FakeLightningClient([{ name: 'kriyadot', state: 'running' }]);
    const result = await deployKriyadot(fake, {
      repoUrl: 'https://github.com/example/kriyadot.git',
      providerEnv: { OPENAI_API_KEY: 'sk-from-vault' },
    });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual([
      'ensure-studio',
      'runtime',
      'source',
      'install',
      'env-file',
      'supervisor-script',
      'start',
      'public-url',
    ]);
    const cmds = fake.runCommands;
    expect(cmds[0]).toContain('command -v node');
    expect(cmds[1]).toContain('git clone');
    expect(cmds[1]).toContain('https://github.com/example/kriyadot.git');
    expect(cmds[2]).toContain('npm ci');
    // env-file: base64 payload decodes to the env file incl. the vault key
    const envCmd = cmds[3];
    const b64 = /printf %s '([^']+)'/.exec(envCmd)?.[1] ?? '';
    const envText = Buffer.from(b64, 'base64').toString('utf8');
    expect(envText).toContain('OPENAI_API_KEY=sk-from-vault');
    expect(envText).toContain('PORT=8080');
    expect(envCmd).toContain('chmod 600');
    // supervisor script contains no secrets
    const supB64 = /printf %s '([^']+)'/.exec(cmds[4])?.[1] ?? '';
    const supText = Buffer.from(supB64, 'base64').toString('utf8');
    expect(supText).not.toContain('sk-from-vault');
    expect(supText).toContain('.env.cloud');
    expect(cmds[5]).toContain('nohup');
    // warning is honest about the free tier
    expect(result.warnings.join(' ')).toMatch(/not always running|always REACHABLE/);
  });

  it('with Ollama: installs, pulls exactly ONE model, registers the local provider', async () => {
    const fake = new FakeLightningClient([{ name: 'kriyadot', state: 'running' }]);
    const result = await deployKriyadot(fake, {
      repoUrl: 'https://github.com/example/kriyadot.git',
      ollama: { enabled: true },
    });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual([
      'ensure-studio',
      'runtime',
      'source',
      'ollama-install',
      'ollama-pull',
      'ollama-serve',
      'install',
      'env-file',
      'supervisor-script',
      'start',
      'public-url',
    ]);
    const pulls = fake.runCommands.filter((c) => c.includes('ollama pull'));
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toContain(OLLAMA_DEFAULT_MODEL);
    expect(result.ollama?.model).toBe(OLLAMA_DEFAULT_MODEL);
    expect(result.ollama?.driveNote).toMatch(/10 GB/);
    const envCmd = fake.runCommands.find((c) => c.includes('.env.cloud')) ?? '';
    const b64 = /printf %s '([^']+)'/.exec(envCmd)?.[1] ?? '';
    const envText = Buffer.from(b64, 'base64').toString('utf8');
    expect(envText).toContain('KRIYADOT_LOCAL_PROVIDER=ollama');
    expect(envText).toContain(`KRIYADOT_LOCAL_MODEL=${OLLAMA_DEFAULT_MODEL}`);
  });

  it('rejects a multi-model Ollama request (exactly one pre-pull)', async () => {
    const fake = new FakeLightningClient();
    await expect(
      deployKriyadot(fake, {
        repoUrl: 'https://github.com/example/kriyadot.git',
        ollama: { enabled: true, model: 'qwen3:4b,llama3.2:3b' },
      }),
    ).rejects.toThrow(/exactly ONE/);
  });

  it('aborts on a failing step and does not run later steps', async () => {
    const fake = new FakeLightningClient([{ name: 'kriyadot', state: 'running' }]);
    fake.runResponses = [{ match: 'git clone', result: { stdout: '', stderr: 'repo not found', exitCode: 128 } }];
    const result = await deployKriyadot(fake, { repoUrl: 'https://github.com/example/nope.git' });
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.name)).toEqual(['ensure-studio', 'runtime', 'source']);
    expect(result.steps[2].detail).toContain('repo not found');
    expect(fake.runCommands.some((c) => c.includes('npm ci'))).toBe(false);
  });

  it('rejects an invalid repoUrl before any Studio call', async () => {
    const fake = new FakeLightningClient();
    await expect(deployKriyadot(fake, { repoUrl: 'not a url; rm -rf /' })).rejects.toThrow(/repoUrl/);
    expect(fake.calls).toEqual([]);
  });
});
