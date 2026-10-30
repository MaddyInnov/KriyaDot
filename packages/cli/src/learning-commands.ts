// SPDX-License-Identifier: Apache-2.0
// `kriyadot learning …` — the learning inspector + evolution surface
// (#83 / #86, CLI side).
//
// Lessons are the per-bot memory atoms the API exposes with provenance:
//   learning list   [--bot b] [--glob '*pat*'] [--limit n]
//       GET    /memory/atoms?botId=b&limit=n   (glob filters client-side
//                                               over fact + id, and is
//                                               also passed as the
//                                               server-side `pattern`)
//   learning show <id>   --bot b     GET    /memory/atoms/<id>?botId=b
//   learning delete <id> --bot b     DELETE /memory/atoms/<id>?botId=b
//   learning clear       --bot b --yes
//                                    DELETE /memory/atoms?botId=b
//
// Evolution covers the learned routing rules (shadow → active → retired):
//   learning evolution list
//       GET    /routing/rules
//   learning evolution approve <id>  POST /routing/rules/<id>/promote
//   learning evolution reject <id>   POST /routing/rules/<id>/reject
//       (the distinct reject endpoint: retires a SHADOW candidate without
//       it ever having been promoted — rollback retires an active rule)
//   learning evolution rollback <id> POST /routing/rules/<id>/rollback
import { flagBool, flagString } from './args.js';
import type { ParsedArgs } from './args.js';
import type { CommandDeps } from './commands.js';
import { EXIT_ERROR, EXIT_USAGE } from './exits.js';

export interface LearningAtom {
  id: string;
  fact: string;
  category?: string;
  confidence?: number;
  tier?: string;
  source?: string;
  createdAt?: number;
  [key: string]: unknown;
}

export interface RoutingRule {
  id: string;
  status?: string;
  when?: unknown;
  then?: unknown;
  [key: string]: unknown;
}

function out(deps: CommandDeps, s: string): void {
  deps.stdout.write(s);
}
function err(deps: CommandDeps, s: string): void {
  deps.stderr.write(s);
}

/** Convert a shell-style glob (* and ?) to an anchored, case-insensitive RegExp. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** True when an atom matches a glob against its fact or id. No glob = match. */
export function atomMatchesGlob(atom: LearningAtom, glob: string | undefined): boolean {
  if (!glob) return true;
  const re = globToRegExp(glob);
  return re.test(atom.fact) || re.test(atom.id);
}

function requireBot(deps: CommandDeps, p: ParsedArgs): string | null {
  const bot = flagString(p.flags, 'bot');
  if (!bot) {
    err(deps, 'kriyadot learning: --bot <id> is required (lessons are stored per bot)\n');
    return null;
  }
  return bot;
}

async function listLessons(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const bot = requireBot(deps, p);
  if (!bot) return EXIT_USAGE;
  const glob = flagString(p.flags, 'glob') ?? flagString(p.flags, 'pattern');
  const limitRaw = flagString(p.flags, 'limit');
  const limit = limitRaw !== undefined ? Number(limitRaw) : 200;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    err(deps, 'kriyadot learning list: --limit must be a positive integer\n');
    return EXIT_USAGE;
  }
  const params = new URLSearchParams({ botId: bot, limit: String(limit) });
  if (glob) params.set('pattern', glob);
  const res = await deps.api.request<{ ok: boolean; atoms: LearningAtom[] }>(`/memory/atoms?${params.toString()}`);
  const atoms = (res.atoms ?? []).filter((a) => atomMatchesGlob(a, glob));
  if (p.global.format === 'json') {
    out(deps, `${JSON.stringify(atoms, null, 2)}\n`);
    return 0;
  }
  if (atoms.length === 0) {
    out(deps, glob ? `No lessons for bot ${bot} match "${glob}".\n` : `No lessons stored for bot ${bot}.\n`);
    return 0;
  }
  for (const a of atoms) {
    const when = typeof a.createdAt === 'number' ? new Date(a.createdAt).toISOString() : '—';
    out(deps, `${a.id}\t${a.category ?? 'fact'}${a.tier ? `/${a.tier}` : ''}\t${when}\t${a.fact}\n`);
  }
  return 0;
}

async function showLesson(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const bot = requireBot(deps, p);
  if (!bot) return EXIT_USAGE;
  const id = p.positional[0];
  if (!id) {
    err(deps, 'Usage: kriyadot learning show <id> --bot <id>\n');
    return EXIT_USAGE;
  }
  const res = await deps.api.request<{ ok: boolean; atom: LearningAtom }>(
    `/memory/atoms/${encodeURIComponent(id)}?botId=${encodeURIComponent(bot)}`,
  );
  if (p.global.format === 'json') {
    out(deps, `${JSON.stringify(res.atom, null, 2)}\n`);
    return 0;
  }
  const a = res.atom;
  out(deps, `${a.id}  ${a.category ?? 'fact'}${a.tier ? `/${a.tier}` : ''}${typeof a.confidence === 'number' ? `  confidence ${a.confidence}` : ''}\n`);
  out(deps, `${a.fact}\n`);
  if (a.source) out(deps, `source: ${typeof a.source === 'string' ? a.source : JSON.stringify(a.source)}\n`);
  return 0;
}

