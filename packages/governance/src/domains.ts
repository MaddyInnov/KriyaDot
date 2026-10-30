// SPDX-License-Identifier: Apache-2.0
/**
 * Domain-bound capabilities (#122).
 *
 * Egress used to be a boolean toggle: a capability either could reach
 * the network or could not. This module makes egress an ALLOWLIST: a
 * policy rule (a capability/tool grant) may carry `domains`, and the
 * gateway denies any call governed by that rule whose target host —
 * extracted from the tool arguments — is outside the set.
 *
 * Domain matching (after lower-casing and stripping port/trailing dot):
 * - `"example.com"` matches `example.com` and any subdomain
 *   (`api.example.com`, `a.b.example.com`).
 * - `"*.example.com"` matches subdomains only, NOT the apex.
 * - `"*"` matches every host.
 * - An entry that is itself a URL (`"https://api.example.com/x"`)
 *   contributes its hostname.
 *
 * Host extraction looks, in order, at the conventional argument names
 * (`url`, `uri`, `href`, `endpoint`, `target`, `host`, `hostname`,
 * `domain`, `baseUrl`, `origin`, `address`), then at any other string
 * argument that parses as a URL or looks like a bare host. When no
 * host can be determined the check FAILS CLOSED (denied): a
 * domain-bound grant must never egress to an unknown destination.
 */

/** Argument names consulted first when looking for a target host. */
export const TARGET_HOST_ARG_NAMES: readonly string[] = [
  'url',
  'uri',
  'href',
  'endpoint',
  'target',
  'host',
  'hostname',
  'domain',
  'baseUrl',
  'base_url',
  'origin',
  'address',
];

/** Normalize a host or domain entry: lower-case, no port, no trailing dot, no scheme/path. */
export function normalizeHost(raw: string): string | null {
  let text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  // URL form → hostname.
  if (text.includes('://')) {
    try {
      text = new URL(text).hostname.toLowerCase();
    } catch {
      return null;
    }
  } else {
    // Strip any path/query/fragment and userinfo from a bare host string.
    text = text.split(/[/?#]/)[0] ?? '';
    const at = text.lastIndexOf('@');
    if (at >= 0) text = text.slice(at + 1);
    // Strip a single trailing :port.
    const portMatch = /^(.*):(\d+)$/.exec(text);
    if (portMatch) text = portMatch[1]!;
  }
  text = text.replace(/\.$/, '');
  if (!text || /\s/.test(text)) return null;
  return text;
}

function hostFromValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.includes('://')) {
    // The value may embed a URL in prose ("see https://x.example/a"):
    // extract the first URL-looking substring, then parse it.
    const urlText = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
      ? text
      : (text.match(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/i)?.[0] ?? text);
    try {
      return normalizeHost(new URL(urlText).hostname);
    } catch {
      return null;
    }
  }
  // Bare host (optionally with port/path): must contain a dot or be localhost.
  const candidate = normalizeHost(text);
  if (!candidate) return null;
  if (candidate === 'localhost' || candidate.includes('.')) return candidate;
  return null;
}

/**
 * Extract the target host of a tool call from its arguments, or null
 * when no argument identifies a destination.
 */
export function extractTargetHost(args: Record<string, unknown>): string | null {
  if (!args || typeof args !== 'object') return null;
  for (const name of TARGET_HOST_ARG_NAMES) {
    const host = hostFromValue(args[name]);
    if (host) return host;
  }
  for (const value of Object.values(args)) {
    const host = hostFromValue(value);
    if (host) return host;
  }
  return null;
}

/** Does `host` fall inside the allowed-domain set? */
export function hostMatchesDomains(host: string, domains: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  for (const rawEntry of domains) {
    const entryRaw = String(rawEntry ?? '').trim().toLowerCase();
    if (!entryRaw) continue;
    if (entryRaw === '*') return true;
    const subdomainOnly = entryRaw.startsWith('*.');
    const entry = normalizeHost(subdomainOnly ? entryRaw.slice(2) : entryRaw);
    if (!entry) continue;
    if (subdomainOnly) {
      if (h !== entry && h.endsWith(`.${entry}`)) return true;
    } else if (h === entry || h.endsWith(`.${entry}`)) {
      return true;
    }
  }
  return false;
}

export interface DomainCheckResult {
  allowed: boolean;
  /** Host extracted from the arguments, when one was found. */
  host: string | null;
  reason: string;
}

/**
 * The gateway-side domain gate for one call: allowed only when a host
 * was extracted AND it is inside `domains`. Fail-closed otherwise.
 */
export function checkDomainGrant(
  domains: readonly string[] | undefined,
  args: Record<string, unknown>,
): DomainCheckResult {
  if (!domains || domains.length === 0) {
    return { allowed: true, host: extractTargetHost(args), reason: 'no domain restriction on this grant' };
  }
  const host = extractTargetHost(args);
  if (!host) {
    return {
      allowed: false,
      host: null,
      reason: 'domain-bound grant: no target host could be determined from the tool arguments (fail-closed)',
    };
  }
  if (!hostMatchesDomains(host, domains)) {
    return {
      allowed: false,
      host,
      reason: `domain-bound grant: host "${host}" is outside the allowed domains [${domains.join(', ')}]`,
    };
  }
  return { allowed: true, host, reason: `host "${host}" is within the allowed domains` };
}
