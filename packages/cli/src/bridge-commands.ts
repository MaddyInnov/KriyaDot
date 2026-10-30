// SPDX-License-Identifier: Apache-2.0
// `kriyadot bridge` — federation / instance-to-instance linking commands
// (Octop parity §2.8). Talks to the local instance's /api/federation
// routes via the CLI's existing KriyaDotApi client (deps.api.request).
//
//   kriyadot bridge invite [--expose botA,botB]   create an invite payload
//   kriyadot bridge link <invitePayload> [--expose botA,botB]
//                                                 accept a remote invite
//                                                 (links this instance to
//                                                 the inviter; audit-logged
//                                                 server-side as a trust action)
//   kriyadot bridge list | peers                  linked peers + policies
//   kriyadot bridge experts <peerId>              the peer's exposed experts
//   kriyadot bridge chat <peerId> <botId> <msg…>  one turn on the peer
//   kriyadot bridge unlink <peerId>               unlink a peer
//
// HOST WIRING (#104, done): commands.ts dispatches `case 'bridge'` to
// runBridgeCommand, args.ts validateCommand allows the subcommand set,
// and help.ts + completion.ts cover the surface. registerBridgeCommands
// remains for hosts that dispatch from a registry map instead.

import { flagString } from './args.js';
import type { ParsedArgs } from './args.js';
import type { CommandDeps } from './commands.js';
import { EXIT_ERROR, EXIT_USAGE } from './exits.js';

export interface FederationPeer {
  peerId: string;
  name: string;
  url: string;
  status: string;
  policy: { exposedBotIds: string[]; capabilities: string[]; rateCapPerMinute: number };
}

export interface FederationExpert {
  id: string;
  name: string;
  description: string;
}

type Api = CommandDeps['api'];

function out(deps: CommandDeps, s: string): void {
  deps.stdout.write(s);
}
function err(deps: CommandDeps, s: string): void {
  deps.stderr.write(s);
}

