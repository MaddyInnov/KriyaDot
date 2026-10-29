// SPDX-License-Identifier: Apache-2.0
// Login-source abstraction for type_login: a saved login can come from the
// built-in vault (existing behavior) or from 1Password, resolved by
// invoking the `op` CLI server-side.
//
// Trust model (same as type_login, never weakened):
//   - The password returned by a source flows ONLY into the caller's
//     os.type() inside the type_login handler. It never appears in tool
//     args, results, logs, or thrown errors: op failures surface as stable
//     error CODES, and the runner's stdout/stderr are never echoed (stdout
//     literally contains the password on success paths we discard).
//   - When `op` is absent (ENOENT) the source reports a clear
//     'onepassword-cli-missing' error so the host can fall back to the
//     built-in vault or tell the user to install 1Password CLI.

import { execFile } from 'node:child_process';
import type { TypeLoginRecord } from './type-login.js';

export type LoginSourceKind = 'vault' | 'onepassword';

export interface LoginSource {
  readonly kind: LoginSourceKind;
  getLogin(loginId: string): Promise<TypeLoginRecord | undefined>;
}

/** Injectable `op` runner: argv (no shell) → stdout. Tests fake this. */
export type OpRunner = (args: string[]) => Promise<{ stdout: string; code: number }>;

export class OnePasswordUnavailableError extends Error {
  constructor(detail = 'op CLI not found') {
    super(`1Password login source unavailable: ${detail}. Install the 1Password CLI ("op") and sign in, or use the built-in vault.`);
    this.name = 'OnePasswordUnavailableError';
  }
}

function defaultOpRunner(args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile('op', args, { timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') { reject(new OnePasswordUnavailableError()); return; }
        // Never include stdout/stderr: they may carry credential material.
        reject(new Error('onepassword-item-read-failed'));
        return;
      }
      resolve({ stdout: String(stdout), code: 0 });
    });
  });
}

interface OpField { id?: string; label?: string; value?: string; type?: string }
interface OpItem {
  title?: string;
  urls?: Array<{ href?: string }>;
  fields?: OpField[];
}

function fieldValue(item: OpItem, names: string[]): string | undefined {
  for (const f of item.fields ?? []) {
    const key = (f.label ?? f.id ?? '').toLowerCase();
    if (names.includes(key) && typeof f.value === 'string' && f.value) return f.value;
  }
  return undefined;
}

/**
 * Parse `op item get --format json` output into a TypeLoginRecord.
 * Returns undefined when the item lacks a username or password.
 * The password exists only in the returned record (server-side hand-off).
 */
export function parseOpItem(jsonText: string, fallbackName: string): TypeLoginRecord | undefined {
  let item: OpItem;
  try { item = JSON.parse(jsonText) as OpItem; } catch { throw new Error('onepassword-item-parse-failed'); }
  const username = fieldValue(item, ['username', 'user name', 'email']);
  const password = fieldValue(item, ['password']);
  if (!username || !password) return undefined;
  const site = fieldValue(item, ['website', 'url']) ?? item.urls?.[0]?.href ?? '';
  return { name: item.title ?? fallbackName, site, username, password };
}

export interface OnePasswordSourceOptions {
  runner?: OpRunner;
  /** Map a vault-style loginId to the 1Password item title/id. Default: identity. */
  itemFor?: (loginId: string) => string;
  vault?: string;
}

/** 1Password login source backed by the `op` CLI. */
export function createOnePasswordLoginSource(opts: OnePasswordSourceOptions = {}): LoginSource {
  const runner = opts.runner ?? defaultOpRunner;
  return {
    kind: 'onepassword',
    async getLogin(loginId: string): Promise<TypeLoginRecord | undefined> {
      const item = opts.itemFor?.(loginId) ?? loginId;
      const args = ['item', 'get', item, '--format', 'json'];
      if (opts.vault) args.push('--vault', opts.vault);
      let out: { stdout: string; code: number };
      try {
        out = await runner(args);
      } catch (err) {
        if (err instanceof OnePasswordUnavailableError) throw err;
        // Runner failures are reported as a code only — never echo output.
        throw new Error('onepassword-item-read-failed');
      }
      if (out.code !== 0) throw new Error('onepassword-item-read-failed');
      return parseOpItem(out.stdout, loginId);
    },
  };
}

/** Built-in vault source: wraps the host's existing synchronous getLogin. */
export function createVaultLoginSource(
  getLogin: (loginId: string) => TypeLoginRecord | undefined,
): LoginSource {
  return {
    kind: 'vault',
    async getLogin(loginId: string) { return getLogin(loginId); },
  };
}

/** Pick a source by kind from a source set. Throws on an unknown kind. */
export function loginSourceByKind(sources: LoginSource[], kind: LoginSourceKind): LoginSource {
  const found = sources.find((s) => s.kind === kind);
  if (!found) throw new Error(`login source "${kind}" is not configured`);
  return found;
}
