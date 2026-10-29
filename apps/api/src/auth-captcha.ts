// SPDX-License-Identifier: Apache-2.0
// Login captcha: server-generated SVG text captchas + login failure tracking.
//
// - issue(): random 5-char code rendered as an SVG with per-glyph rotation,
//   noise lines/dots and a wavy baseline path. The answer is NEVER stored in
//   plaintext — only sha256(salt + normalized answer) with a TTL (default
//   5 min), single-use, and a per-captcha attempt cap (default 3) after
//   which the captcha is burned (brute-force lockout).
// - FailureTracker: in-memory failed-login counts per account/IP key.
// - Policy hook for login routes (SSO/LDAP below, and the main login route):
//
//     import { captchaPolicy, requireCaptcha } from './auth-captcha.js';
//     if (requireCaptcha(policy, key)) { // key = account or IP
//       const ok = captchaStore.verify(body.captchaId, body.captchaAnswer);
//       if (!ok) return res.status(400).json({ ok:false, error:'captcha_required_or_invalid' });
//     }
//     // on failed password check: failures.recordFailure(key)
//     // on success: failures.clear(key)
//
// HOST WIRING (index.ts):
//   import { createCaptchaRouter } from './auth-captcha.js';
//   app.use('/api/auth/captcha', createCaptchaRouter({ store: captchaStore }));

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import express, { type Router } from 'express';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

export interface CaptchaChallenge {
  id: string;
  svg: string;
  expiresAt: number;
}

interface CaptchaEntry {
  hash: Buffer;
  salt: string;
  expiresAt: number;
  attempts: number;
}

export interface CaptchaOptions {
  ttlMs?: number;
  maxAttempts?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

function hashAnswer(salt: string, answer: string): Buffer {
  return createHash('sha256').update(`${salt}:${answer.trim().toUpperCase()}`).digest();
}

function renderSvg(code: string): string {
  const parts: string[] = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="56" viewBox="0 0 160 56">');
  parts.push('<rect width="160" height="56" fill="#f4f1ea"/>');
  // Noise lines.
  for (let i = 0; i < 5; i++) {
    const x1 = randomInt(0, 160); const y1 = randomInt(0, 56);
    const x2 = randomInt(0, 160); const y2 = randomInt(0, 56);
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#${randomInt(0x666666, 0xbbbbbb).toString(16)}" stroke-width="1"/>`);
  }
  // Wavy baseline path crossing the glyphs.
  parts.push(`<path d="M0 ${randomInt(24, 34)} Q 40 ${randomInt(10, 46)} 80 ${randomInt(24, 34)} T 160 ${randomInt(24, 34)}" fill="none" stroke="#8a7f6a" stroke-width="1.5"/>`);
  // Glyphs with rotation / offset obfuscation.
  [...code].forEach((ch, i) => {
    const x = 18 + i * 27 + randomInt(-3, 4);
    const y = 36 + randomInt(-5, 6);
    const rot = randomInt(-28, 29);
    const size = randomInt(22, 29);
    parts.push(`<text x="${x}" y="${y}" font-family="monospace" font-size="${size}" font-weight="bold" fill="#3a3348" transform="rotate(${rot} ${x} ${y})">${ch}</text>`);
  });
  // Noise dots.
  for (let i = 0; i < 24; i++) {
    parts.push(`<circle cx="${randomInt(0, 160)}" cy="${randomInt(0, 56)}" r="1.2" fill="#9a917f"/>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

export class CaptchaStore {
  private readonly entries = new Map<string, CaptchaEntry>();
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(opts: CaptchaOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.now = opts.now ?? Date.now;
  }

  issue(codeOverride?: string): CaptchaChallenge {
    let code = codeOverride ?? '';
    if (!code) {
      for (let i = 0; i < 5; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    }
    const id = randomBytes(12).toString('base64url');
    const salt = randomBytes(8).toString('hex');
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(id, { hash: hashAnswer(salt, code), salt, expiresAt, attempts: 0 });
    return { id, svg: renderSvg(code), expiresAt };
  }

  /** Single-use verify. Wrong answers burn attempts; expiry fails closed. */
  verify(id: unknown, answer: unknown): boolean {
    if (typeof id !== 'string' || typeof answer !== 'string') return false;
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return false;
    }
    entry.attempts += 1;
    const candidate = hashAnswer(entry.salt, answer);
    const ok = candidate.length === entry.hash.length && timingSafeEqual(candidate, entry.hash);
    if (ok || entry.attempts >= this.maxAttempts) this.entries.delete(id);
    return ok;
  }

  get size(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// Failure tracking + policy
// ---------------------------------------------------------------------------

export class LoginFailureTracker {
  private readonly failures = new Map<string, { count: number; lastAt: number }>();
  constructor(private readonly windowMs = 15 * 60 * 1000) {}

  recordFailure(key: string, now = Date.now()): number {
    const cur = this.failures.get(key);
    const count = cur && now - cur.lastAt <= this.windowMs ? cur.count + 1 : 1;
    this.failures.set(key, { count, lastAt: now });
    return count;
  }

  countFor(key: string, now = Date.now()): number {
    const cur = this.failures.get(key);
    if (!cur || now - cur.lastAt > this.windowMs) return 0;
    return cur.count;
  }

  clear(key: string): void {
    this.failures.delete(key);
  }
}

export interface CaptchaPolicy {
  mode: 'always' | 'after-failures' | 'never';
  /** Failures (per key) after which a captcha is required. */
  threshold?: number;
}

export function captchaPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): CaptchaPolicy {
  const mode = env.KRIYADOT_CAPTCHA_MODE;
  const threshold = Number(env.KRIYADOT_CAPTCHA_THRESHOLD ?? 3);
  return {
    mode: mode === 'always' || mode === 'never' ? mode : 'after-failures',
    threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 3,
  };
}

/** True when a login attempt for `key` must solve a captcha first. */
export function requireCaptcha(policy: CaptchaPolicy, failures: LoginFailureTracker, key: string): boolean {
  if (policy.mode === 'always') return true;
  if (policy.mode === 'never') return false;
  return failures.countFor(key) >= (policy.threshold ?? 3);
}

/** Convenience: check a captcha attempt against the policy. */
export function checkCaptcha(
  policy: CaptchaPolicy,
  failures: LoginFailureTracker,
  store: CaptchaStore,
  key: string,
  captchaId: unknown,
  captchaAnswer: unknown,
): { required: boolean; ok: boolean } {
  const required = requireCaptcha(policy, failures, key);
  if (!required) return { required: false, ok: true };
  return { required: true, ok: store.verify(captchaId, captchaAnswer) };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function createCaptchaRouter(deps: { store?: CaptchaStore } = {}): Router {
  const store = deps.store ?? new CaptchaStore();
  const router = express.Router();
  router.get('/', (_req, res) => {
    const challenge = store.issue();
    res.json({ ok: true, id: challenge.id, svg: challenge.svg, expiresAt: challenge.expiresAt });
  });
  router.post('/verify', (req, res) => {
    const body = (req.body ?? {}) as { id?: unknown; answer?: unknown };
    const ok = store.verify(body.id, body.answer);
    res.status(ok ? 200 : 400).json({ ok });
  });
  return router;
}
