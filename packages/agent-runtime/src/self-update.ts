// SPDX-License-Identifier: Apache-2.0
// Self-update mechanism (Atomic Agent parity).
//
// Checks the official KriyaDot GitHub releases for newer versions, downloads
// the platform-appropriate installer asset, and launches it with explicit
// user consent. Never auto-installs; the update source is pinned to
// MaddyInnov/KriyaDot and cannot be reconfigured to arbitrary URLs.
//
// State machine: idle → checking → available → downloading → ready →
// installing. Errors land in 'error' with a message; a new check resets.
//
// Rollback is best-effort: the previously downloaded installer is kept in
// <dataDir>/updates/ so it can be re-run manually. There is no automatic
// health-check-and-revert; that is documented honestly in the UI.

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Pinned constants — the update source is NOT configurable.
// ---------------------------------------------------------------------------

/** Pinned GitHub repo. Never changed at runtime. */
export const UPDATE_REPO = 'MaddyInnov/KriyaDot';
/** Pinned GitHub API endpoint for releases. */
export const RELEASES_API_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases`;

/** Minimum sane interval between automatic checks (hours). */
export const MIN_CHECK_INTERVAL_HOURS = 1;
/** Default automatic check interval (hours). */
export const DEFAULT_CHECK_INTERVAL_HOURS = 24;

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

export interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  body: string;
  publishedAt: string;
  prerelease: boolean;
  htmlUrl: string;
}

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  latest: ReleaseInfo | null;
  asset: { name: string; size: number } | null;
  downloadedPath: string | null;
  downloadedBytes: number;
  totalBytes: number;
  progress: number; // 0..1 while downloading
  lastCheckedAt: number | null;
  lastError: string | null;
  previousInstaller: string | null;
  platform: string;
  arch: string;
}

export interface UpdateSettings {
  autoCheck: boolean;
  checkIntervalHours: number;
}

export interface UpdateProgressEvent {
  downloadedBytes: number;
  totalBytes: number;
  progress: number;
}

// ---------------------------------------------------------------------------
// Version comparison (handles -alpha/-beta suffixes).
// ---------------------------------------------------------------------------

interface ParsedVersion {
  nums: number[];
  pre: string | null;
}

export function parseVersion(v: string): ParsedVersion {
  let s = v.trim().replace(/^v/i, '');
  let pre: string | null = null;
  const dash = s.indexOf('-');
  if (dash >= 0) {
    pre = s.slice(dash + 1);
    s = s.slice(0, dash);
  }
  const plus = s.indexOf('+');
  if (plus >= 0) s = s.slice(0, plus);
  const nums = s
    .split('.')
    .map((x) => {
      const n = parseInt(x, 10);
      return Number.isFinite(n) ? n : 0;
    });
  return { nums, pre };
}

/**
 * Compare two version strings. Returns -1 if a < b, 0 if equal, 1 if a > b.
 * A release (no prerelease suffix) is newer than the same numeric version
 * with a suffix: 0.1.0 > 0.1.0-alpha.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  if (pa.pre < pb.pre) return -1;
  if (pa.pre > pb.pre) return 1;
  return 0;
}

/** True when `candidate` is a newer version than `current`. */
export function isNewerVersion(current: string, candidate: string): boolean {
  return compareVersions(candidate, current) > 0;
}

// ---------------------------------------------------------------------------
// Platform asset selection.
// ---------------------------------------------------------------------------

function nameHasArch(name: string, arch: string): boolean {
  const n = name.toLowerCase();
  if (arch === 'arm64') return n.includes('arm64') || n.includes('aarch64');
  if (arch === 'x64') return n.includes('x64') || n.includes('amd64');
  return false;
}

/**
 * Pick the installer asset for the current OS/arch from a release's asset
 * list. Windows: *-setup.exe; macOS: *.dmg; Linux: *.AppImage then *.deb.
 * Returns null when nothing matches.
 */
export function selectAssetForPlatform(
  assets: ReleaseAsset[],
  platform: string,
  arch: string,
): ReleaseAsset | null {
  const byArch = (list: ReleaseAsset[]): ReleaseAsset | null => {
    if (list.length === 0) return null;
    return list.find((a) => nameHasArch(a.name, arch)) ?? list[0];
  };
  if (platform === 'win32') {
    return byArch(assets.filter((a) => /setup.*\.exe$/i.test(a.name)));
  }
  if (platform === 'darwin') {
    return byArch(assets.filter((a) => /\.dmg$/i.test(a.name)));
  }
  if (platform === 'linux') {
    const appImage = assets.filter((a) => /\.appimage$/i.test(a.name));
    if (appImage.length > 0) return byArch(appImage);
    return byArch(assets.filter((a) => /\.deb$/i.test(a.name)));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manager.
// ---------------------------------------------------------------------------

export interface SelfUpdateDeps {
  dataDir: string;
  currentVersion: string;
  fetch?: typeof fetch;
  platform?: string;
  arch?: string;
  spawn?: (
    cmd: string,
    args: string[],
    opts: { detached: boolean; stdio: 'ignore' },
  ) => ChildProcess;
  /** Injected so tests don't kill the process. */
  exit?: (code: number) => void;
  onProgress?: (e: UpdateProgressEvent) => void;
  /** Skip auto-check timer (tests). */
  noAutoCheck?: boolean;
}

interface PersistedState {
  lastCheckedAt: number | null;
  latest: ReleaseInfo | null;
  downloadedPath: string | null;
  previousInstaller: string | null;
}

const DEFAULT_SETTINGS: UpdateSettings = {
  autoCheck: true,
  checkIntervalHours: DEFAULT_CHECK_INTERVAL_HOURS,
};

export class SelfUpdateManager {
  private readonly dataDir: string;
  private readonly updatesDir: string;
  private readonly currentVersion: string;
  private readonly fetchFn: typeof fetch;
  private readonly platform: string;
  private readonly arch: string;
  private readonly spawnFn: SelfUpdateDeps['spawn'];
  private readonly exitFn: (code: number) => void;
  private readonly onProgress?: (e: UpdateProgressEvent) => void;

  private state: UpdateState = 'idle';
  private latest: ReleaseInfo | null = null;
  private asset: ReleaseAsset | null = null;
  private downloadedPath: string | null = null;
  private downloadedBytes = 0;
  private lastCheckedAt: number | null = null;
  private lastError: string | null = null;
  private previousInstaller: string | null = null;
  private settings: UpdateSettings = { ...DEFAULT_SETTINGS };
  private timer: ReturnType<typeof setInterval> | null = null;
  private downloadAbort: AbortController | null = null;

  constructor(deps: SelfUpdateDeps) {
    this.dataDir = deps.dataDir;
    this.updatesDir = join(deps.dataDir, 'updates');
    this.currentVersion = deps.currentVersion;
    this.fetchFn = deps.fetch ?? fetch;
    this.platform = deps.platform ?? process.platform;
    this.arch = deps.arch ?? process.arch;
    this.spawnFn = deps.spawn;
    this.exitFn = deps.exit ?? ((code) => process.exit(code));
    this.onProgress = deps.onProgress;
    void this.loadState();
    void this.loadSettings().then(() => {
      if (!deps.noAutoCheck) this.startAutoCheck();
    });
  }

  // -- persistence ----------------------------------------------------------

  private statePath(): string {
    return join(this.updatesDir, 'state.json');
  }

  private settingsPath(): string {
    return join(this.updatesDir, 'settings.json');
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await readFile(this.statePath(), 'utf8');
      const s = JSON.parse(raw) as PersistedState;
      this.lastCheckedAt = s.lastCheckedAt;
      this.latest = s.latest;
      this.downloadedPath = s.downloadedPath;
      this.previousInstaller = s.previousInstaller;
    } catch {
      // No prior state — start fresh.
    }
  }

  private async saveState(): Promise<void> {
    const s: PersistedState = {
      lastCheckedAt: this.lastCheckedAt,
      latest: this.latest,
      downloadedPath: this.downloadedPath,
      previousInstaller: this.previousInstaller,
    };
    await mkdir(this.updatesDir, { recursive: true });
    await writeFile(this.statePath(), JSON.stringify(s, null, 2));
  }

  private async loadSettings(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath(), 'utf8');
      const s = JSON.parse(raw) as Partial<UpdateSettings>;
      this.settings = sanitizeSettings(s);
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  async getSettings(): Promise<UpdateSettings> {
    return { ...this.settings };
  }

  async saveSettings(next: Partial<UpdateSettings>): Promise<UpdateSettings> {
    this.settings = sanitizeSettings({ ...this.settings, ...next });
    await mkdir(this.updatesDir, { recursive: true });
    await writeFile(this.settingsPath(), JSON.stringify(this.settings, null, 2));
    this.startAutoCheck(); // re-arm with the new interval
    return { ...this.settings };
  }

  // -- status ---------------------------------------------------------------

  async getStatus(): Promise<UpdateStatus> {
    return {
      state: this.state,
      currentVersion: this.currentVersion,
      latest: this.latest,
      asset: this.asset ? { name: this.asset.name, size: this.asset.size } : null,
      downloadedPath: this.downloadedPath,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.asset?.size ?? 0,
      progress:
        this.asset && this.asset.size > 0
          ? Math.min(1, this.downloadedBytes / this.asset.size)
          : 0,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
      previousInstaller: this.previousInstaller,
      platform: this.platform,
      arch: this.arch,
    };
  }

  // -- auto-check -----------------------------------------------------------

  startAutoCheck(): void {
    this.stopAutoCheck();
    if (!this.settings.autoCheck) return;
    const ms = Math.max(MIN_CHECK_INTERVAL_HOURS, this.settings.checkIntervalHours) * 3600_000;
    this.timer = setInterval(() => {
      // Skip while a download/install is in flight; the check is cheap and
      // must never fight user-initiated work.
      if (this.state === 'idle' || this.state === 'available' || this.state === 'error') {
        void this.checkNow().catch(() => undefined);
      }
    }, ms);
    // Never keep the process alive for update polling.
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  stopAutoCheck(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // -- check ----------------------------------------------------------------

  private async fetchReleases(): Promise<ReleaseInfo[]> {
    const res = await this.fetchFn(RELEASES_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'KriyaDot-Updater',
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub releases API returned ${res.status}`);
    }
    const list = (await res.json()) as Array<{
      tag_name?: string;
      name?: string;
      body?: string;
      published_at?: string;
      prerelease?: boolean;
      draft?: boolean;
      html_url?: string;
      assets?: ReleaseAsset[];
    }>;
    const out: ReleaseInfo[] = [];
    for (const r of list) {
      if (r.draft || !r.tag_name) continue;
      out.push({
        tag: r.tag_name,
        name: r.name ?? r.tag_name,
        body: r.body ?? '',
        publishedAt: r.published_at ?? '',
        prerelease: r.prerelease ?? false,
        htmlUrl: r.html_url ?? '',
      });
      // Stash raw assets on the info object for the selector below.
      (out[out.length - 1] as ReleaseInfo & { _assets?: ReleaseAsset[] })._assets =
        r.assets ?? [];
    }
    return out;
  }

  /**
   * Check for updates now. Safe to call repeatedly; never downloads anything.
   */
  async checkNow(): Promise<UpdateStatus> {
    if (this.state === 'downloading' || this.state === 'installing') {
      return this.getStatus();
    }
    this.state = 'checking';
    this.lastError = null;
    try {
      const releases = await this.fetchReleases();
      // Pick the newest non-draft release newer than the current version.
      // (Includes prereleases — KriyaDot ships on an alpha channel.)
      let best: (ReleaseInfo & { _assets?: ReleaseAsset[] }) | null = null;
      for (const r of releases as Array<ReleaseInfo & { _assets?: ReleaseAsset[] }>) {
        if (!isNewerVersion(this.currentVersion, r.tag)) continue;
        if (!best || compareVersions(r.tag, best.tag) > 0) best = r;
      }
      this.lastCheckedAt = Date.now();
      if (!best) {
        this.latest = null;
        this.asset = null;
        this.state = 'idle';
      } else {
        this.latest = {
          tag: best.tag,
          name: best.name,
          body: best.body,
          publishedAt: best.publishedAt,
          prerelease: best.prerelease,
          htmlUrl: best.htmlUrl,
        };
        this.asset = selectAssetForPlatform(best._assets ?? [], this.platform, this.arch);
        this.state = 'available';
      }
      await this.saveState();
    } catch (err) {
      this.state = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    return this.getStatus();
  }

  // -- download (explicit consent only) -------------------------------------

  /**
   * Download the selected installer asset. Requires state 'available' — i.e.
   * the user has seen the update and explicitly clicked download. There is
   * no automatic download path.
   */
  async download(): Promise<UpdateStatus> {
    if (this.state !== 'available' || !this.asset || !this.latest) {
      throw new Error('No update is available to download. Run a check first.');
    }
    this.state = 'downloading';
    this.downloadedBytes = 0;
    this.lastError = null;
    const asset = this.asset;
    const dest = join(this.updatesDir, asset.name);
    const tmp = join(tmpdir(), `kriyadot-update-${Date.now()}-${asset.name}`);
    try {
      await mkdir(this.updatesDir, { recursive: true });
      this.downloadAbort = new AbortController();
      const res = await this.fetchFn(asset.browser_download_url, {
        signal: this.downloadAbort.signal,
        headers: { 'User-Agent': 'KriyaDot-Updater' },
      });
      if (!res.ok || !res.body) {
        throw new Error(`Download failed with status ${res.status}`);
      }
      const total = asset.size;
      const out = createWriteStream(tmp);
      const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
      // Count bytes through a Transform so progress events don't fight
      // pipeline's own consumption of the stream.
      const { Transform } = await import('node:stream');
      const counter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          this.downloadedBytes += chunk.length;
          this.onProgress?.({
            downloadedBytes: this.downloadedBytes,
            totalBytes: total,
            progress: total > 0 ? Math.min(1, this.downloadedBytes / total) : 0,
          });
          cb(null, chunk);
        },
      });
      await pipeline(nodeStream, counter, out);
      // Size verification at minimum; checksum when the release ships one.
      const st = await stat(tmp);
      if (total > 0 && st.size !== total) {
        throw new Error(
          `Downloaded size ${st.size} does not match expected ${total} — discarding.`,
        );
      }
      await this.verifyChecksumIfAvailable(asset, tmp);
      await rename(tmp, dest);
      // Keep the previous installer for best-effort rollback.
      if (this.downloadedPath && this.downloadedPath !== dest && existsSync(this.downloadedPath)) {
        this.previousInstaller = this.downloadedPath;
      }
      this.downloadedPath = dest;
      this.state = 'ready';
      await this.saveState();
    } catch (err) {
      this.state = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(tmp);
      } catch {
        // tmp may not exist — fine.
      }
    } finally {
      this.downloadAbort = null;
    }
    return this.getStatus();
  }

  /** If the release ships a `<asset>.sha256` sidecar asset, verify against it. */
  private async verifyChecksumIfAvailable(
    asset: ReleaseAsset,
    filePath: string,
  ): Promise<void> {
    // We only know the assets of the chosen release; re-fetch is cheap and
    // only happens right before install, not during polling.
    let releases: Array<{ assets?: ReleaseAsset[] }> = [];
    try {
      const res = await this.fetchFn(RELEASES_API_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'KriyaDot-Updater' },
      });
      if (res.ok) releases = (await res.json()) as Array<{ assets?: ReleaseAsset[] }>;
    } catch {
      return; // checksum is best-effort; size check already passed
    }
    const want = `${asset.name}.sha256`;
    let sidecar: ReleaseAsset | undefined;
    for (const r of releases) {
      sidecar = (r.assets ?? []).find((a) => a.name === want);
      if (sidecar) break;
    }
    if (!sidecar) return;
    const res = await this.fetchFn(sidecar.browser_download_url, {
      headers: { 'User-Agent': 'KriyaDot-Updater' },
    });
    if (!res.ok) return;
    const text = (await res.text()).trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9a-fA-F]{64}$/.test(text)) return;
    const hash = createHash('sha256');
    const { createReadStream } = await import('node:fs');
    await pipeline(createReadStream(filePath), hash);
    const actual = hash.digest('hex');
    if (actual.toLowerCase() !== text.toLowerCase()) {
      throw new Error('SHA-256 checksum mismatch — discarding downloaded installer.');
    }
  }

  cancelDownload(): void {
    this.downloadAbort?.abort();
  }

  // -- install (explicit consent only) --------------------------------------

  /**
   * Verify the downloaded asset and launch the platform installer.
   * Requires state 'ready'. Windows/macOS: launch the installer and quit —
   * the installer itself performs the upgrade. Linux: open the package with
   * the desktop handler (software center) and stay running with guidance.
   */
  async install(): Promise<UpdateStatus> {
    if (this.state !== 'ready' || !this.downloadedPath || !existsSync(this.downloadedPath)) {
      throw new Error('No downloaded update is ready to install.');
    }
    const installerPath = this.downloadedPath;
    this.state = 'installing';
    this.lastError = null;
    try {
      if (this.platform === 'win32') {
        this.launchDetached(installerPath, []);
        // The installer takes over from here.
        this.exitFn(0);
      } else if (this.platform === 'darwin') {
        this.launchDetached('open', [installerPath]);
        // User completes the install from the mounted disk image.
        this.exitFn(0);
      } else {
        // Linux: hand the .deb/.AppImage to the desktop software handler.
        // We stay running — the handler (software center) guides the user.
        this.launchDetached('xdg-open', [installerPath]);
      }
    } catch (err) {
      this.state = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    return this.getStatus();
  }

  private launchDetached(cmd: string, args: string[]): void {
    if (!this.spawnFn) {
      throw new Error(`Cannot launch installer on ${this.platform}: no launcher available.`);
    }
    const child = this.spawnFn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  }

  /** Test/dev helper: wipe in-memory run state (persisted state untouched). */
  resetForTest(): void {
    this.state = 'idle';
    this.latest = null;
    this.asset = null;
    this.downloadedPath = null;
    this.downloadedBytes = 0;
    this.lastError = null;
  }
}

export function sanitizeSettings(s: Partial<UpdateSettings>): UpdateSettings {
  const autoCheck = typeof s.autoCheck === 'boolean' ? s.autoCheck : DEFAULT_SETTINGS.autoCheck;
  const raw = s.checkIntervalHours;
  let checkIntervalHours = DEFAULT_SETTINGS.checkIntervalHours;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    // Fractional values clamp up to the minimum rather than snapping to default.
    const floored = Math.floor(raw) || MIN_CHECK_INTERVAL_HOURS;
    checkIntervalHours = Math.max(MIN_CHECK_INTERVAL_HOURS, Math.min(24 * 30, floored));
  }
  return { autoCheck, checkIntervalHours };
}

export function defaultUpdateSettings(): UpdateSettings {
  return { ...DEFAULT_SETTINGS };
}
