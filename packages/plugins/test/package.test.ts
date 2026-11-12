// SPDX-License-Identifier: Apache-2.0
// A9: signed plugin packages — sign/verify/trust, the manager's signature
// gate (refused by default, explicit untrusted path), hot install, the
// declarative-provider manifest shape, and declared-secret injection.
// Everything is local: packages are built in-test, the only child process
// is the shipped demo toolkit / a tiny fixture plugin, zero network.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PluginInstallDenied,
  PluginManager,
  PluginNotFoundError,
  PluginSignatureError,
  PluginTrustStore,
  computePackageDigest,
  createSignedPluginPackage,
  createZipArchive,
  generatePluginPublisherKeyPair,
  pluginKeyId,
  signPackageFiles,
  validateManifest,
  verifyPackageFiles,
  verifyPluginPackage,
  type PackageFileEntry,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(HERE, '..', 'examples');

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'plugins-a9-test-'));
}

const approveAll = () => true;

function demoToolkitFiles(): PackageFileEntry[] {
  return [
    { name: 'plugin.json', data: readFileSync(join(EXAMPLES, 'demo-toolkit', 'plugin.json')) },
    { name: 'index.js', data: readFileSync(join(EXAMPLES, 'demo-toolkit', 'index.js')) },
  ];
}

function providerManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fake-llm-plugin',
    name: 'Fake LLM Provider',
    version: '1.0.0',
    description: 'Manifest-only declarative provider for tests',
    kinds: ['provider'],
    secrets: ['FAKE_LLM_API_KEY'],
    provider: {
      providerId: 'fake-llm',
      displayName: 'Fake LLM',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKeyEnv: 'FAKE_LLM_API_KEY',
      liveModels: true,
    },
    ...overrides,
  };
}

describe('package signing + verification', () => {
  it('sign → verify round-trips as verified under the publisher key', () => {
    const kp = generatePluginPublisherKeyPair();
    expect(kp.keyId).toBe(pluginKeyId(kp.publicKey));
    const pkg = createSignedPluginPackage(demoToolkitFiles(), kp);
    const v = verifyPluginPackage(pkg, [kp.publicKey]);
    expect(v.status).toBe('verified');
    expect(v.keyId).toBe(kp.keyId);
    expect(v.trusted).toBe(true);
  });

  it('digest is order-independent and covers every file', () => {
    const a: PackageFileEntry[] = [
      { name: 'b.txt', data: Buffer.from('two') },
      { name: 'a.txt', data: Buffer.from('one') },
    ];
    const b: PackageFileEntry[] = [...a].reverse();
    expect(computePackageDigest(a)).toBe(computePackageDigest(b));
    const changed: PackageFileEntry[] = [
      { name: 'b.txt', data: Buffer.from('two') },
      { name: 'a.txt', data: Buffer.from('ONE') },
    ];
    expect(computePackageDigest(changed)).not.toBe(computePackageDigest(a));
  });

  it('tampering with any file after signing → invalid', () => {
    const kp = generatePluginPublisherKeyPair();
    const files = demoToolkitFiles();
    const block = signPackageFiles(files, kp);
    const tampered: PackageFileEntry[] = [
      ...files.map((f) => (f.name === 'index.js' ? { ...f, data: Buffer.from('// tampered') } : f)),
      { name: 'signature.json', data: Buffer.from(JSON.stringify(block)) },
    ];
    expect(verifyPackageFiles(tampered, [kp.publicKey]).status).toBe('invalid');
  });

  it('unsigned package → unsigned; valid signature under an untrusted key → untrusted-key', () => {
    const kp = generatePluginPublisherKeyPair();
    const other = generatePluginPublisherKeyPair();
    const unsigned = createZipArchive(demoToolkitFiles().map((f) => ({ name: f.name, data: f.data })));
    expect(verifyPluginPackage(unsigned, [kp.publicKey]).status).toBe('unsigned');
    const signed = createSignedPluginPackage(demoToolkitFiles(), kp);
    const v = verifyPluginPackage(signed, [other.publicKey]);
    expect(v.status).toBe('untrusted-key');
    expect(v.keyId).toBe(kp.keyId);
    // The presented key is carried so a host can offer explicit trust.
    expect(v.signerPublicKey).toBe(kp.publicKey);
  });

  it('malformed signature.json → invalid, and a keyId/key mismatch → invalid', () => {
    const kp = generatePluginPublisherKeyPair();
    const bad: PackageFileEntry[] = [
      ...demoToolkitFiles(),
      { name: 'signature.json', data: Buffer.from('{"nope":true}') },
    ];
    expect(verifyPackageFiles(bad, [kp.publicKey]).status).toBe('invalid');
    const block = signPackageFiles(demoToolkitFiles(), kp);
    const mismatched: PackageFileEntry[] = [
      ...demoToolkitFiles(),
      { name: 'signature.json', data: Buffer.from(JSON.stringify({ ...block, keyId: pluginKeyId(generatePluginPublisherKeyPair().publicKey) })) },
    ];
    expect(verifyPackageFiles(mismatched, [kp.publicKey]).status).toBe('invalid');
  });
});

