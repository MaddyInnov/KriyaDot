// SPDX-License-Identifier: Apache-2.0
/**
 * ACP agent auto-detection — scans PATH + common install locations for known
 * coding-agent CLIs (Codync parity: ~40 harnesses via the ACP registry).
 *
 * Security contract (hard rules):
 * - Detection is pure PATH lookup + `--version` probes. No credential bytes
 *   are ever read; CLIs keep their own auth (their own login flows).
 * - `--version` is spawned WITHOUT a shell (argv array), with a short
 *   timeout, so a hostile binary on PATH cannot hang or inject.
 * - Results are cached; rescan is explicit (startup + on-demand), never
 *   per-request.
 */

import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Statically imported so single-file binaries (bun --compile) carry the
// registry even though import.meta.url no longer points at a real directory.
// The filesystem copy (shipped next to dist/) still wins when present.
import bundledRegistry from './agent-registry.json' with { type: 'json' };

export interface AgentRegistryEntry {
  id: string;
  name: string;
  bins: string[];
  homepage: string;
  installHint: string;
  installHintWindows?: string;
  versionFlag: string;
  acpCompatible: boolean;
}

export interface DetectedAgent {
  id: string;
  name: string;
  /** Binary that was found, e.g. "claude". */
  bin: string;
  /** Absolute path of the binary, e.g. "C:\\Program Files\\...\\claude.exe". */
  path: string;
  /** Best-effort `--version` output (first line), null when the probe failed. */
  version: string | null;
  acpCompatible: boolean;
  homepage: string;
}

export interface UndetectedAgent extends AgentRegistryEntry {
  installed: false;
}

export type AgentListEntry = (DetectedAgent & { installed: true }) | UndetectedAgent;

interface RegistryFile {
  agents: AgentRegistryEntry[];
}

let cachedRegistry: RegistryFile | null = null;

function registryFilePath(): string {
  return fileURLToPath(new URL('./agent-registry.json', import.meta.url));
}

/** Load the agent registry (filesystem copy wins; bundled import as fallback). */
export function loadAgentRegistry(): AgentRegistryEntry[] {
  if (!cachedRegistry) {
    try {
      const raw = readFileSync(registryFilePath(), 'utf-8');
      cachedRegistry = JSON.parse(raw) as RegistryFile;
    } catch {
      cachedRegistry = bundledRegistry as RegistryFile;
    }
  }
  return cachedRegistry.agents;
}

/** Extra directories to search beyond PATH (per OS). */
function extraSearchDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];
  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || '';
    const progFiles = process.env.PROGRAMFILES || '';
    const progFilesX86 = process.env['PROGRAMFILES(X86)'] || '';
    dirs.push(
      join(home, 'AppData', 'Local', 'Programs'),
      join(localApp, 'Programs'),
      join(progFiles, 'nodejs'),
      join(progFilesX86, 'nodejs'),
      join(home, '.local', 'bin'),
      join(home, 'scoop', 'shims'),
    );
    // Version managers
    const nvmHome = process.env.NVM_HOME || join(home, 'AppData', 'Roaming', 'nvm');
    dirs.push(nvmHome);
  } else {
    dirs.push(
      join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(home, '.bun', 'bin'),
      join(home, '.volta', 'bin'),
      join(home, '.asdf', 'shims'),
      join(home, '.mise', 'shims'),
    );
    // nvm node versions
    const nvmDir = process.env.NVM_DIR || join(home, '.nvm');
    dirs.push(join(nvmDir, 'current', 'bin'));
  }
  return dirs.filter(Boolean);
}

const EXE_SUFFIXES = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

/** Resolve a binary name to an absolute path (PATH + extra dirs). Null when absent. */
export function whichSync(bin: string): string | null {
  const pathVar = process.env.PATH || '';
  const searchDirs = [...pathVar.split(delimiter), ...extraSearchDirs()];
  for (const dir of searchDirs) {
    if (!dir) continue;
    for (const suffix of EXE_SUFFIXES) {
      const candidate = join(dir, bin + suffix);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here — keep looking
      }
    }
  }
  return null;
}

function probeVersion(binPath: string, versionFlag: string, timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binPath, [versionFlag], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const firstLine = (stdout || '').split('\n')[0]?.trim() || '';
      resolve(firstLine.slice(0, 120) || null);
    });
  });
}

let cachedScan: DetectedAgent[] | null = null;
let lastScanAt = 0;

/** Scan for installed agent CLIs. Results are cached until rescan() is called. */
export async function scanAgents(opts: { force?: boolean } = {}): Promise<DetectedAgent[]> {
  if (cachedScan && !opts.force) return cachedScan;
  const registry = loadAgentRegistry();
  const found: DetectedAgent[] = [];
  const seenBins = new Set<string>();
  for (const entry of registry) {
    for (const bin of entry.bins) {
      if (seenBins.has(bin)) continue;
      const abs = whichSync(bin);
      if (abs) {
        seenBins.add(bin);
        const version = await probeVersion(abs, entry.versionFlag || '--version');
        found.push({
          id: entry.id,
          name: entry.name,
          bin,
          path: abs,
          version,
          acpCompatible: entry.acpCompatible,
          homepage: entry.homepage,
        });
        break; // one binary per agent is enough
      }
    }
  }
  // Detected first, then alphabetical
  found.sort((a, b) => a.name.localeCompare(b.name));
  cachedScan = found;
  lastScanAt = Date.now();
  return found;
}

/** Full list: detected agents first (installed: true), then the rest with install hints. */
export async function listAgents(opts: { force?: boolean } = {}): Promise<AgentListEntry[]> {
  const detected = await scanAgents(opts);
  const detectedIds = new Set(detected.map((d) => d.id));
  const registry = loadAgentRegistry();
  const out: AgentListEntry[] = detected.map((d) => ({ ...d, installed: true as const }));
  for (const entry of registry) {
    if (!detectedIds.has(entry.id)) out.push({ ...entry, installed: false });
  }
  return out;
}

/** Forget the cache; the next scanAgents() re-reads the filesystem. */
export function rescanAgents(): void {
  cachedScan = null;
}

export function lastScanTime(): number {
  return lastScanAt;
}

/** Validate registry entries (used by tests). */
export function validateRegistry(entries: AgentRegistryEntry[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const e of entries) {
    if (!e.id || ids.has(e.id)) errors.push(`duplicate/missing id: ${e.id}`);
    ids.add(e.id);
    if (!e.name) errors.push(`missing name for ${e.id}`);
    if (!e.bins?.length) errors.push(`missing bins for ${e.id}`);
    if (!e.installHint) errors.push(`missing installHint for ${e.id}`);
    if (!e.homepage) errors.push(`missing homepage for ${e.id}`);
  }
  return errors;
}
