// SPDX-License-Identifier: Apache-2.0
// Provider catalog + API-key storage. Key resolution order for the agent
// runtime (resolveApiKey): real env var first, then process.env values this
// module mirrors from the encrypted local file (it cannot read the envelope
// itself — only this module holds the machine key). This module writes
// DATA_DIR/providers.local.json (mode 0600, AES-256-GCM encrypted);
// index.ts calls syncProviderKeysToEnv() at boot and after every save/remove
// so the runtime always sees the current keys. Keys are NEVER returned by
// any endpoint and NEVER logged.
//
// Encrypted at rest: providers.local.json is AES-256-GCM encrypted under a
// 256-bit machine key stored with mode 0600 at DATA_DIR/.machine-key (the
// OS-appropriate app-data dir from config.dataDir — <cwd>/data by default,
// the Tauri desktop shell's app-data dir when DATA_DIR is set). The key is
// generated on first boot and never leaves the machine. Legacy plaintext
// files are migrated to encrypted form automatically on load.

import fs from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  bridgeConnectable,
  createProvider,
  detectCliBridges,
  getCustomProviderPreset,
  getProviderPreset,
  getRateLimit,
  grantBridgeConsent,
  isBridgeConnected,
  isFreeModel,
  listProviderPresets,
  resolveApiKey,
  revokeBridgeConsent,
} from '@mvp/agent-runtime';
import type { CliBridgeId, ModelInfo } from '@mvp/agent-runtime';
import type { ProviderInfo } from './types.js';

const LOCAL_KEYS_FILE = 'providers.local.json';
const CUSTOM_ID_PATTERN = /^custom-[a-z0-9][a-z0-9-]*$/;

export interface ProviderKeyInput {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export function localKeysPath(dataDir: string): string {
  return path.join(dataDir, LOCAL_KEYS_FILE);
}

/** Flat string record, keyed by env var name — the format resolveApiKey reads. */
type KeyFile = Record<string, string>;

// ---------------------------------------------------------------------------
// Encrypted-at-rest storage (AES-256-GCM, node:crypto stdlib only).
//
// Machine key location (documented): <DATA_DIR>/.machine-key, where DATA_DIR
// is config.dataDir (defaults to <cwd>/data; the Tauri desktop shell passes
// its OS app-data dir via the DATA_DIR env var). The file holds 32 raw
// random bytes, mode 0600, generated on first boot (i.e. the first time a
// key needs to be stored).
// ---------------------------------------------------------------------------

const MACHINE_KEY_FILE = '.machine-key';
const MACHINE_KEY_BYTES = 32;
const GCM_ALG = 'aes-256-gcm';
const GCM_IV_BYTES = 12;

/** Encrypted envelope persisted as the whole content of providers.local.json. */
interface EncryptedKeyFile {
  alg: typeof GCM_ALG;
  /** base64, fresh 96-bit IV per write */
  iv: string;
  /** base64, 128-bit auth tag — verified on every read */
  tag: string;
  /** base64 ciphertext of the UTF-8 JSON key file */
  data: string;
}

function machineKeyPath(dataDir: string): string {
  return path.join(dataDir, MACHINE_KEY_FILE);
}

/**
 * Write a file atomically (temp + rename) with mode 0600, so a crash
 * mid-write can never leave a truncated key file or machine key behind.
 */
function atomicWriteFile(filePath: string, content: string | Buffer): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // best effort on platforms without POSIX perms
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort on platforms without POSIX perms
  }
}

/** Load the machine key, generating and persisting it on first boot. */
function getOrCreateMachineKey(dataDir: string): Buffer {
  const keyPath = machineKeyPath(dataDir);
  try {
    const raw = fs.readFileSync(keyPath);
    if (raw.length !== MACHINE_KEY_BYTES) {
      throw new Error(
        `[providers] ${MACHINE_KEY_FILE} has an unexpected length (${raw.length} bytes, expected ${MACHINE_KEY_BYTES}) — refusing to use it. ` +
          `If you intend to re-key, delete the file and re-enter your provider keys.`,
      );
    }
    return raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const key = randomBytes(MACHINE_KEY_BYTES);
    fs.mkdirSync(dataDir, { recursive: true });
    atomicWriteFile(keyPath, key);
    console.log(`[providers] generated a new 256-bit machine key at ${keyPath} (mode 0600)`);
    return key;
  }
}