describe('PluginTrustStore', () => {
  it('add/list/remove persist across instances; corrupt file reads as empty', () => {
    const file = join(dataDir(), 'trust.json');
    const kp = generatePluginPublisherKeyPair();
    const store = new PluginTrustStore(file);
    expect(store.list()).toEqual([]);
    const rec = store.add(kp.publicKey, 'Test Publisher');
    expect(rec.keyId).toBe(kp.keyId);
    expect(store.has(kp.keyId)).toBe(true);

    const reloaded = new PluginTrustStore(file);
    expect(reloaded.publicKeys()).toEqual([kp.publicKey]);
    expect(reloaded.remove(kp.keyId)).toBe(true);
    expect(reloaded.remove(kp.keyId)).toBe(false);
    expect(new PluginTrustStore(file).list()).toEqual([]);

    writeFileSync(file, 'not json at all');
    expect(new PluginTrustStore(file).list()).toEqual([]);
    expect(() => store.add('garbage', 'x')).toThrow(/Ed25519/);
  });
});

describe('manager signature gate + hot install', () => {
  it('verified package installs through the ordinary approval and is labelled verified', async () => {
    const kp = generatePluginPublisherKeyPair();
    const dir = dataDir();
    const pkgPath = join(dir, 'toolkit.kdpkg');
    writeFileSync(pkgPath, createSignedPluginPackage(demoToolkitFiles(), kp));
    const seenSignatures: unknown[] = [];
    const mgr = new PluginManager({
      dataDir: dir,
      trustedPublisherKeys: [kp.publicKey],
      approveInstall: (_m, source) => {
        seenSignatures.push(source.signature?.status);
        return true;
      },
    });
    const rec = await mgr.install({ type: 'package', path: pkgPath });
    expect(rec.signature.status).toBe('verified');
    expect(rec.signature.keyId).toBe(kp.keyId);
    expect(seenSignatures).toEqual(['verified']);
  });

  it('unsigned package is REFUSED without an untrusted hook, denied with a refusing hook, installed + labelled with an approving one', async () => {
    const dir = dataDir();
    const pkgPath = join(dir, 'unsigned.zip');
    writeFileSync(pkgPath, createZipArchive(demoToolkitFiles().map((f) => ({ name: f.name, data: f.data }))));

    const noHook = new PluginManager({ dataDir: dataDir(), approveInstall: approveAll });
    await expect(noHook.install({ type: 'zip', path: pkgPath })).rejects.toBeInstanceOf(PluginSignatureError);
    expect(noHook.list()).toEqual([]);

    const refusing = new PluginManager({
      dataDir: dataDir(),
      approveInstall: approveAll,
      approveUntrustedInstall: () => false,
    });
    await expect(refusing.install({ type: 'zip', path: pkgPath })).rejects.toBeInstanceOf(PluginInstallDenied);

    const approving = new PluginManager({
      dataDir: dir,
      approveInstall: approveAll,
      approveUntrustedInstall: (_m, source) => source.signature.status === 'unsigned',
    });
    const rec = await approving.install({ type: 'zip', path: pkgPath });
    expect(rec.signature.status).toBe('unsigned');
    // The label persists across a fresh manager reading the same store.
    const fresh = new PluginManager({ dataDir: dir, approveInstall: approveAll });
    expect(fresh.get('demo-toolkit')?.signature.status).toBe('unsigned');
  });

  it('untrusted-key package installs once the user trusts the publisher key', async () => {
    const kp = generatePluginPublisherKeyPair();
    const dir = dataDir();
    const pkgPath = join(dir, 'toolkit.kdpkg');
    writeFileSync(pkgPath, createSignedPluginPackage(demoToolkitFiles(), kp));
    const trustStore = new PluginTrustStore(join(dir, 'plugin-trust.json'));

    const before = new PluginManager({ dataDir: dir, approveInstall: approveAll, trustStore });
    await expect(before.install({ type: 'package', path: pkgPath })).rejects.toBeInstanceOf(PluginSignatureError);

    trustStore.add(kp.publicKey, 'Toolkit Publisher');
    const after = new PluginManager({ dataDir: dir, approveInstall: approveAll, trustStore });
    const rec = await after.install({ type: 'package', path: pkgPath });
    expect(rec.signature.status).toBe('verified');
  });

  it('tampered package is invalid and refused by default', async () => {
    const kp = generatePluginPublisherKeyPair();
    const dir = dataDir();
    const files = demoToolkitFiles();
    const block = signPackageFiles(files, kp);
    const tamperedZip = createZipArchive([
      ...files.map((f) => ({ name: f.name, data: f.name === 'index.js' ? Buffer.from('// evil') : f.data })),
      { name: 'signature.json', data: Buffer.from(JSON.stringify(block)) },
    ]);
    const pkgPath = join(dir, 'tampered.kdpkg');
    writeFileSync(pkgPath, tamperedZip);
    const mgr = new PluginManager({ dataDir: dir, approveInstall: approveAll, trustedPublisherKeys: [kp.publicKey] });
    await expect(mgr.install({ type: 'package', path: pkgPath })).rejects.toBeInstanceOf(PluginSignatureError);
    expect(mgr.list()).toEqual([]);
  });

  it('HOT: a signed tool package installed into a live manager is callable immediately, and gone after uninstall — no restart', async () => {
    const kp = generatePluginPublisherKeyPair();
    const dir = dataDir();
    const pkgPath = join(dir, 'toolkit.kdpkg');
    writeFileSync(pkgPath, createSignedPluginPackage(demoToolkitFiles(), kp));
    const mgr = new PluginManager({ dataDir: dir, approveInstall: approveAll, trustedPublisherKeys: [kp.publicKey] });

    await expect(mgr.tools()).resolves.toEqual([]);
    await mgr.install({ type: 'package', path: pkgPath });
    const tools = await mgr.tools();
    expect(tools.map((t) => t.name)).toContain('plugin:demo-toolkit:wordcount');
    const result = (await mgr.callTool('demo-toolkit', 'wordcount', { text: 'hot install works' })) as { words: number };
    expect(result.words).toBe(3);

    mgr.uninstall('demo-toolkit');
    await expect(mgr.tools()).resolves.toEqual([]);
    await expect(mgr.callTool('demo-toolkit', 'wordcount', { text: 'x' })).rejects.toBeInstanceOf(PluginNotFoundError);
  });
});

