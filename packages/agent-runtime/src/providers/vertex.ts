// SPDX-License-Identifier: Apache-2.0
/**
 * Google Vertex AI driver (Octomind parity — broader direct providers).
 *
 * Vertex exposes an OpenAI-compatible chat-completions endpoint, but
 * authentication is Google OAuth2, not an API key: a service-account
 * key exchanges a signed JWT (RS256) for a short-lived access token at
 * oauth2.googleapis.com. This driver performs that exchange in pure
 * TypeScript (node:crypto signing), caches the token until shortly
 * before expiry, and delegates the chat call to the OpenAI-compatible
 * driver pointed at the Vertex endpoint.
 *
 * Configuration (env): GOOGLE_APPLICATION_CREDENTIALS (path to the
 * service-account JSON), GOOGLE_CLOUD_PROJECT (or VERTEX_PROJECT),
 * GOOGLE_CLOUD_LOCATION / VERTEX_LOCATION (default us-central1).
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ChatMessage, LLMProvider, ModelInfo, ToolDefinition } from '../types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export interface VertexOptions {
  project?: string;
  location?: string;
  credentialsPath?: string;
  serviceAccount?: ServiceAccountKey;
  fetchFn?: typeof fetch;
  now?: () => number;
}

function base64Url(data: string | Buffer): string {
  return Buffer.from(data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Build the signed JWT assertion for the token exchange (exported for tests). */
export function buildServiceAccountJwt(sa: ServiceAccountKey, nowSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = base64Url(signer.sign(sa.private_key));
  return `${unsigned}.${signature}`;
}

export class VertexProvider implements LLMProvider {
  readonly providerId = 'vertex';
  private readonly project: string;
  private readonly location: string;
  private readonly credentialsPath?: string;
  private readonly serviceAccount?: ServiceAccountKey;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private cached?: { token: string; expiresAtMs: number; inner: OpenAICompatibleProvider };

  constructor(opts: VertexOptions = {}) {
    this.project =
      opts.project ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.VERTEX_PROJECT ?? '';
    this.location =
      opts.location ??
      process.env.GOOGLE_CLOUD_LOCATION ??
      process.env.VERTEX_LOCATION ??
      'us-central1';
    this.credentialsPath =
      opts.credentialsPath ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
    this.serviceAccount = opts.serviceAccount;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  private loadServiceAccount(): ServiceAccountKey {
    if (this.serviceAccount) return this.serviceAccount;
    if (!this.credentialsPath) {
      throw new Error(
        'Vertex AI is not configured: set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path.',
      );
    }
    const parsed = JSON.parse(readFileSync(this.credentialsPath, 'utf8')) as ServiceAccountKey;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('Vertex service-account JSON is missing client_email or private_key.');
    }
    return parsed;
  }

  private async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - this.now() > 60_000) return this.cached.token;
    const sa = this.loadServiceAccount();
    const assertion = buildServiceAccountJwt(sa, Math.floor(this.now() / 1000));
    const res = await this.fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Vertex token exchange failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('Vertex token exchange returned no access_token.');
    const expiresAtMs = this.now() + (data.expires_in ?? 3600) * 1000;
    const baseUrl =
      `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.project}` +
      `/locations/${this.location}/endpoints/openapi`;
    this.cached = {
      token: data.access_token,
      expiresAtMs,
      inner: new OpenAICompatibleProvider({
        providerId: 'vertex',
        baseUrl,
        apiKey: data.access_token,
      }),
    };
    return data.access_token;
  }

  private async inner(): Promise<OpenAICompatibleProvider> {
    await this.accessToken();
    return this.cached!.inner;
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: Parameters<LLMProvider['chat']>[2],
  ): ReturnType<LLMProvider['chat']> {
    if (!this.project) {
      throw new Error('Vertex AI is not configured: set GOOGLE_CLOUD_PROJECT (or VERTEX_PROJECT).');
    }
    const inner = await this.inner();
    // #34: the result is returned verbatim from the inner
    // OpenAI-compatible driver, so any nativeItems it attaches flow
    // through untouched, and stored nativeItems on `messages` are
    // handed to it as-is. (The inner driver is the fenced
    // openai-compatible.ts — its own capture state is reported in the
    // closure report.)
    return inner.chat(messages, tools, opts);
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash (Vertex)' },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro (Vertex)' },
    ];
  }
}
