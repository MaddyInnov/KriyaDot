// SPDX-License-Identifier: Apache-2.0
// `kriyadot tap` — marketplace tap authoring + distribution (#157/#103).
//
//   kriyadot tap init <dir> --kind <bot|workflow|capability|skill|tap>
//       [--id <id>] [--name <name>] [--description <text>]
//       [--creator <name>] [--category <c>] [--variant <v>] [--no-register]
//       Scaffold a package into <dir>/<id> via @mvp/marketplace
//       scaffoldPackage(), verify it with validatePackage(), and (unless
//       --no-register) register it with registerPackage() — entry packages
//       land in the local registry file, tap packages become a named
//       local channel in the channels file next to it.
//
//   kriyadot tap install <ref> [--overwrite]
//       Install every entry a tap publishes. <ref> is resolved with
//       resolveTapSource(): `channel:<name>`, `local:<path>`,
//       `github:<owner/repo[@branch]>`, a bare `owner/repo`, a
//       github.com URL, or a plain directory path. GitHub taps are
//       fetched with a real global-fetch TapFetcher; local taps and
//       local channels never touch the network. Standalone MCP-server
//       entries stay gated (they need the governance approval flow) and
//       are reported, never silently installed.
//
//   kriyadot tap validate <dir>
//       validatePackage() over a package dir (manifest.json or tap.json).
//
// Local marketplace state lives in the CLI config dir:
//   registry  <configDir>/marketplace-registry.json
//   channels  <configDir>/taps.json
//   installs  <configDir>/marketplace/installed/… (MarketplaceInstaller)
// Tests inject `TapRuntime` (paths + fetcher) so nothing here needs the
// network or the user's real config dir.
import { join } from 'node:path';
import {
  MarketplaceInstaller,
  installFromLocalTap,
  installFromTap,
  registerPackage,
  resolveTapSource,
  scaffoldPackage,
  validatePackage,
} from '@mvp/marketplace';
import type { ScaffoldKind, TapFetcher, TapInstallReport } from '@mvp/marketplace';
import { flagBool, flagString } from './args.js';
import type { ParsedArgs } from './args.js';
import type { CommandDeps } from './commands.js';
import { configDir } from './config.js';
import { EXIT_ERROR, EXIT_USAGE } from './exits.js';

/** Injectable runtime seams (tests pass temp paths + a fake fetcher). */
export interface TapRuntime {
  fetcher?: TapFetcher;
  registryPath?: string;
  channelsPath?: string;
  installDir?: string;
}

export const TAP_KINDS: readonly ScaffoldKind[] = ['bot', 'workflow', 'capability', 'skill', 'tap'];

export const TAP_USAGE =
  'Usage: kriyadot tap <init|install|validate> … — run "kriyadot tap" with no subcommand for details.';

const TAP_HELP = [
  'kriyadot tap — author and install marketplace packages from taps',
  '',
  '  tap init <dir> --kind <bot|workflow|capability|skill|tap> [--id <id>]',
  '      [--name <name>] [--description <text>] [--no-register]',
  '      Scaffold a package into <dir>/<id>, validate it, and register it',
  '      (entry packages → local registry; taps → a named local channel).',
  '  tap install <ref> [--overwrite]',
  '      Install a tap\'s entries. Ref forms: channel:<name>, local:<path>,',
  '      github:<owner/repo[@branch]>, owner/repo, a github.com URL, or a',
  '      directory path. Standalone MCP servers stay gated for approval.',
  '  tap validate <dir>              Validate a package dir (manifest/tap index)',
  '',
].join('\n');