describe('declarative provider manifests (A9)', () => {
  it('a valid manifest-only provider validates and yields a descriptor live on install', async () => {
    const kp = generatePluginPublisherKeyPair();
    const dir = dataDir();
    const manifest = providerManifest();
    const files: PackageFileEntry[] = [{ name: 'plugin.json', data: Buffer.from(JSON.stringify(manifest)) }];
    const pkgPath = join(dir, 'fake-llm.kdpkg');
    writeFileSync(pkgPath, createSignedPluginPackage(files, kp));
    const mgr = new PluginManager({ dataDir: dir, approveInstall: approveAll, trustedPublisherKeys: [kp.publicKey] });
    await mgr.install({ type: 'package', path: pkgPath });

    const descriptors = mgr.providerDescriptors();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      pluginId: 'fake-llm-plugin',
      providerId: 'fake-llm',
      name: 'Fake LLM',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKeyEnv: 'FAKE_LLM_API_KEY',
      apiKeyRequired: true,
      liveModels: true,
    });
    mgr.setEnabled('fake-llm-plugin', false);
    expect(mgr.providerDescriptors()).toEqual([]);
    mgr.setEnabled('fake-llm-plugin', true);
    expect(mgr.providerDescriptors()).toHaveLength(1);
    mgr.uninstall('fake-llm-plugin');
    expect(mgr.providerDescriptors()).toEqual([]);
  });

  it('validation: provider shape is strict (fail closed)', () => {
    const base = providerManifest();
    expect(() => validateManifest(base)).not.toThrow();
    // apiKeyEnv missing from secrets[] → the approval surface would hide a secret.
    expect(() => validateManifest({ ...base, secrets: [] })).toThrow(/secrets/);
    // provider + executable kind → not manifest-only anymore.
    expect(() => validateManifest({ ...base, kinds: ['provider', 'tool'], entry: 'index.js' })).toThrow(/stand alone/);
    // entry on a provider → forbidden.
    expect(() => validateManifest({ ...base, entry: 'index.js' })).toThrow(/manifest-only/);
    // baseUrl with embedded credentials → forbidden (keys go through apiKeyEnv).
    expect(() =>
      validateManifest({ ...base, provider: { ...(base.provider as object), baseUrl: 'https://user:pass@example.com/v1' } }),
    ).toThrow(/credentials/);
    // provider block without the kind → forbidden.
    expect(() => validateManifest({ ...base, kinds: ['skill'] })).toThrow(/only allowed/);
    // duplicate secret names → forbidden.
    expect(() => validateManifest({ ...base, secrets: ['FAKE_LLM_API_KEY', 'FAKE_LLM_API_KEY'] })).toThrow(/duplicates/);
    // keyless provider needs no apiKeyEnv and no secrets entry.
    expect(() =>
      validateManifest({
        ...base,
        secrets: undefined,
        provider: { providerId: 'local-llm', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyRequired: false },
      }),
    ).not.toThrow();
  });
});

