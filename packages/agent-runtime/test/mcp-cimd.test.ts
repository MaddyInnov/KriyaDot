// SPDX-License-Identifier: Apache-2.0
// #50: CIMD (Client ID Metadata Documents) — the client_id is an https
// URL whose fetched metadata document is the client identity. All tests
// run offline via the injectable fetch seam.

import { describe, expect, it } from 'vitest';
import {
  createCimdClientResolver,
  fetchClientIdMetadataDocument,
  isCimdClientId,
  McpOAuthClient,
  parseClientIdMetadataDocument,
  resolveCimdClient,
  type FetchFn,
  type McpOAuthTokenStore,
  type McpOAuthTokens,
} from '../src/mcp-oauth.js';

const CIMD_URL = 'https://client.example.com/oauth/client.json';
const REDIRECT = 'https://app.example.com/oauth/callback';

const VALID_DOC = {
  client_id: CIMD_URL,
  client_name: 'Test Client',
  redirect_uris: [REDIRECT],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  scope: 'mcp:tools',
};

function stubFetch(handler: (url: string) => { ok?: boolean; status?: number; body?: unknown }): FetchFn {
  return (async (url: unknown) => {
    const r = handler(String(url));
    const { ok = true, status = 200, body = {} } = r;
    return { ok, status, json: () => Promise.resolve(body) } as Response;
  }) as unknown as FetchFn;
}

describe('isCimdClientId', () => {
  it('recognizes https URLs (and localhost http for dev), not opaque ids', () => {
    expect(isCimdClientId(CIMD_URL)).toBe(true);
    expect(isCimdClientId('http://localhost:9999/client.json')).toBe(true);
    expect(isCimdClientId('plain-client-id')).toBe(false);
    expect(isCimdClientId('http://evil.example.com/client.json')).toBe(false);
  });
});

describe('parseClientIdMetadataDocument', () => {
  it('parses + validates a full document', () => {
    const doc = parseClientIdMetadataDocument(VALID_DOC, CIMD_URL);
    expect(doc.client_id).toBe(CIMD_URL);
    expect(doc.redirect_uris).toEqual([REDIRECT]);
    expect(doc.grant_types).toContain('authorization_code');
    expect(doc.token_endpoint_auth_method).toBe('none');
    expect(doc.client_name).toBe('Test Client');
  });

  it('applies spec defaults for omitted grant/response/auth fields', () => {
    const doc = parseClientIdMetadataDocument(
      { client_id: CIMD_URL, redirect_uris: [REDIRECT] },
      CIMD_URL,
    );
    expect(doc.grant_types).toEqual(['authorization_code']);
    expect(doc.response_types).toEqual(['code']);
    expect(doc.token_endpoint_auth_method).toBe('none');
  });

  it('rejects a client_id that does not match the URL it was fetched from', () => {
    expect(() =>
      parseClientIdMetadataDocument({ ...VALID_DOC, client_id: 'https://other.example.com/x.json' }, CIMD_URL),
    ).toThrow(/client_id mismatch/);
  });

  it('rejects malformed documents', () => {
    expect(() => parseClientIdMetadataDocument('nope', CIMD_URL)).toThrow(/not a JSON object/);
    expect(() => parseClientIdMetadataDocument({ client_id: CIMD_URL }, CIMD_URL)).toThrow(/redirect_uris/);
    expect(() =>
      parseClientIdMetadataDocument({ client_id: CIMD_URL, redirect_uris: [] }, CIMD_URL),
    ).toThrow(/redirect_uris/);
    expect(() =>
      parseClientIdMetadataDocument({ client_id: CIMD_URL, redirect_uris: ['not a uri'] }, CIMD_URL),
    ).toThrow(/not an absolute URI/);
    expect(() =>
      parseClientIdMetadataDocument(
        { client_id: CIMD_URL, redirect_uris: [REDIRECT], grant_types: ['client_credentials'] },
        CIMD_URL,
      ),
    ).toThrow(/grant_types/);
    expect(() =>
      parseClientIdMetadataDocument(
        { client_id: CIMD_URL, redirect_uris: [REDIRECT], response_types: ['token'] },
        CIMD_URL,
      ),
    ).toThrow(/response_types/);
  });

  it('rejects secret-bearing token endpoint auth methods (a public document cannot carry a secret)', () => {
    expect(() =>
      parseClientIdMetadataDocument(
        { ...VALID_DOC, token_endpoint_auth_method: 'client_secret_basic' },
        CIMD_URL,
      ),
    ).toThrow(/requires a client secret/);
  });

  it('rejects non-https client_id URLs', () => {
    expect(() => parseClientIdMetadataDocument(VALID_DOC, 'http://client.example.com/x.json')).toThrow(
      /https URL/,
    );
  });
});

