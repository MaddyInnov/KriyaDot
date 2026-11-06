// SPDX-License-Identifier: Apache-2.0
// Cloud host + deploy tests — salvaged from the former cloud adapter test
// file and adapted to FakeCloudHostClient. Every client is the fake; no
// real cloud host account, no subprocess, no network.
import { describe, it, expect } from 'vitest';
import {
  FakeCloudHostClient,
  InMemoryCloudSecretStore,
  extractPublicUrls,
  mapCloudHostStatus,
  readCloudHostCredentials,
} from '../src/cloud-host.js';
import { deployKriyadot, OLLAMA_DEFAULT_MODEL } from '../src/cloud-deploy.js';

describe('mapCloudHostStatus / extractPublicUrls', () => {
  it('maps raw statuses onto the KriyaDot vocabulary', () => {
    expect(mapCloudHostStatus('Running')).toBe('running');
    expect(mapCloudHostStatus('sleeping')).toBe('sleeping');
    expect(mapCloudHostStatus('Stopped')).toBe('stopped');
    expect(mapCloudHostStatus('provisioning')).toBe('starting');
    expect(mapCloudHostStatus('???')).toBe('unknown');
  });

  it('extracts the port-named URL, falling back to the first https URL', () => {
    const text = 'app at https://instance-8080.example.com/ and docs https://example.com/docs';
    expect(extractPublicUrls(text, [8080])[8080]).toBe('https://instance-8080.example.com/');
    expect(extractPublicUrls('see https://abc.example.com/x', [9000])[9000]).toBe(
      'https://abc.example.com/x',
    );
    expect(extractPublicUrls('no urls', [8080])).toEqual({});
  });
});

describe('secret store + credentials', () => {
  it('round-trips the pair and reports undefined when incomplete', () => {
    const store = new InMemoryCloudSecretStore();
    expect(readCloudHostCredentials(store, 'u1')).toBeUndefined();
    store.set('u1', 'cloud-host-account', 'acct-1');
    expect(readCloudHostCredentials(store, 'u1')).toBeUndefined();
    store.set('u1', 'cloud-host-api-key', 'key-1');
    expect(readCloudHostCredentials(store, 'u1')).toEqual({ accountId: 'acct-1', apiKey: 'key-1' });
    store.delete('u1', 'cloud-host-api-key');
    expect(readCloudHostCredentials(store, 'u1')).toBeUndefined();
    // per-user isolation
    expect(readCloudHostCredentials(store, 'u2')).toBeUndefined();
  });
});

describe('deployKriyadot step sequence (FakeCloudHostClient)', () => {
  it('runs the exact scripted sequence without Ollama', async () => {
    const fake = new FakeCloudHostClient([{ name: 'kriyadot', state: 'running' }]);
    const result = await deployKriyadot(fake, {
      repoUrl: 'https://github.com/example/kriyadot.git',
      providerEnv: { OPENAI_API_KEY: 'sk-from-vault' },
    });
    expect(result.ok).toBe(true);
    expect(result.instance).toBe('kriyadot');
    expect(result.steps.map((s) => s.name)).toEqual([
      'ensure-instance',
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
    // warning is honest about reachability vs always-on
    expect(result.warnings.join(' ')).toMatch(/not always running|always REACHABLE/);
  });

  it('with Ollama: installs, pulls exactly ONE model, registers the local provider', async () => {
    const fake = new FakeCloudHostClient([{ name: 'kriyadot', state: 'running' }]);
    const result = await deployKriyadot(fake, {
      repoUrl: 'https://github.com/example/kriyadot.git',
      ollama: { enabled: true },
    });
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual([
      'ensure-instance',
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
    expect(result.ollama?.driveNote).toMatch(/exactly one model/);
    const envCmd = fake.runCommands.find((c) => c.includes('.env.cloud')) ?? '';
    const b64 = /printf %s '([^']+)'/.exec(envCmd)?.[1] ?? '';
    const envText = Buffer.from(b64, 'base64').toString('utf8');
    expect(envText).toContain('KRIYADOT_LOCAL_PROVIDER=ollama');
    expect(envText).toContain(`KRIYADOT_LOCAL_MODEL=${OLLAMA_DEFAULT_MODEL}`);
  });

  it('rejects a multi-model Ollama request (exactly one pre-pull)', async () => {
    const fake = new FakeCloudHostClient();
    await expect(
      deployKriyadot(fake, {
        repoUrl: 'https://github.com/example/kriyadot.git',
        ollama: { enabled: true, model: 'qwen3:4b,llama3.2:3b' },
      }),
    ).rejects.toThrow(/exactly ONE/);
  });

  it('aborts on a failing step and does not run later steps', async () => {
    const fake = new FakeCloudHostClient([{ name: 'kriyadot', state: 'running' }]);
    fake.runResponses = [{ match: 'git clone', result: { stdout: '', stderr: 'repo not found', exitCode: 128 } }];
    const result = await deployKriyadot(fake, { repoUrl: 'https://github.com/example/nope.git' });
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.name)).toEqual(['ensure-instance', 'runtime', 'source']);
    expect(result.steps[2].detail).toContain('repo not found');
    expect(fake.runCommands.some((c) => c.includes('npm ci'))).toBe(false);
  });

  it('rejects an invalid repoUrl before any instance call', async () => {
    const fake = new FakeCloudHostClient();
    await expect(deployKriyadot(fake, { repoUrl: 'not a url; rm -rf /' })).rejects.toThrow(/repoUrl/);
    expect(fake.calls).toEqual([]);
  });
});