describe('declared secrets injection', () => {
  const echoPlugin = (): PackageFileEntry[] => {
    const manifest = {
      id: 'secret-echo',
      name: 'Secret Echo',
      version: '1.0.0',
      description: 'Returns the declared secret it was given (test fixture)',
      kinds: ['tool'],
      entry: 'index.js',
      permissions: { network: false, env: [] },
      secrets: ['ECHO_SECRET'],
    };
    const code = `'use strict';
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  let result = null;
  if (req.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'echo the secret', parameters: { type: 'object', properties: {} } }] };
  else if (req.method === 'tools/call') result = { secret: process.env.ECHO_SECRET ?? null };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
});
`;
    return [
      { name: 'plugin.json', data: Buffer.from(JSON.stringify(manifest)) },
      { name: 'index.js', data: Buffer.from(code) },
    ];
  };

  it('the host-resolved secret reaches the child env under its declared name; nothing is injected without a resolver', async () => {
    const kp = generatePluginPublisherKeyPair();
    const dir = dataDir();
    const pkgPath = join(dir, 'echo.kdpkg');
    writeFileSync(pkgPath, createSignedPluginPackage(echoPlugin(), kp));

    const resolverDir = dataDir();
    const withResolver = new PluginManager({
      dataDir: resolverDir,
      approveInstall: approveAll,
      trustedPublisherKeys: [kp.publicKey],
      resolveSecret: (name) => (name === 'ECHO_SECRET' ? 's3cr3t-value' : undefined),
    });
    await withResolver.install({ type: 'package', path: pkgPath });
    const got = (await withResolver.callTool('secret-echo', 'echo', {})) as { secret: string | null };
    expect(got.secret).toBe('s3cr3t-value');
    // The value is never persisted in the installed tree or state.
    expect(existsSync(join(resolverDir, 'plugins-state.json'))).toBe(true);
    expect(readFileSync(join(resolverDir, 'plugins-state.json'), 'utf8')).not.toContain('s3cr3t-value');

    const noResolver = new PluginManager({ dataDir: dataDir(), approveInstall: approveAll, trustedPublisherKeys: [kp.publicKey] });
    await noResolver.install({ type: 'package', path: pkgPath });
    const none = (await noResolver.callTool('secret-echo', 'echo', {})) as { secret: string | null };
    expect(none.secret).toBeNull();
  });
});