describe('fetch + resolve (offline, injected fetch)', () => {
  it('fetches and validates the document from the client_id URL', async () => {
    const fetchFn = stubFetch((url) => (url === CIMD_URL ? { body: VALID_DOC } : { ok: false, status: 404 }));
    const doc = await fetchClientIdMetadataDocument(CIMD_URL, fetchFn);
    expect(doc.client_name).toBe('Test Client');
  });

  it('fails on HTTP errors and on documents that mismatch their URL', async () => {
    const notFound = stubFetch(() => ({ ok: false, status: 404 }));
    await expect(fetchClientIdMetadataDocument(CIMD_URL, notFound)).rejects.toThrow(/HTTP 404/);
    const mismatched = stubFetch(() => ({ body: { ...VALID_DOC, client_id: 'https://nope.example.com/c' } }));
    await expect(fetchClientIdMetadataDocument(CIMD_URL, mismatched)).rejects.toThrow(/mismatch/);
  });

  it('resolveCimdClient checks the flow redirect URI against the document', async () => {
    const fetchFn = stubFetch(() => ({ body: VALID_DOC }));
    const { client, metadata } = await resolveCimdClient(CIMD_URL, { redirectUri: REDIRECT, fetchFn });
    expect(client).toEqual({ clientId: CIMD_URL });
    expect(metadata.client_id).toBe(CIMD_URL);
    await expect(
      resolveCimdClient(CIMD_URL, { redirectUri: 'https://app.example.com/other', fetchFn }),
    ).rejects.toThrow(/redirect_uri mismatch/);
  });

  it('createCimdClientResolver plugs into the resolveClient shape', async () => {
    const fetchFn = stubFetch(() => ({ body: VALID_DOC }));
    const resolver = createCimdClientResolver(CIMD_URL, REDIRECT, fetchFn);
    await expect(resolver('any-server', {} as never)).resolves.toEqual({ clientId: CIMD_URL });
  });
});

describe('McpOAuthClient with CIMD identity', () => {
  const AS_METADATA = {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    code_challenge_methods_supported: ['S256'],
  };

  function memoryStore(): McpOAuthTokenStore {
    const tokens = new Map<string, McpOAuthTokens>();
    const clients = new Map<string, { clientId: string; clientSecret?: string }>();
    return {
      getTokens: (id) => tokens.get(id),
      saveTokens: (id, t) => void tokens.set(id, t),
      removeTokens: (id) => tokens.delete(id),
      getClientInfo: (id) => clients.get(id),
      saveClientInfo: (id, c) => void clients.set(id, c),
    };
  }

  function flowFetch(): FetchFn {
    return stubFetch((url) => {
      if (url.includes('oauth-protected-resource')) return { ok: false, status: 404 };
      if (url === 'https://mcp.example.com/.well-known/oauth-authorization-server') return { body: AS_METADATA };
      if (url === CIMD_URL) return { body: VALID_DOC };
      if (url === 'https://auth.example.com/token') {
        return { body: { access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' } };
      }
      return { ok: false, status: 404 };
    });
  }

  it('builds the authorization URL with the CIMD URL as client_id, without resolveClient', async () => {
    const client = new McpOAuthClient({
      serverId: 'srv',
      serverUrl: 'https://mcp.example.com/mcp',
      store: memoryStore(),
      cimdClientId: CIMD_URL,
      fetchFn: flowFetch(),
      resolveClient: async () => {
        throw new Error('resolveClient must not be called when CIMD is configured');
      },
    });
    const url = await client.buildAuthorizationUrl({
      state: 'state-1',
      codeVerifier: 'a'.repeat(43),
      redirectUri: REDIRECT,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe(CIMD_URL);
    expect(parsed.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('rejects a flow whose redirect URI is not in the CIMD document', async () => {
    const client = new McpOAuthClient({
      serverId: 'srv',
      serverUrl: 'https://mcp.example.com/mcp',
      store: memoryStore(),
      cimdClientId: CIMD_URL,
      fetchFn: flowFetch(),
      resolveClient: async () => ({ clientId: 'unused' }),
    });
    await expect(
      client.buildAuthorizationUrl({
        state: 's',
        codeVerifier: 'a'.repeat(43),
        redirectUri: 'https://app.example.com/undeclared',
      }),
    ).rejects.toThrow(/redirect_uri mismatch/);
  });

  it('completes the callback exchange using the CIMD identity', async () => {
    const store = memoryStore();
    const client = new McpOAuthClient({
      serverId: 'srv',
      serverUrl: 'https://mcp.example.com/mcp',
      store,
      cimdClientId: CIMD_URL,
      fetchFn: flowFetch(),
      resolveClient: async () => {
        throw new Error('resolveClient must not be called when CIMD is configured');
      },
    });
    const tokens = await client.handleCallback({
      code: 'code-1',
      codeVerifier: 'a'.repeat(43),
      redirectUri: REDIRECT,
    });
    expect(tokens.accessToken).toBe('tok-1');
    expect(store.getTokens('srv')?.accessToken).toBe('tok-1');
  });
});
