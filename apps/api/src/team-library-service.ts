// SPDX-License-Identifier: Apache-2.0
// Team library instantiation: turn a browsable team-library entry (whose
// payload is a kriyadot.team manifest, see packages/agent-runtime
// team-manifest.ts) into LIVE bots + a team in one operation.
//
// All side effects go through injected constructor deps — createBot,
// createTeam, audit — so the host wires its normal roster/team stores
// (with their approval + audit injection points) and tests stub them.
// Bots that already exist are skipped (never overwritten) and reported;
// the team is created referencing coordinator + member bot ids from the
// manifest, with the manifest's coordination rules carried over.

import { validateTeamManifest, type BotConfig, type Team, type TeamManifest } from '@mvp/agent-runtime';

export interface TeamLibraryEntryLike {
  id: string;
  kind: string;
  name: string;
  payload: unknown;
}

export interface TeamLibraryServiceDeps {
  /** Fetch a library entry by id (OrgLibraryStore.get in production). */
  getEntry: (entryId: string) => TeamLibraryEntryLike | undefined;
  /** True when a bot id is already taken (skip, never overwrite). */
  botExists?: (botId: string) => boolean;
  /** Create one live bot (host: roster import + live roster push). */
  createBot: (bot: BotConfig) => void | Promise<void>;
  /** Create the team (host: TeamStore.createTeam). */
  createTeam: (input: {
    name: string;
    coordinatorBotId: string;
    memberBotIds: string[];
    delegationPolicy: TeamManifest['team']['coordinationRules']['delegationPolicy'];
    delegationPolicyOverrides: Record<string, TeamManifest['team']['coordinationRules']['delegationPolicy']>;
  }) => Team | Promise<Team>;
  audit?: (action: string, fields: { actor?: string; detail?: unknown }) => void;
}

export interface TeamInstantiationResult {
  entryId: string;
  team: Team;
  createdBotIds: string[];
  skippedBotIds: string[];
}

export class TeamLibraryError extends Error {}

export class TeamLibraryService {
  constructor(private readonly deps: TeamLibraryServiceDeps) {}

  /** Instantiate one library entry into live bots + team. */
  async instantiate(entryId: string, opts: { actor?: string } = {}): Promise<TeamInstantiationResult> {
    const entry = this.deps.getEntry(entryId);
    if (!entry) throw new TeamLibraryError(`Unknown team library entry: "${entryId}"`);
    if (entry.kind !== 'team') {
      throw new TeamLibraryError(`Library entry "${entryId}" is a ${entry.kind}, not a team.`);
    }
    const validation = validateTeamManifest(entry.payload);
    if (!validation.ok) {
      throw new TeamLibraryError(
        `Library entry "${entryId}" does not carry a valid team manifest: ${validation.errors.join('; ')}`,
      );
    }
    const manifest = validation.manifest;
    const { coordinator, members, coordinationRules } = manifest.team;

    const createdBotIds: string[] = [];
    const skippedBotIds: string[] = [];
    for (const bot of [coordinator, ...members]) {
      if (this.deps.botExists?.(bot.id)) {
        skippedBotIds.push(bot.id);
        continue;
      }
      await this.deps.createBot(bot);
      createdBotIds.push(bot.id);
    }

    const team = await this.deps.createTeam({
      name: manifest.team.name,
      coordinatorBotId: coordinator.id,
      memberBotIds: members.map((m) => m.id),
      delegationPolicy: coordinationRules.delegationPolicy,
      delegationPolicyOverrides: coordinationRules.delegationPolicyOverrides,
    });

    this.deps.audit?.('team_library.instantiated', {
      actor: opts.actor ?? 'user',
      detail: { entryId, teamId: team.id, teamName: team.name, createdBotIds, skippedBotIds },
    });
    return { entryId, team, createdBotIds, skippedBotIds };
  }
}