/** Load the machine key for reading. Fails closed if it is missing. */
function requireMachineKey(dataDir: string): Buffer {
  const keyPath = machineKeyPath(dataDir);
  let raw: Buffer;
  try {
    raw = fs.readFileSync(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `[providers] ${MACHINE_KEY_FILE} is missing but ${LOCAL_KEYS_FILE} is encrypted — refusing to read keys. ` +
          `The key file was deleted or DATA_DIR changed; provider keys must be re-entered.`,
      );
    }
    throw err;
  }
  if (raw.length !== MACHINE_KEY_BYTES) {
    throw new Error(
      `[providers] ${MACHINE_KEY_FILE} has an unexpected length (${raw.length} bytes, expected ${MACHINE_KEY_BYTES}) — refusing to read keys.`,
    );
  }
  return raw;
}

function isEncryptedEnvelope(value: unknown): value is EncryptedKeyFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.alg === GCM_ALG &&
    typeof v.iv === 'string' &&
    typeof v.tag === 'string' &&
    typeof v.data === 'string'
  );
}

function encryptEnvelope(plaintext: string, key: Buffer): EncryptedKeyFile {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(GCM_ALG, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    alg: GCM_ALG,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptEnvelope(envelope: EncryptedKeyFile, key: Buffer): string {
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error(
      `[providers] ${LOCAL_KEYS_FILE} has an invalid IV — the file may be tampered with or corrupt. Refusing to read keys.`,
    );
  }
  const decipher = createDecipheriv(GCM_ALG, key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    // Wrong key, tampered ciphertext, or corrupt file: GCM auth failed.
    // Fail closed — never fall back to plaintext.
    throw new Error(
      `[providers] ${LOCAL_KEYS_FILE} failed authentication (wrong machine key, tampered or corrupt file). Refusing to read provider keys.`,
    );
  }
}

function readKeyFile(dataDir: string): KeyFile {
  let raw: string;
  try {
    raw = fs.readFileSync(localKeysPath(dataDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    console.warn(`[providers] could not read ${LOCAL_KEYS_FILE}: ${(err as Error).message}`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      `[providers] ${LOCAL_KEYS_FILE} is not valid JSON (and not an encrypted key file) — refusing to read keys.`,
    );
  }
  if (isEncryptedEnvelope(parsed)) {
    parsed = JSON.parse(decryptEnvelope(parsed, requireMachineKey(dataDir))) as unknown;
  } else {
    // Legacy plaintext (pre-encryption format): migrate in place — re-encrypt
    // and rewrite atomically so all subsequent loads read the encrypted form.
    writeKeyFile(dataDir, parsed as KeyFile);
    console.log(`[providers] migrated ${LOCAL_KEYS_FILE} from plaintext to AES-256-GCM encryption`);
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const out: KeyFile = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
  return {};
}

function writeKeyFile(dataDir: string, file: KeyFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const key = getOrCreateMachineKey(dataDir);
  const envelope = encryptEnvelope(JSON.stringify(file, null, 2) + '\n', key);
  atomicWriteFile(localKeysPath(dataDir), JSON.stringify(envelope) + '\n');
}

// ---------------------------------------------------------------------------
// Env bridging: the agent runtime resolves keys via env vars first
// (resolveApiKey) but can no longer read the encrypted envelope itself —
// only this module holds the machine key. So this module mirrors the
// decrypted file contents into process.env (the runtime's first lookup).
// Real environment variables always win: we never overwrite an existing one,
// and removeProviderKey() only unsets keys this module injected (tracked in
// apiManagedEnvKeys), never keys the user exported themselves.
// ---------------------------------------------------------------------------

/** Env keys this process injected from the encrypted file, with the exact
 *  value set — removal only unsets a key when it still holds our value,
 *  never a real user env var that appeared later. */
const apiManagedEnvKeys = new Map<string, string>();

function injectEnvKey(name: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) return;
  if (process.env[name] && process.env[name]!.length > 0) return; // real env wins
  process.env[name] = value;
  apiManagedEnvKeys.set(name, value);
}

/**
 * Sync all decrypted provider keys from the encrypted local file into
 * process.env so the agent runtime can resolve them. Call at boot and
 * after every save/remove. Fail-closed: an unreadable/tampered file throws
 * (callers at boot should let it propagate — no keys is safer than
 * silently running keyless).
 */
export function syncProviderKeysToEnv(dataDir: string): void {
  const file = readKeyFile(dataDir);
  // Remove env vars for keys no longer in the file (handles deletes).
  const currentKeys = new Set(Object.keys(file));
  const toRemove: string[] = [];
  for (const name of apiManagedEnvKeys.keys()) {
    if (!currentKeys.has(name)) toRemove.push(name);
  }
  if (toRemove.length > 0) uninjectEnvKeys(toRemove);
  for (const [k, v] of Object.entries(file)) injectEnvKey(k, v);
}

/** Undo exactly what this module injected (never real user env vars). */
function uninjectEnvKeys(names: string[]): void {
  for (const name of names) {
    const injected = apiManagedEnvKeys.get(name);
    if (injected !== undefined && process.env[name] === injected) {
      delete process.env[name];
    }
    apiManagedEnvKeys.delete(name);
  }
}

/** Env var under which a provider's key is stored. Custom ids get a synthesized key. */
export function envKeyFor(providerId: string): string | undefined {
  const preset = getProviderPreset(providerId);
  if (preset) return preset.envKey;
  if (CUSTOM_ID_PATTERN.test(providerId)) {
    return `CUSTOM_${providerId.replace(/^custom-/, '').replace(/-/g, '_').toUpperCase()}_API_KEY`;
  }
  return undefined;
}

export function isKnownProviderId(providerId: string): boolean {
  return getProviderPreset(providerId) !== undefined || CUSTOM_ID_PATTERN.test(providerId);
}

export function saveProviderKey(
  dataDir: string,
  providerId: string,
  input: ProviderKeyInput,
): void {
  const envKey = envKeyFor(providerId);
  if (!envKey) {
    throw new Error(
      `Unknown provider "${providerId}". Use a catalog provider or a "custom-*" id.`,
    );
  }
  const file = readKeyFile(dataDir);
  file[envKey] = input.apiKey;
  if (input.baseUrl) file[`${envKey}_BASE_URL`] = input.baseUrl;
  else delete file[`${envKey}_BASE_URL`];
  if (input.headers && Object.keys(input.headers).length > 0) {
    // Forward-compat: the current runtime does not consume per-provider
    // header overrides from this file (extraHeaders come from the catalog).
    file[`${envKey}_HEADERS`] = JSON.stringify(input.headers);
  } else {
    delete file[`${envKey}_HEADERS`];
  }
  writeKeyFile(dataDir, file);
  // Bridge into the runtime: it resolves keys via env vars and can no
  // longer read the encrypted envelope itself.
  injectEnvKey(envKey, input.apiKey);
  if (input.baseUrl) injectEnvKey(`${envKey}_BASE_URL`, input.baseUrl);
  if (input.headers && Object.keys(input.headers).length > 0) {
    injectEnvKey(`${envKey}_HEADERS`, JSON.stringify(input.headers));
  }
}

const BRIDGE_IDS: CliBridgeId[] = ['claude', 'codex'];

function asBridgeId(value: unknown): CliBridgeId | undefined {
  return typeof value === 'string' && (BRIDGE_IDS as string[]).includes(value)
    ? (value as CliBridgeId)
    : undefined;
}

/**
 * Connect a subscription/CLI bridge: the user's explicit consent to reuse
 * their own CLI login. Validates that the bridge is actually usable first.
 * No credential bytes are stored — consent is in-memory only.
 */
export function connectBridge(bridgeId: string): void {
  const id = asBridgeId(bridgeId);
  if (!id) throw new Error(`Unknown bridge "${bridgeId}". Expected "claude" or "codex".`);
  const probe = bridgeConnectable(id);
  if (!probe.ok) {
    throw new Error(probe.reason ?? 'Bridge is not connectable on this machine.');
  }
  grantBridgeConsent(id);
  console.log(`[providers] bridge "${id}" connected (consent granted, token stays in memory only)`);
}

/** Disconnect a bridge: consent revoked; any in-memory token is dropped. */
export function disconnectBridge(bridgeId: string): boolean {
  const id = asBridgeId(bridgeId);
  if (!id) return false;
  const was = isBridgeConnected(id);
  revokeBridgeConsent(id);
  if (was) console.log(`[providers] bridge "${id}" disconnected (consent revoked)`);
  return was;
}

/** Remove a stored key. Returns true if anything was removed. */
export function removeProviderKey(dataDir: string, providerId: string): boolean {  const envKey = envKeyFor(providerId);
  if (!envKey) return false;
  const file = readKeyFile(dataDir);
  const names = [envKey, `${envKey}_BASE_URL`, `${envKey}_HEADERS`];
  let removed = false;
  for (const key of names) {
    if (key in file) {
      delete file[key];
      removed = true;
    }
  }
  if (removed) writeKeyFile(dataDir, file);
  // Unset only keys this module injected — never the user's real env vars.
  uninjectEnvKeys(names);
  return removed;
}

function isConfigured(providerId: string): boolean {
  try {
    const preset = getProviderPreset(providerId);
    // Local providers (Ollama) need no key — they're "configured" by
    // definition; reachability is checked live by listModels().
    if (preset?.local) return true;
    return Boolean(resolveApiKey(providerId));
  } catch {
    return false;
  }
}

async function resolveModels(providerId: string): Promise<ModelInfo[]> {
  const preset = getProviderPreset(providerId) ?? getCustomProviderPreset(providerId);
  const catalogModels: ModelInfo[] = (preset?.models ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    contextLength: m.contextLength,
    free: isFreeModel(providerId, m.id),
  }));
  // Live model list when the preset asks for it (or for custom endpoints,
  // which have no catalog) and a key is present; catalog fallback otherwise.
  const wantLive = preset?.liveModels === true || preset?.id.startsWith('custom-') === true;
  if (wantLive && isConfigured(providerId)) {
    try {
      const live = await createProvider(providerId).listModels();
      if (live.length > 0) return live;
    } catch (err) {
      console.warn(
        `[providers] live model list for "${providerId}" failed, using catalog: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return catalogModels;
}

/** Custom-* ids stored in the local file that have no catalog preset. */
function customProviderIds(dataDir: string): string[] {
  const file = readKeyFile(dataDir);
  const ids: string[] = [];
  for (const key of Object.keys(file)) {
    const m = /^CUSTOM_(.+)_API_KEY$/.exec(key);
    if (m) ids.push(`custom-${m[1].toLowerCase().replace(/_/g, '-')}`);
  }
  return ids;
}

export async function listProviders(dataDir: string): Promise<ProviderInfo[]> {
  const infos: ProviderInfo[] = [];
  // Subscription/CLI bridge detection runs on every listing (a few fs stats —
  // cheap) so newly installed CLIs appear without a restart.
  const detections = new Map(detectCliBridges().map((d) => [d.id, d] as const));
  for (const preset of listProviderPresets()) {
    const info: ProviderInfo = {
      id: preset.id,
      name: preset.byo ? `${preset.name} (bring your own)` : preset.name,
      api: preset.api,
      configured: isConfigured(preset.id),
      models: await resolveModels(preset.id),
      // Latest rate-limit/quota snapshot captured from response headers
      // (null until the provider has served at least one request, or when it
      // sends no headers).
      rateLimit: getRateLimit(preset.id),
      local: preset.local === true,
    };
    if (preset.bridge) {
      const detection = detections.get(preset.bridge);
      info.bridge = preset.bridge;
      info.detected = detection?.detected ?? false;
      info.connected = isBridgeConnected(preset.bridge);
    }
    infos.push(info);
  }
  // Stored custom providers: synthesized BYO presets in the runtime, so they
  // report configured/models honestly like catalog providers.
  for (const id of customProviderIds(dataDir)) {
    if (infos.some((p) => p.id === id)) continue;
    infos.push({
      id,
      name: id,
      api: 'openai-compatible',
      configured: isConfigured(id),
      models: await resolveModels(id),
      rateLimit: getRateLimit(id),
    });
  }
  return infos;
}
