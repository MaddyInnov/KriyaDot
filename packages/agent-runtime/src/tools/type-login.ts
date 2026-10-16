// SPDX-License-Identifier: Apache-2.0
// Password-safe credential typing (Codync parity: `type_login`).
//
//   type_login — type a saved vault login into the focused field without
//                the bot ever seeing the password. [MUTATING → require-approval]
//
// Trust model (never weakened):
//   - The password is resolved SERVER-SIDE inside the tool handler via the
//     injected getLogin(). The tool's input schema exposes only `loginId`
//     (and an optional `expectedSite` assertion); the password never
//     appears in tool args, tool results, logs, or thrown errors.
//   - Site verification is best-effort defense-in-depth: when the host
//     injects verifySite() (active-window/URL check), the focused context
//     must match the login's site. Without an injected verifier the bot
//     must assert expectedSite, which must normalize-match the stored
//     site. Either way the human approval gate sees WHICH login and site
//     are involved before anything is typed.
//   - Typing goes through the same OSScreenLayer as computer_type
//     (username, Tab, password). No Enter is pressed — the user submits.
//   - This tool is approval-gated via computerUsePolicyRules() (the
//     `type_login` name is in the require-approval pattern in computer.ts).

import type { ToolContext, ToolDefinition } from '../types.js';
import { MockOSScreenLayer, type OSScreenLayer } from './computer.js';
// Type-only import: the runtime package must not depend on @mvp/vault at
// build time (the host injects getLogin). LoginRecord shape is redeclared
// structurally to avoid the dependency.
export interface TypeLoginRecord {
  name: string;
  site: string;
  username: string;
  /** Resolved server-side only — never put this in a result or error. */
  password: string;
}

/** Canonical tool name for password-safe login typing. */
export const TYPE_LOGIN_TOOL_NAME = 'type_login';

/**
 * Result of a focused-context site check. `observed` is a short,
 * non-secret description (window title / URL) used only for diagnostics —
 * it must never contain credential material.
 */
export interface SiteCheck {
  matched: boolean;
  /** Short non-secret description of what was observed, if available. */
  observed?: string;
}

export interface TypeLoginToolOptions {
  /**
   * OS layer used for typing (username, Tab, password). Optional when
   * `resolveOS` is set; defaults to the safe mock.
   */
  os?: OSScreenLayer;
  /**
   * Per-bot computer routing (P1 #14). When set, the handler resolves its
   * OS layer from the tool-call context instead of the shared `os`.
   */
  resolveOS?: (ctx: ToolContext) => OSScreenLayer | Promise<OSScreenLayer>;
  /**
   * Server-side login lookup. Called inside the handler — the returned
   * password never leaves this module except into os.type().
   */
  getLogin: (loginId: string) => TypeLoginRecord | undefined;
  /**
   * Optional active-window/URL verifier. When present, the focused context
   * must match the login's site. When absent, the bot must pass
   * `expectedSite` and it must normalize-match the stored site.
   */
  verifySite?: (expectedSite: string) => Promise<SiteCheck>;
}

/** Login id charset (matches the vault NAME_PATTERN). */
const LOGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SITE_CHARS = 128;

/**
 * Normalize a site for comparison: lowercase, strip scheme, leading www.,
 * trailing slashes, port, and path. "https://www.GitHub.com/login" and
 * "github.com" both become "github.com".
 */
export function normalizeSite(site: string): string {
  let s = site.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/^www\./, '');
  s = s.split('/')[0]; // drop path
  s = s.split(':')[0]; // drop port
  return s;
}

/**
 * Two sites match when their normalized forms are equal, or when one is a
 * DNS subdomain of the other ("sub.github.com" vs "github.com"). Subdomain
 * matching requires a dot boundary: "evilgithub.com" does NOT match
 * "github.com" (substring matching would have let it through — H1).
 * Non-domain values (no dots), such as app-name aliases like "whatsapp" vs
 * "whatsapp desktop", still match when one contains the other.
 */
