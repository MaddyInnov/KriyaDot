// SPDX-License-Identifier: Apache-2.0
// Published bots ("expert publishing/sharing") — deployment-local templates.
//
// A user publishes one of their bots: we snapshot { config, persona, skill
// refs } into <dataDir>/published-bots.json with org + audience metadata
// (visibility org|groups|private + allowedGroupIds, honoring the tenancy
// audience model from @mvp/tenancy). Other users in the deployment can list
// what they may see and install a COPY (new bot id, appended to the roster
// imports so it survives restarts). Unpublish removes the listing; installed
// copies are independent and survive.
//
// Visibility enforcement: callers are x-user-id + x-org-id headers; access
// is decided by canUserAccessResource() against the publisher's org when
// tenancy data is available, falling back to org match + visibility rules.

import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BotConfig } from '@mvp/agent-runtime';

export interface PublishedBot {
  id: string;
  botId: string;
  name: string;
  description: string;
  orgId: string;
  publishedBy: string;
  visibility: 'org' | 'groups' | 'private';
  allowedGroupIds: string[];
  snapshot: BotConfig;
  createdAt: number;
}

export class PublishedBotStore {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = join(dataDir, 'published-bots.json');
  }

  private read(): PublishedBot[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as PublishedBot[]) : [];
    } catch {
      return [];
    }
  }

  private write(rows: PublishedBot[]): void {
    fs.mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  publish(input: {
    bot: BotConfig;
    orgId: string;
    publishedBy: string;
    visibility?: PublishedBot['visibility'];
    allowedGroupIds?: string[];
  }): PublishedBot {
    const rows = this.read().filter((r) => !(r.botId === input.bot.id && r.orgId === input.orgId));
    const entry: PublishedBot = {
      id: `pub_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      botId: input.bot.id,
      name: input.bot.name,
      description: input.bot.description,
      orgId: input.orgId,
      publishedBy: input.publishedBy,
      visibility: input.visibility ?? 'org',
      allowedGroupIds: input.allowedGroupIds ?? [],
      snapshot: JSON.parse(JSON.stringify(input.bot)) as BotConfig,
      createdAt: Date.now(),
    };
    rows.push(entry);
    this.write(rows);
    return entry;
  }

  get(id: string): PublishedBot | undefined {
    return this.read().find((r) => r.id === id);
  }

  list(): PublishedBot[] {
    return this.read();
  }

  unpublish(id: string): boolean {
    const rows = this.read();
    const next = rows.filter((r) => r.id !== id);
    if (next.length === rows.length) return false;
    this.write(next);
    return true;
  }
}

/** Audience check for a published entry, given the viewer's org + groups. */
export function canViewPublished(
  entry: PublishedBot,
  viewer: { userId: string; orgId: string; groupIds: string[] },
): boolean {
  if (entry.publishedBy === viewer.userId) return true;
  if (entry.orgId !== viewer.orgId) return false;
  if (entry.visibility === 'org') return true;
  if (entry.visibility === 'private') return false;
  return viewer.groupIds.some((g) => entry.allowedGroupIds.includes(g));
}

/** Build an installable copy: fresh id (suffix when the base id is taken). */
export function makeInstalledCopy(snapshot: BotConfig, existingIds: Set<string>, installerName?: string): BotConfig {
  let id = snapshot.id;
  if (existingIds.has(id)) {
    let n = 2;
    while (existingIds.has(`${snapshot.id}-copy-${n}`)) n += 1;
    id = `${snapshot.id}-copy-${n}`;
  }
  return {
    ...JSON.parse(JSON.stringify(snapshot)),
    id,
    name: installerName ?? snapshot.name,
  } as BotConfig;
}
