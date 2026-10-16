// SPDX-License-Identifier: Apache-2.0
// Product analytics settings persistence (opt-in, off by default).
//
// Settings live in <dataDir>/analytics-settings.json:
//   { "enabled": false, "crashReporting": false, "endpoint": "" }
// Env vars provide boot-time defaults (all default off):
//   KRIYADOT_ANALYTICS_ENABLED=1, KRIYADOT_ANALYTICS_CRASH=1,
//   KRIYADOT_ANALYTICS_ENDPOINT=https://...

import fs from 'node:fs';
import path from 'node:path';
import type { AnalyticsSettings } from '@mvp/agent-runtime';

const SETTINGS_FILE = 'analytics-settings.json';

export function analyticsSettingsPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_FILE);
}

function readFile(dataDir: string): Partial<AnalyticsSettings> {
  try {
    const raw = fs.readFileSync(analyticsSettingsPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Partial<AnalyticsSettings>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function writeFile(dataDir: string, settings: AnalyticsSettings): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = analyticsSettingsPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, analyticsSettingsPath(dataDir));
}

function envBool(name: string): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Boot-time settings: env vars first, then persisted file, then defaults. */
export function loadAnalyticsSettings(dataDir: string): AnalyticsSettings {
  const persisted = readFile(dataDir);
  return {
    enabled: persisted.enabled ?? envBool('KRIYADOT_ANALYTICS_ENABLED'),
    crashReporting: persisted.crashReporting ?? envBool('KRIYADOT_ANALYTICS_CRASH'),
    endpoint:
      typeof persisted.endpoint === 'string' && persisted.endpoint
        ? persisted.endpoint
        : (process.env.KRIYADOT_ANALYTICS_ENDPOINT ?? '').trim(),
  };
}

/** Sanitize user-supplied settings before persisting. */
export function sanitizeAnalyticsSettings(input: unknown): AnalyticsSettings {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  let endpoint = '';
  if (typeof o.endpoint === 'string') {
    const v = o.endpoint.trim().slice(0, 2048);
    // Only http(s) endpoints; anything else is dropped (no file://, no JS).
    if (/^https?:\/\//i.test(v)) endpoint = v;
  }
  return {
    enabled: o.enabled === true,
    crashReporting: o.crashReporting === true,
    endpoint,
  };
}

export function saveAnalyticsSettings(dataDir: string, settings: AnalyticsSettings): void {
  writeFile(dataDir, sanitizeAnalyticsSettings(settings));
}