export function sitesMatch(a: string, b: string): boolean {
  const na = normalizeSite(a);
  const nb = normalizeSite(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const aIsDomain = na.includes('.');
  const bIsDomain = nb.includes('.');
  if (aIsDomain || bIsDomain) {
    // Domain comparison: exact equality or dot-boundary suffix.
    return na.endsWith('.' + nb) || nb.endsWith('.' + na);
  }
  return na.includes(nb) || nb.includes(na);
}

function loginIdArg(args: Record<string, unknown>): string {
  const v = args['loginId'];
  if (typeof v !== 'string' || !LOGIN_ID_PATTERN.test(v)) {
    throw new Error('"loginId" must be a valid vault login name (letters, digits, _, -)');
  }
  return v;
}

export function createTypeLoginTool(opts: TypeLoginToolOptions): ToolDefinition {
  const { getLogin, verifySite } = opts;
  return {
    name: TYPE_LOGIN_TOOL_NAME,
    mutating: true,
    description:
      'Type a saved vault login (username, Tab, password) into the currently focused field. ' +
      'The password is resolved server-side and never revealed to you — pass only the loginId. ' +
      'Site verification: the focused window must match the login\'s site, otherwise the tool refuses. ' +
      'MUTATING: requires human approval via governance.',
    parameters: {
      type: 'object',
      properties: {
        loginId: {
          type: 'string',
          description: 'Vault login name (e.g. "github-personal"). The password is never shown to you.',
        },
        expectedSite: {
          type: 'string',
          description:
            'Required when no active-window verifier is configured: assert the site you expect to be ' +
            'focused (e.g. "github.com"). Must match the login\'s stored site.',
        },
      },
      required: ['loginId'],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext) => {
      const loginId = loginIdArg(args);
      // Per-bot computers: resolve the layer for the calling bot.
      const os = opts.resolveOS ? await opts.resolveOS(ctx) : (opts.os ?? new MockOSScreenLayer());
      const login = getLogin(loginId);
      if (!login) {
        // Name-only error: never hint at whether the id exists vs is not a login.
        throw new Error(`unknown login "${loginId}"`);
      }

      // --- site verification (best-effort, fail closed) ---
      if (verifySite) {
        let check: SiteCheck;
        try {
          check = await verifySite(login.site);
        } catch (err) {
          throw new Error(
            `site verification failed for login "${loginId}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!check.matched) {
          const observed = check.observed ? ` (observed: ${check.observed.slice(0, 80)})` : '';
          throw new Error(
            `refused: focused window does not match login site "${login.site}"${observed}`,
          );
        }
      } else {
        const expected = args['expectedSite'];
        if (typeof expected !== 'string' || !expected.trim() || expected.length > MAX_SITE_CHARS) {
          throw new Error(
            `refused: no active-window verifier is configured, so "expectedSite" is required ` +
              `and must match the login's site ("${login.site}")`,
          );
        }
        if (!sitesMatch(expected, login.site)) {
          throw new Error(
            `refused: expectedSite "${expected.trim()}" does not match login site "${login.site}"`,
          );
        }
      }

      // --- type username, Tab, password. The password value never appears
      // --- in args, results, or errors — only inside os.type() calls.
      try {
        await os.type(login.username);
        await os.key('Tab');
        await os.type(login.password);
      } catch (err) {
        throw new Error(`failed to type login "${loginId}": ${err instanceof Error ? err.message : String(err)}`);
      }
      return { typed: true, loginId, site: login.site };
    },
  };
}

/**
 * Register type_login into a tool registry. Throws on name collision,
 * mirroring registerComputerUseTool.
 */
export function registerTypeLoginTool(
  registry: Map<string, ToolDefinition>,
  opts: TypeLoginToolOptions,
): void {
  const tool = createTypeLoginTool(opts);
  if (registry.has(tool.name)) {
    throw new Error(`tool name collision: "${tool.name}" is already registered`);
  }
  registry.set(tool.name, tool);
}