function exposeList(p: ParsedArgs): string[] {
  const raw = flagString(p.flags, 'expose');
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

async function bridgeInvite(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const exposed = exposeList(p);
  const res = await deps.api.request<{ ok: boolean; payload: string; invite: { inviteId: string; expiresAt: number } }>(
    '/federation/invites',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policyForPeer: { exposedBotIds: exposed, capabilities: ['chat'] } }),
    },
  );
  if (p.global.format === 'json') {
    out(deps, `${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }
  out(deps, `Invite ${res.invite.inviteId} (expires ${new Date(res.invite.expiresAt).toISOString()})\n`);
  out(deps, `Share this payload with the other instance — they run: kriyadot bridge link <payload>\n`);
  out(deps, `${res.payload}\n`);
  return 0;
}

async function bridgeLink(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const payload = p.positional[0];
  if (!payload) {
    err(deps, 'Usage: kriyadot bridge link <invitePayload> [--expose botA,botB]\n');
    return EXIT_USAGE;
  }
  const exposed = exposeList(p);
  const res = await deps.api.request<{ ok: boolean; peer: FederationPeer }>('/federation/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, policy: { exposedBotIds: exposed, capabilities: ['chat'] } }),
  });
  if (p.global.format === 'json') {
    out(deps, `${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }
  out(deps, `Linked to ${res.peer.name} (${res.peer.peerId}) at ${res.peer.url} — status ${res.peer.status}.\n`);
  out(deps, `Exposed to them: ${exposed.length ? exposed.join(', ') : '(no bots)'}\n`);
  return 0;
}

async function bridgeList(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const res = await deps.api.request<{ ok: boolean; peers: FederationPeer[] }>('/federation/peers');
  if (p.global.format === 'json') {
    out(deps, `${JSON.stringify(res.peers, null, 2)}\n`);
    return 0;
  }
  if (res.peers.length === 0) {
    out(deps, 'No linked peers. Create an invite with "kriyadot bridge invite" or accept one with "kriyadot bridge link".\n');
    return 0;
  }
  for (const peer of res.peers) {
    out(
      deps,
      `${peer.peerId}  ${peer.name}  ${peer.status}  ${peer.url}\n` +
        `  exposed: ${peer.policy.exposedBotIds.join(', ') || '(none)'} · capabilities: ${peer.policy.capabilities.join(', ')} · cap: ${peer.policy.rateCapPerMinute}/min\n`,
    );
  }
  return 0;
}

async function bridgeExperts(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const peerId = p.positional[0];
  if (!peerId) {
    err(deps, 'Usage: kriyadot bridge experts <peerId>\n');
    return EXIT_USAGE;
  }
  const res = await deps.api.request<{ ok: boolean; experts: FederationExpert[] }>(
    `/federation/peers/${encodeURIComponent(peerId)}/experts`,
  );
  if (p.global.format === 'json') {
    out(deps, `${JSON.stringify(res.experts, null, 2)}\n`);
    return 0;
  }
  if (res.experts.length === 0) {
    out(deps, 'That peer exposes no experts to this instance.\n');
    return 0;
  }
  for (const e of res.experts) out(deps, `${e.id}  ${e.name} — ${e.description}\n`);
  return 0;
}

async function bridgeChat(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const [peerId, botId, ...words] = p.positional;
  const message = flagString(p.flags, 'message') ?? (words.length ? words.join(' ') : null);
  if (!peerId || !botId || !message) {
    err(deps, 'Usage: kriyadot bridge chat <peerId> <botId> <message…>\n');
    return EXIT_USAGE;
  }
  const res = await deps.api.request<{ ok: boolean; text: string; stub: { remoteSessionId: string } }>(
    `/federation/peers/${encodeURIComponent(peerId)}/experts/${encodeURIComponent(botId)}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    },
  );
  if (p.global.format === 'json') {
    out(deps, `${JSON.stringify(res, null, 2)}\n`);
    return 0;
  }
  out(deps, `${res.text}\n`);
  return 0;
}

async function bridgeUnlink(deps: CommandDeps, p: ParsedArgs): Promise<number> {
  const peerId = p.positional[0];
  if (!peerId) {
    err(deps, 'Usage: kriyadot bridge unlink <peerId>\n');
    return EXIT_USAGE;
  }
  await deps.api.request(`/federation/peers/${encodeURIComponent(peerId)}`, { method: 'DELETE' });
  out(deps, `Unlinked ${peerId}. Its signed requests are now refused and it no longer appears in "bridge list".\n`);
  return 0;
}

export const BRIDGE_USAGE =
  'Usage: kriyadot bridge <invite|link|list|peers|experts|chat|unlink> … — run "kriyadot bridge" with no subcommand for details.';

const BRIDGE_HELP = [
  'kriyadot bridge — link this KriyaDot instance to another KriyaDot instance',
  '',
  '  bridge invite [--expose a,b]            create an invite payload to share',
  '  bridge link <payload> [--expose a,b]    accept an invite (trust action, audit-logged)',
  '  bridge list | peers                     linked peers and tunnel policies',
  '  bridge experts <peerId>                 experts the peer exposes to you',
  '  bridge chat <peerId> <botId> <msg…>     run one turn on the peer (executes there)',
  '  bridge unlink <peerId>                  unlink a peer (stops all access)',
  '',
].join('\n');

/** Dispatch a parsed `bridge` invocation. Returns the process exit code. */
export async function runBridgeCommand(p: ParsedArgs, deps: CommandDeps): Promise<number> {
  try {
    switch (p.subcommand) {
      case 'invite':
        return await bridgeInvite(deps, p);
      case 'link':
        return await bridgeLink(deps, p);
      case 'list':
      case 'peers':
      case '':
        if (p.subcommand === '') {
          out(deps, `${BRIDGE_HELP}\n`);
          return 0;
        }
        return await bridgeList(deps, p);
      case 'experts':
        return await bridgeExperts(deps, p);
      case 'chat':
        return await bridgeChat(deps, p);
      case 'unlink':
        return await bridgeUnlink(deps, p);
      default:
        err(deps, `${BRIDGE_USAGE}\n`);
        return EXIT_USAGE;
    }
  } catch (e) {
    err(deps, `kriyadot: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT_ERROR;
  }
}

export type BridgeCommandHandler = (p: ParsedArgs, deps: CommandDeps) => Promise<number>;

/**
 * Registration function for hosts that dispatch commands from a registry
 * map: registers `bridge` → runBridgeCommand. (commands.ts can equally add
 * a `case 'bridge'` to its switch — see the header comment.)
 */
export function registerBridgeCommands(registry: Map<string, BridgeCommandHandler>): void {
  registry.set('bridge', runBridgeCommand);
}

/** Type re-export so hosts can type peer-shaped API responses. */
export type { Api as BridgeApi };