/** Real TapFetcher over global fetch (production path; tests inject fakes). */
export const fetchTapText: TapFetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tap fetch failed: ${res.status} ${res.statusText} for ${url}`);
  return res.text();
};

function out(deps: CommandDeps, s: string): void {
  deps.stdout.write(s);
}
function err(deps: CommandDeps, s: string): void {
  deps.stderr.write(s);
}
function printJson(deps: CommandDeps, value: unknown): void {
  out(deps, `${JSON.stringify(value, null, 2)}\n`);
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleCase(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function tapInit(deps: CommandDeps, p: ParsedArgs, rt: Required<TapRuntime>): Promise<number> {
  const targetDir = p.positional[0];
  const kindRaw = flagString(p.flags, 'kind');
  if (!targetDir || !kindRaw) {
    err(deps, 'Usage: kriyadot tap init <dir> --kind <bot|workflow|capability|skill|tap> [--id <id>] [--name <name>] [--description <text>] [--no-register]\n');
    return EXIT_USAGE;
  }
  if (!(TAP_KINDS as readonly string[]).includes(kindRaw)) {
    err(deps, `kriyadot: --kind must be one of ${TAP_KINDS.join(', ')}, got "${kindRaw}"\n`);
    return EXIT_USAGE;
  }
  const kind = kindRaw as ScaffoldKind;
  const name = flagString(p.flags, 'name');
  const id = flagString(p.flags, 'id') ?? (name ? slugify(name) : undefined);
  if (!id) {
    err(deps, 'kriyadot: tap init needs --id <id> (or --name, from which the id is derived)\n');
    return EXIT_USAGE;
  }
  const displayName = name ?? titleCase(id);
  const description = flagString(p.flags, 'description') ?? `${displayName} — scaffolded by kriyadot tap init.`;

  const scaffolded = scaffoldPackage(targetDir, {
    kind,
    id,
    name: displayName,
    description,
    ...(flagString(p.flags, 'creator') ? { creator: flagString(p.flags, 'creator')! } : {}),
    ...(flagString(p.flags, 'category') ? { category: flagString(p.flags, 'category')! } : {}),
    ...(flagString(p.flags, 'variant') ? { variant: flagString(p.flags, 'variant')! } : {}),
  });
  const validation = validatePackage(scaffolded.dir);
  if (!validation.valid) {
    err(deps, `kriyadot: scaffolded package at ${scaffolded.dir} failed validation: ${validation.errors.join('; ')}\n`);
    return EXIT_ERROR;
  }
  const registered = flagBool(p.flags, 'no-register')
    ? null
    : registerPackage(scaffolded.dir, rt.registryPath, rt.channelsPath);

  if (p.global.format === 'json') {
    printJson(deps, {
      ok: true,
      dir: scaffolded.dir,
      manifestPath: scaffolded.manifestPath,
      ...(scaffolded.entry ? { entry: scaffolded.entry } : {}),
      validation,
      registered,
    });
    return 0;
  }
  out(deps, `Scaffolded ${kind} package "${id}" at ${scaffolded.dir}\n`);
  out(deps, `  manifest: ${scaffolded.manifestPath}\n`);
  if (registered) {
    out(
      deps,
      registered.registered === 'registry'
        ? `  registered in the local registry (${rt.registryPath}) as "${registered.id}"\n`
        : `  registered as tap channel "${registered.id}" (${rt.channelsPath})\n`,
    );
  } else {
    out(deps, '  not registered (--no-register)\n');
  }
  return 0;
}

function printInstallReport(deps: CommandDeps, report: TapInstallReport): void {
  out(deps, `Installed from ${report.source}:\n`);
  if (report.installed.length === 0 && report.installedMcp.length === 0) {
    out(deps, '  (nothing installed)\n');
  }
  for (const r of report.installed) out(deps, `  ✓ ${r.entryId} (${r.kind}) → ${r.installedPath}\n`);
  for (const r of report.installedMcp) out(deps, `  ✓ ${r.entryId} (mcp-server, disabled) → ${r.installedPath}\n`);
  for (const id of report.gatedMcp) {
    out(deps, `  ⏸ ${id} (mcp-server) gated — standalone MCP installs need the governance approval flow\n`);
  }
  for (const e of report.errors) err(deps, `  ✗ ${e}\n`);
}

async function tapInstall(deps: CommandDeps, p: ParsedArgs, rt: Required<TapRuntime>): Promise<number> {
  const ref = p.positional[0];
  if (!ref) {
    err(deps, 'Usage: kriyadot tap install <channel:name|local:path|github:owner/repo|owner/repo|path> [--overwrite]\n');
    return EXIT_USAGE;
  }
  const source = resolveTapSource(ref, rt.channelsPath);
  const installer = new MarketplaceInstaller(rt.installDir);
  const overwrite = flagBool(p.flags, 'overwrite');
  const report =
    source.type === 'local'
      ? installFromLocalTap(source.path, installer, { overwrite })
      : await installFromTap(source, {
          fetcher: rt.fetcher,
          installer,
          channelsPath: rt.channelsPath,
          overwrite,
        });
  if (p.global.format === 'json') {
    printJson(deps, { ok: report.errors.length === 0, report });
  } else {
    printInstallReport(deps, report);
  }
  return report.errors.length > 0 ? EXIT_ERROR : 0;
}

function tapValidate(deps: CommandDeps, p: ParsedArgs): number {
  const dir = p.positional[0];
  if (!dir) {
    err(deps, 'Usage: kriyadot tap validate <dir>\n');
    return EXIT_USAGE;
  }
  const validation = validatePackage(dir);
  if (p.global.format === 'json') {
    printJson(deps, validation);
  } else if (validation.valid) {
    out(deps, `Valid ${validation.kind ?? 'package'} package${validation.id ? ` "${validation.id}"` : ''} at ${dir}\n`);
  } else {
    err(deps, `Invalid package at ${dir}: ${validation.errors.join('; ')}\n`);
  }
  return validation.valid ? 0 : EXIT_ERROR;
}

/** Dispatch a parsed `tap` invocation. Returns the process exit code. */
export async function runTapCommand(
  p: ParsedArgs,
  deps: CommandDeps,
  runtime: TapRuntime = {},
): Promise<number> {
  const rt: Required<TapRuntime> = {
    fetcher: runtime.fetcher ?? fetchTapText,
    registryPath: runtime.registryPath ?? join(configDir(), 'marketplace-registry.json'),
    channelsPath: runtime.channelsPath ?? join(configDir(), 'taps.json'),
    installDir: runtime.installDir ?? join(configDir(), 'marketplace'),
  };
  try {
    switch (p.subcommand) {
      case '':
        out(deps, `${TAP_HELP}\n`);
        return 0;
      case 'init':
        return await tapInit(deps, p, rt);
      case 'install':
        return await tapInstall(deps, p, rt);
      case 'validate':
        return tapValidate(deps, p);
      default:
        err(deps, `${TAP_USAGE}\n`);
        return EXIT_USAGE;
    }
  } catch (e) {
    err(deps, `kriyadot: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_ERROR;
  }
}
