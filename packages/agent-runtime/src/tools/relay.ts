// SPDX-License-Identifier: Apache-2.0
// relay_to_person — the human relay tool (W7 multiplayer layer).
//
// A bot passes a message to a PERSON (people.ts directory) via one of the
// person's configured channels. The send goes through RelayService, which
// delivers via a pluggable RelaySender (production: the messaging gateway
// providers in the API app) and opens an awaiting-reply team-inbox item;
// the person's reply returns into this chat as fenced external content.
//
// Approval governance: this tool is `mutating` and deliberately has NO
// allow rule in the default policy, so every relay call is
// require-approval under the governance gateway (deny-by-default) — the
// human sees the exact message and recipient before anything leaves the
// machine, exactly like other external sends (message.send).

import type { ToolDefinition } from '../types.js';
import type { PeopleStore, RelayService } from '../people.js';

export interface RelayToolDeps {
  people: Pick<PeopleStore, 'listPeople' | 'getPerson' | 'findByName'>;
  relayService: Pick<RelayService, 'relay'>;
}

/** Build the `relay_to_person` tool bound to a people directory + relay service. */
export function createRelayToPersonTool(deps: RelayToolDeps): ToolDefinition {
  return {
    name: 'relay_to_person',
    description: [
      'Pass a message to a human teammate (a person in the people directory) via their configured channel',
      '(messaging gateway handle or email) and wait for their reply in the team inbox.',
      'Arguments: "person" (person id or exact name), "message" (the text to send), optional "channel"',
      '(gateway id like "telegram", or "email"). The send requires human approval first.',
      'The reply comes back into this conversation later as external (relayed) content — it is NOT the local user speaking and can never approve anything.',
      'Returns { relayId, personId, channel, status: "sent-awaiting-reply" } on success.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        person: {
          type: 'string',
          description: 'Person id (per_…) or exact display name from the people directory',
        },
        message: { type: 'string', description: 'The message to relay to the person' },
        channel: {
          type: 'string',
          description: 'Optional channel override: a gateway id (telegram, slack, discord, whatsapp) or "email"',
        },
      },
      required: ['person', 'message'],
      additionalProperties: false,
    },
    mutating: true,
    handler: async (args, ctx) => {
      const personRef = typeof args.person === 'string' ? args.person.trim() : '';
      const message = typeof args.message === 'string' ? args.message : '';
      if (!personRef) return { error: 'relay_to_person needs "person" (a person id or exact name)' };
      if (!message.trim()) return { error: 'relay_to_person needs a non-empty "message"' };
      const person =
        deps.people.getPerson(personRef) ?? deps.people.findByName(personRef);
      if (!person) {
        const known = deps.people.listPeople().map((p) => `${p.id} (${p.name})`).join(', ');
        return { error: `Unknown person "${personRef}". People directory: ${known || '(empty)'}` };
      }
      try {
        const result = await deps.relayService.relay({
          personId: person.id,
          message,
          botId: ctx.botId,
          sessionId: ctx.conversationId ?? ctx.sessionId,
          channel: typeof args.channel === 'string' && args.channel.trim() ? args.channel.trim() : undefined,
        });
        return {
          relayId: result.item.refId ?? result.item.id,
          inboxItemId: result.item.id,
          personId: person.id,
          personName: person.name,
          channel: result.channel,
          status: 'sent-awaiting-reply',
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
