// SPDX-License-Identifier: Apache-2.0
// Egress journal settings persistence (A13 — opt-in, off by default).
//
// Settings live in <dataDir>/egress-journal-settings.json:
//   { "enabled": false }
// Env var provides the boot-time default (default off):
//   KRIYADOT_EGRESS_JOURNAL=1
//
// The setting only controls whether sandboxed run_command executions
// route through a per-run localhost proxy that journals host:port into
// the audit/Activity store. It is a VISIBILITY feature ("Visible, not
// confined"), never a confinement feature — see
// packages/agent-runtime/src/tools/egress-proxy.ts for the threat model.

import fs from 'node:fs';
import path from 'node:path';
import type { EgressJournalSettings } from '@mvp/agent-runtime';
import { egressJournalEnabledFromEnv } from '@mvp/agent-runtime';

const SETTINGS_FILE = 'egress-journal-settings.json';

export function egressSettingsPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_FILE);
}

function readFile(dataDir: string): Partial<EgressJournalSettings> {
  try {
    const raw = fs.readFileSync(egressSettingsPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Partial<EgressJournalSettings>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

function writeFile(dataDir: string, settings: EgressJournalSettings): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = egressSettingsPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, egressSettingsPath(dataDir));
}

/** Boot-time settings: persisted file first, then env, then OFF. */
export function loadEgressJournalSettings(dataDir: string): EgressJournalSettings {
  const persisted = readFile(dataDir);
  return {
    enabled: persisted.enabled ?? egressJournalEnabledFromEnv(),
  };
}

/** Sanitize user-supplied settings before persisting. */
export function sanitizeEgressJournalSettings(input: unknown): EgressJournalSettings {
  const o = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  return { enabled: o.enabled === true };
}

export function saveEgressJournalSettings(dataDir: string, settings: EgressJournalSettings): void {
  writeFile(dataDir, sanitizeEgressJournalSettings(settings));
}
