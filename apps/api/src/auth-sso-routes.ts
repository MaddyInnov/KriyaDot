// SPDX-License-Identifier: Apache-2.0
// SSO routes: OIDC authorize/callback + LDAP login + session introspection.
//
// HOST WIRING (index.ts):
//   import { createAuthSsoRouter } from './auth-sso-routes.js';
//   app.use('/api/auth/sso', createAuthSsoRouter({
//     dataDir: config.dataDir,
//     tenancyDbPath: join(config.dataDir, 'tenancy.db'),
//     audit: (a, f) => governance.audit(a, f),
//   }));
//
// Routes (mounted at /api/auth/sso):
//   GET  /oidc/authorize          → { ok, url, state } (browser then visits url)
//   POST /oidc/callback {code, state} → { ok, sessionToken, user, session }
//   GET  /oidc/callback?code&state=   → same (IdP redirect target)
//   POST /ldap/login {username, password, captchaId?, captchaAnswer?}
//   GET  /session                 (Bearer session token) → session record
//   POST /logout                  (Bearer session token)
//
// Captcha hook: LDAP login calls checkCaptcha() before authenticating and
// records failures (see auth-captcha.ts). The same one-line pattern applies
// to the main login route: `checkCaptcha(policy, failures, store, key, id, ans)`.

import { join } from 'node:path';
import express, { type Router } from 'express';
import { TenantStore, TenancyExtrasStore } from '@mvp/tenancy';
import {
  CaptchaStore,
  LoginFailureTracker,
  captchaPolicyFromEnv,
  checkCaptcha,
  type CaptchaPolicy,
} from './auth-captcha.js';
import { LdapClient, ldapConfigFromEnv, type LdapConfig } from './auth-ldap.js';
import {
  OidcClient,
  SessionTokenStore,
  oidcConfigFromEnv,
  type FetchFn,
  type OidcConfig,
} from './auth-sso.js';

