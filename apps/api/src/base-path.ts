// SPDX-License-Identifier: Apache-2.0
// Subpath serving (Octop §2.1 deployment polish): run the whole deployment
// under a URL prefix (e.g. https://host/kriyadot/...) behind a reverse
// proxy, driven by KRIYADOT_BASE_PATH.
//
// API side: createBasePathMiddleware strips + validates the prefix before
// the app's routers run. All routers created in the KB/workspace/TLS
// workstream are mount-path-agnostic (they never hardcode '/api/...' in
// their own paths), so they work under any prefix once this middleware
// (or an equivalent proxy strip) has run.
//
//   import { createBasePathMiddleware, basePathFromEnv } from './base-path.js';
//   const basePath = basePathFromEnv();
//   if (basePath) app.use(createBasePathMiddleware(basePath));
//
// WEB side (parent must apply — NOT edited here): in apps/web/next.config.mjs
// add `basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined` to the
// exported config, and build the web app with the same prefix in
// NEXT_PUBLIC_BASE_PATH. The exported WEB_NEXT_CONFIG_SNIPPET below is the
// exact snippet to paste.

import type { NextFunction, Request, Response } from 'express';

/** Normalize a base path: '' when unset/root, else '/seg[/seg...]' with no trailing slash. */
export function normalizeBasePath(input: string | undefined | null): string {
  const raw = (input ?? '').trim();
  if (!raw || raw === '/') return '';
  if (raw.includes('\\') || raw.includes('..') || raw.includes('\0')) {
    throw new Error(`invalid base path: ${input}`);
  }
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '');
}

export function basePathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeBasePath(env.KRIYADOT_BASE_PATH);
}

/**
 * Express middleware: requests outside the prefix get a 404; requests
 * under it have the prefix stripped from req.url before routing.
 */
export function createBasePathMiddleware(basePathInput: string) {
  const basePath = normalizeBasePath(basePathInput);
  return function basePathMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!basePath) {
      next();
      return;
    }
    const url = req.url ?? '/';
    const qIdx = url.indexOf('?');
    const pathPart = qIdx >= 0 ? url.slice(0, qIdx) : url;
    const queryPart = qIdx >= 0 ? url.slice(qIdx) : '';
    if (pathPart === basePath) {
      req.url = `/${queryPart}`;
      // Express caches req.path parsing off req.url — keep originalUrl intact for logging.
      next();
      return;
    }
    if (pathPart.startsWith(`${basePath}/`)) {
      req.url = `${pathPart.slice(basePath.length)}${queryPart}`;
      next();
      return;
    }
    res.status(404).json({ error: `not found (this deployment is served under ${basePath})` });
  };
}

/** Config object a host can hand to the web build / status endpoints. */
export function basePathWebConfig(env: NodeJS.ProcessEnv = process.env): {
  basePath: string;
  env: { NEXT_PUBLIC_BASE_PATH: string };
  nextConfigBasePath: string | undefined;
} {
  const basePath = basePathFromEnv(env);
  return {
    basePath,
    env: { NEXT_PUBLIC_BASE_PATH: basePath },
    nextConfigBasePath: basePath || undefined,
  };
}

/** Exact change the parent applies to apps/web/next.config.mjs for subpath serving. */
export const WEB_NEXT_CONFIG_SNIPPET = `
// Subpath serving: mirror the API's KRIYADOT_BASE_PATH in the web build.
// In apps/web/next.config.mjs, add to the exported nextConfig object:
const nextConfig = {
  output: 'export',
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
};
// …and build with NEXT_PUBLIC_BASE_PATH set to the same value as the
// API's KRIYADOT_BASE_PATH (e.g. /kriyadot). Asset URLs and client-side
// /api fetches must also be prefixed with that value at runtime.
`;
