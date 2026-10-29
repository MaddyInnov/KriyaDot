// SPDX-License-Identifier: Apache-2.0
// Open-at-login (W12d): OS-level autostart for KriyaDot, implemented
// entirely with per-OS entry FILES written from TypeScript — no native
// helper and no Tauri plugin required, so every branch is testable here:
//
//   Linux   → ~/.config/autostart/kriyadot.desktop        (XDG autostart)
//   macOS   → ~/Library/LaunchAgents/com.kriyadot.desktop.plist
//   Windows → %APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/KriyaDot.cmd
//
// Enabling writes the entry for the current OS pointing at the app's exec
// path; disabling removes exactly that file. status() reports whether the
// entry exists AND still points at the expected exec path (a stale entry
// from a moved install reports enabled:false with a `stale` note).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AUTOSTART_APP_NAME = 'KriyaDot';
/** macOS LaunchAgent label — matches the desktop bundle identifier. */
export const AUTOSTART_MAC_LABEL = 'com.kriyadot.desktop';

export type AutostartPlatform = 'linux' | 'darwin' | 'win32';

export interface AutostartDeps {
  platform?: string;
  homeDir?: string;
  /** App data dir for win32 %APPDATA% resolution; defaults to env/home. */
  appDataDir?: string;
  /** XDG config dir for linux; defaults to $XDG_CONFIG_HOME when no explicit homeDir is given, else ~/.config. */
  xdgConfigHome?: string;
  /** Executable the entry launches. Defaults to KRIYADOT_EXEC_PATH or the current process exec path. */
  execPath?: string;
  /** Extra args appended to the exec path (rarely needed). */
  execArgs?: string[];
}

export interface AutostartStatus {
  enabled: boolean;
  platform: string;
  /** Absolute path of the OS autostart entry file. */
  entryPath: string;
  execPath: string;
  /** True when an entry file exists but points at a different exec path. */
  stale: boolean;
  supported: boolean;
}

function isSupported(platform: string): platform is AutostartPlatform {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32';
}

/**
 * Absolute path of the autostart entry file for a platform/home pair.
 * Pure: every environment influence arrives via deps (the manager's
 * constructor is the one place that reads process.env). An explicitly
 * supplied homeDir is authoritative — a stray XDG_CONFIG_HOME in the
 * environment must not redirect an entry into a different home.
 */
export function autostartEntryPath(deps: {
  platform: string;
  homeDir: string;
  appDataDir?: string;
  xdgConfigHome?: string;
}): string {
  const { platform, homeDir } = deps;
  if (platform === 'linux') {
    const xdgConfig = deps.xdgConfigHome && path.isAbsolute(deps.xdgConfigHome)
      ? deps.xdgConfigHome
      : path.join(homeDir, '.config');
    return path.join(xdgConfig, 'autostart', 'kriyadot.desktop');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'LaunchAgents', `${AUTOSTART_MAC_LABEL}.plist`);
  }
  if (platform === 'win32') {
    const appData = deps.appDataDir ?? path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'KriyaDot.cmd');
  }
  return path.join(homeDir, '.config', 'autostart', 'kriyadot.desktop');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Quote one path for a .desktop Exec= line (double quotes, \" \\ escapes). */
function desktopQuote(p: string): string {
  if (!/[\s"$`\\]/.test(p)) return p;
  return `"${p.replace(/(["$`\\])/g, '\\$1')}"`;
}

/** Render the autostart entry file contents for a platform. Pure. */
export function renderAutostartEntry(deps: {
  platform: string;
  execPath: string;
  execArgs?: string[];
}): string {
  const { platform, execPath } = deps;
  const args = deps.execArgs ?? [];
  if (platform === 'darwin') {
    const programArgs = [execPath, ...args]
      .map((a) => `    <string>${escapeXml(a)}</string>`)
      .join('\n');
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${AUTOSTART_MAC_LABEL}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      programArgs,
      '  </array>',
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
  }
  if (platform === 'win32') {
    const cmdline = [`"${execPath}"`, ...args.map((a) => `"${a}"`)].join(' ');
    return [
      '@echo off',
      `rem KriyaDot — open at login (managed by KriyaDot; delete this file to disable)`,
      `start "" ${cmdline}`,
      '',
    ].join('\r\n');
  }
  // Linux XDG desktop entry.
  const exec = [desktopQuote(execPath), ...args.map(desktopQuote)].join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${AUTOSTART_APP_NAME}`,
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'Comment=Open KriyaDot at login',
    '',
  ].join('\n');
}

/**
 * File-based autostart manager for one OS/home/exec combination. All
 * operations are synchronous file I/O on a single small entry file.
 */
export class AutostartManager {
  private readonly platform: string;
  private readonly homeDir: string;
  private readonly appDataDir?: string;
  private readonly xdgConfigHome?: string;
  private readonly execPath: string;
  private readonly execArgs: string[];

  constructor(deps: AutostartDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.homeDir = deps.homeDir ?? os.homedir();
    this.appDataDir = deps.appDataDir ?? process.env.APPDATA;
    // $XDG_CONFIG_HOME is honored only for the ambient (default) home.
    // When a caller pins homeDir explicitly, that home is authoritative
    // and the environment must not redirect the entry elsewhere.
    this.xdgConfigHome = deps.xdgConfigHome ?? (deps.homeDir === undefined ? process.env.XDG_CONFIG_HOME : undefined);
    this.execPath = deps.execPath ?? process.env.KRIYADOT_EXEC_PATH ?? process.execPath;
    this.execArgs = deps.execArgs ?? [];
  }

  get entryPath(): string {
    return autostartEntryPath({
      platform: this.platform,
      homeDir: this.homeDir,
      appDataDir: this.appDataDir,
      xdgConfigHome: this.xdgConfigHome,
    });
  }

  status(): AutostartStatus {
    const entryPath = this.entryPath;
    const supported = isSupported(this.platform);
    let exists = false;
    let pointsHere = false;
    try {
      const content = fs.readFileSync(entryPath, 'utf8');
      exists = true;
      pointsHere = content.includes(this.execPath);
    } catch {
      exists = false;
    }
    return {
      enabled: supported && exists && pointsHere,
      platform: this.platform,
      entryPath,
      execPath: this.execPath,
      stale: exists && !pointsHere,
      supported,
    };
  }

  /** Write (or rewrite) the OS autostart entry. Returns the new status. */
  enable(): AutostartStatus {
    if (!isSupported(this.platform)) {
      throw new Error(`Open-at-login is not supported on platform "${this.platform}".`);
    }
    const entryPath = this.entryPath;
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    const content = renderAutostartEntry({
      platform: this.platform,
      execPath: this.execPath,
      execArgs: this.execArgs,
    });
    const tmp = `${entryPath}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, entryPath);
    return this.status();
  }

  /** Remove the OS autostart entry (no-op when absent). Returns status. */
  disable(): AutostartStatus {
    try {
      fs.unlinkSync(this.entryPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return this.status();
  }

  /** Apply a desired enabled state. Returns the resulting status. */
  setEnabled(enabled: boolean): AutostartStatus {
    return enabled ? this.enable() : this.disable();
  }
}
