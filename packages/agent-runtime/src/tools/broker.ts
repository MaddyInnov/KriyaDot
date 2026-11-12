// SPDX-License-Identifier: Apache-2.0
// Brokered-action tool (Timon parity programme, item A12).
//
//   broker_action — ask the app to perform one catalogue action on a
//                   brokered identity (GitHub first) with the app-held
//                   credential. [MUTATING → governance evaluates first]
//
// Trust model (never weakened — same family as type_login):
//   - The bot names an identity, a catalogue action, and that action's
//     arguments. There is NO argument for a token, URL, host, or header:
//     the credential is resolved server-side inside the broker and used
//     only as the outbound Authorization header.
//   - The result returned here is the broker's shaped action result —
//     ids, numbers, URLs of created resources — never the credential.
//   - Refusals (no grant, denied grant, unconnected identity, steering
//     attempt) come back as { ok: false, code, error } so the bot can
//     explain and continue; error text is built by the broker from fixed
//     templates and can never contain the credential value.
//   - Per-run grants are raised by the broker through the host approval
//     flow on first use in a run; standing grants are the user's
//     Settings choice only. Governance still evaluates this tool before
//     the handler runs (policy ceiling unchanged).

import type { ToolContext, ToolDefinition } from '../types.js';
import {
  BROKER_ACTIONS,
  BrokerError,
  type SecretsBroker,
} from '../secrets-broker.js';

export const BROKER_TOOL_NAME = 'broker_action';

export interface BrokerToolOptions {
  broker: SecretsBroker;
}

export function createBrokerTool(opts: BrokerToolOptions): ToolDefinition {
  const catalogue = BROKER_ACTIONS.map(
    (a) => `${a.name} (${a.actionClass}${a.mutating ? ', mutating' : ''}) — ${a.description}`,
  ).join(' ');
  return {
    name: BROKER_TOOL_NAME,
    mutating: true,
    description:
      'Perform an action on a connected external identity (GitHub) using the credential the APP ' +
      'holds in its vault. You never see or handle the credential: name an action from the ' +
      'catalogue and pass only that action’s arguments. The first action of a class in a run ' +
      'asks the user for a per-run grant (unless they already gave a standing grant in Settings); ' +
      'a denial means no call is made. Calls only ever go to the identity’s canonical API host. ' +
      `Catalogue: ${catalogue}`,
    parameters: {
      type: 'object',
      properties: {
        identity: {
          type: 'string',
          enum: ['github'],
          description: 'The brokered identity to act as. Only "github" is supported today.',
        },
        action: {
          type: 'string',
          enum: BROKER_ACTIONS.map((a) => a.name),
          description: 'The catalogue action to perform, e.g. "github.create_issue".',
        },
        args: {
          type: 'object',
          description:
            'Arguments for the action: owner/repo for repository actions; title (+ optional body) ' +
            'for github.create_issue; number + body for github.comment; optional state/perPage for ' +
            'list actions. Never include tokens, URLs, hosts, or headers — they are rejected.',
          additionalProperties: true,
        },
      },
      required: ['identity', 'action'],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext) => {
      const identity = typeof args['identity'] === 'string' ? args['identity'] : '';
      const action = typeof args['action'] === 'string' ? args['action'] : '';
      const rawArgs = args['args'];
      const actionArgs =
        rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      try {
        const out = await opts.broker.execute({
          botId: ctx.botId,
          sessionId: ctx.sessionId,
          identity,
          action,
          args: actionArgs,
        });
        return out;
      } catch (err) {
        if (err instanceof BrokerError) {
          return { ok: false, code: err.code, error: err.message, identity, action };
        }
        // Unexpected failure: fixed message only — never interpolate an
        // unknown error whose text is not ours to vouch for.
        return {
          ok: false,
          code: 'broker_failure',
          error: 'the broker could not complete this action',
          identity,
          action,
        };
      }
    },
  };
}

/**
 * Register broker_action into a tool registry. Throws on name collision,
 * mirroring registerTypeLoginTool.
 */
export function registerBrokerTool(
  registry: Map<string, ToolDefinition>,
  opts: BrokerToolOptions,
): void {
  const tool = createBrokerTool(opts);
  if (registry.has(tool.name)) {
    throw new Error(`tool name collision: "${tool.name}" is already registered`);
  }
  registry.set(tool.name, tool);
}