export interface AuthSsoDeps {
  dataDir: string;
  tenancyDbPath?: string;
  oidcConfig?: OidcConfig | null;
  ldapConfig?: LdapConfig | null;
  fetchFn?: FetchFn;
  captchaStore?: CaptchaStore;
  captchaPolicy?: CaptchaPolicy;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

function err(res: express.Response, status: number, message: string): void {
  res.status(status).json({ ok: false, error: message });
}

export function createAuthSsoRouter(deps: AuthSsoDeps): Router {
  const router = express.Router();
  const dbPath = deps.tenancyDbPath ?? join(deps.dataDir, 'tenancy.db');
  const tenants = new TenantStore(dbPath);
  const extras = new TenancyExtrasStore(dbPath);
  const sessions = new SessionTokenStore(deps.dataDir);
  const captchaStore = deps.captchaStore ?? new CaptchaStore();
  const failures = new LoginFailureTracker();
  const policy = deps.captchaPolicy ?? captchaPolicyFromEnv();
  const oidcConfig = deps.oidcConfig !== undefined ? deps.oidcConfig : oidcConfigFromEnv();
  const ldapConfig = deps.ldapConfig !== undefined ? deps.ldapConfig : ldapConfigFromEnv();
  const oidc = oidcConfig ? new OidcClient(oidcConfig, deps.fetchFn) : null;
  const pending = new Map<string, { codeVerifier: string; nonce: string }>();

  function issueForUser(provider: 'oidc' | 'ldap', email: string, name: string | undefined, externalId: string | undefined, defaultOrgId?: string) {
    const create = provider === 'ldap' ? true : (oidcConfig?.createOnFirstLogin ?? true);
    const existing = extras.getUserByEmail(email);
    if (!existing && !create) return null;
    const user = extras.upsertExternalUser({ email, name, provider, externalId });
    const orgId = defaultOrgId ?? oidcConfig?.defaultOrgId;
    if (orgId && tenants.getOrg(orgId) && !tenants.getMembership(orgId, user.userId)) {
      tenants.addMember(orgId, user.userId, 'member');
    }
    const { token, record } = sessions.issue({
      userId: user.userId,
      email: user.email,
      orgId,
      role: orgId ? tenants.getMembership(orgId, user.userId)?.role : undefined,
      provider,
    });
    return { token, record, user };
  }

  router.get('/oidc/authorize', async (_req, res) => {
    if (!oidc) return err(res, 501, 'OIDC is not configured');
    try {
      const { url, codeVerifier, state, nonce } = await oidc.buildAuthorizeUrl();
      pending.set(state, { codeVerifier, nonce });
      res.json({ ok: true, url, state });
    } catch (e) {
      err(res, 502, e instanceof Error ? e.message : 'OIDC authorize failed');
    }
  });

  async function handleCallback(code: string, state: string, res: express.Response): Promise<void> {
    if (!oidc) return err(res, 501, 'OIDC is not configured');
    const p = pending.get(state);
    if (!p) return err(res, 400, 'unknown or expired state');
    pending.delete(state);
    try {
      const claims = await oidc.handleCallback(code, p.codeVerifier, p.nonce);
      const email = typeof claims.email === 'string' ? claims.email : '';
      if (!email) return err(res, 400, 'id_token has no email claim');
      const issued = issueForUser('oidc', email, typeof claims.name === 'string' ? claims.name : undefined, typeof claims.sub === 'string' ? claims.sub : undefined);
      if (!issued) return err(res, 403, 'user does not exist and create-on-first-login is disabled');
      deps.audit?.('auth.sso_login', { actor: issued.user.userId, detail: { provider: 'oidc' } });
      res.json({ ok: true, sessionToken: issued.token, session: issued.record, user: issued.user });
    } catch (e) {
      err(res, 401, e instanceof Error ? e.message : 'OIDC callback failed');
    }
  }

  router.post('/oidc/callback', async (req, res) => {
    const body = (req.body ?? {}) as { code?: unknown; state?: unknown };
    if (typeof body.code !== 'string' || typeof body.state !== 'string') return err(res, 400, 'code and state are required');
    await handleCallback(body.code, body.state, res);
  });

  router.get('/oidc/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) return err(res, 400, 'code and state are required');
    await handleCallback(code, state, res);
  });

  router.post('/ldap/login', async (req, res) => {
    if (!ldapConfig) return err(res, 501, 'LDAP is not configured');
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown; captchaId?: unknown; captchaAnswer?: unknown };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) return err(res, 400, 'username and password are required');
    const key = `ldap:${username.toLowerCase()}:${req.ip ?? ''}`;
    const captcha = checkCaptcha(policy, failures, captchaStore, key, body.captchaId, body.captchaAnswer);
    if (!captcha.ok) return err(res, 400, 'captcha_required_or_invalid');
    const client = new LdapClient(ldapConfig);
    const result = await client.authenticate(username, password);
    if (!result.ok) {
      failures.recordFailure(key);
      return err(res, 401, result.reason === 'user-not-found' ? 'invalid credentials' : 'invalid credentials');
    }
    failures.clear(key);
    // LDAP directories vary: username may itself be an email, else synthesize
    // a stable local identity from the DN uid/cn so tenancy mapping is stable.
    const email = username.includes('@') ? username : `${username}@ldap.local`;
    const issued = issueForUser('ldap', email, username, result.dn);
    if (!issued) return err(res, 403, 'user provisioning failed');
    deps.audit?.('auth.ldap_login', { actor: issued.user.userId, detail: { provider: 'ldap', dn: result.dn } });
    res.json({ ok: true, sessionToken: issued.token, session: issued.record, user: issued.user });
  });

  router.get('/session', (req, res) => {
    const auth = req.headers.authorization;
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const record = sessions.resolve(token);
    if (!record) return err(res, 401, 'invalid or expired session');
    res.json({ ok: true, session: record });
  });

  router.post('/logout', (req, res) => {
    const auth = req.headers.authorization;
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    sessions.revoke(token);
    res.json({ ok: true });
  });

  return router;
}

export { SessionTokenStore } from './auth-sso.js';