async function deleteLesson(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const bot = requireBot(deps, p);
  if (!bot) return EXIT_USAGE;
  const id = p.positional[0];
  if (!id) {
    err(deps, 'Usage: kriyadot learning delete <id> --bot <id>\n');
    return EXIT_USAGE;
  }
  await deps.api.request(`/memory/atoms/${encodeURIComponent(id)}?botId=${encodeURIComponent(bot)}`, { method: 'DELETE' });
  out(deps, p.global.format === 'json' ? `${JSON.stringify({ ok: true, deleted: id })}\n` : `Deleted lesson ${id} for bot ${bot}.\n`);
  return 0;
}

async function clearLessons(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const bot = requireBot(deps, p);
  if (!bot) return EXIT_USAGE;
  if (!flagBool(p.flags, 'yes')) {
    err(deps, `kriyadot learning clear: refusing to forget ALL lessons for bot ${bot} without --yes\n`);
    return EXIT_USAGE;
  }
  const res = await deps.api.request<{ ok: boolean; cleared: number }>(`/memory/atoms?botId=${encodeURIComponent(bot)}`, {
    method: 'DELETE',
  });
  out(deps, p.global.format === 'json' ? `${JSON.stringify(res)}\n` : `Cleared ${res.cleared} lesson(s) for bot ${bot}.\n`);
  return 0;
}

async function evolution(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const [action, id] = p.positional;
  if (!action || action === 'list') {
    const res = await deps.api.request<{ ok: boolean; rules: RoutingRule[] }>('/routing/rules');
    if (p.global.format === 'json') {
      out(deps, `${JSON.stringify(res.rules, null, 2)}\n`);
      return 0;
    }
    if (!res.rules?.length) {
      out(deps, 'No learned routing rules yet.\n');
      return 0;
    }
    for (const r of res.rules) out(deps, `${r.id}\t${r.status ?? 'shadow'}\t${JSON.stringify(r.then ?? '')}\n`);
    return 0;
  }
  const endpoints: Record<string, string> = {
    approve: 'promote',
    reject: 'reject',
    rollback: 'rollback',
  };
  const endpoint = endpoints[action];
  if (!endpoint || !id) {
    err(deps, 'Usage: kriyadot learning evolution <list|approve|reject|rollback> [id]\n');
    return EXIT_USAGE;
  }
  await deps.api.request(`/routing/rules/${encodeURIComponent(id)}/${endpoint}`, { method: 'POST' });
  out(
    deps,
    p.global.format === 'json'
      ? `${JSON.stringify({ ok: true, action, id })}\n`
      : `Evolution ${action}: rule ${id} ${action === 'approve' ? 'promoted' : action === 'reject' ? 'rejected' : 'rolled back'}.\n`,
  );
  return 0;
}

export const LEARNING_USAGE =
  'Usage: kriyadot learning <list|show|delete|clear|evolution> … — run "kriyadot learning" with no subcommand for details.';

const LEARNING_HELP = [
  'kriyadot learning — per-bot lessons (memory atoms) + routing-rule evolution',
  '',
  '  learning list [--bot b] [--glob <pat>] [--limit n]   list lessons (glob over fact/id)',
  '  learning show <id> --bot b                           one lesson with provenance',
  '  learning delete <id> --bot b                         forget one lesson',
  '  learning clear --bot b --yes                         forget ALL lessons for a bot',
  '  learning evolution list                              learned routing rules + status',
  '  learning evolution approve <id>                      promote a shadow rule live',
  '  learning evolution reject <id>                       reject a shadow rule (never promoted)',
  '  learning evolution rollback <id>                     retire an active rule',
  '',
].join('\n');

/** Dispatch a parsed `learning` invocation. Returns the process exit code. */
export async function runLearningCommand(p: ParsedArgs, deps: CommandDeps): Promise<number> {
  try {
    switch (p.subcommand) {
      case '':
        out(deps, `${LEARNING_HELP}\n`);
        return 0;
      case 'list':
        return await listLessons(deps, p);
      case 'show':
        return await showLesson(deps, p);
      case 'delete':
        return await deleteLesson(deps, p);
      case 'clear':
        return await clearLessons(deps, p);
      case 'evolution':
        return await evolution(deps, p);
      default:
        err(deps, `${LEARNING_USAGE}\n`);
        return EXIT_USAGE;
    }
  } catch (e) {
    err(deps, `kriyadot: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_ERROR;
  }
}
