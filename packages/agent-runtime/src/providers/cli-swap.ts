// SPDX-License-Identifier: Apache-2.0
// Mid-job backend swap with transcript replay (Timon parity A1 §3).
//
// Why this module exists
// ----------------------
// When a subscription bridge backend dies mid-job on a quota/cooldown
// death, restarting the job from scratch loses the conversation. A1 moves
// the RUNNING conversation to a backup backend instead: the full
// transcript (system prompt, prior user/assistant turns, tool results) is
// replayed into the new backend's session, so the job continues with
// context. For API-style providers the runtime's message array IS the
// transcript; for native CLI drivers the flattened prompt is built from
// that same array and the backup CLI starts a FRESH native session (its
// session store is keyed per CLI, so a dead backend's session id is never
// resumed on a different backend) — the replay marker below tells the new
// backend, in-band, that this is a continuation, not a fresh request.
//
// SELECTION INTEGRITY IS HARD LAW (v0.2.2, selection-integrity.test.ts):
// - Automatic/default routing: a quota death swaps to the resolved auto
//   target (bot backup, else next eligible provider), exactly like W1
//   failover — unless that target is itself in cooldown, in which case
//   there is no swap and the cooled reason is surfaced.
// - EXPLICIT user selection: a swap may go ONLY to a backup the user
//   pre-declared for that selection (BotConfig.selectionBackup* or the
//   per-turn RunTurnOptions.selectionBackup* override). With no declared
//   backup the turn REFUSES LOUDLY (ProviderSelectionRefusedError, raised
//   by the caller) naming the quota death — and ZERO calls are made to
//   any other lane. A declared backup is used EXACTLY as declared: never
//   substituted, never widened to the catalog, and an explicit pick is
//   never silently downgraded to the free OVH lane (or any other lane).
//
// This module is the pure decision + replay construction; the runtime
// owns the actual provider calls and event emission.

import { getDefaultModel, getProviderPreset } from './catalog.js';
import type { BotConfig, ChatMessage } from '../types.js';
import type { CliBridgeId } from './cli-bridge.js';
import { DEFAULT_BRIDGE_ACCOUNT_ID } from './cli-usage.js';
import { resolveBridgeAccountId } from './bridge-accounts.js';

/** Agent-CLI driver ids that map onto subscription bridges. */
const AGENT_CLI_TO_BRIDGE: Record<string, CliBridgeId> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  // A2: the manifest-first bridges keep their own names as agent ids.
  copilot: 'copilot',
  grok: 'grok',
  kimi: 'kimi',
  pi: 'pi',
  hermes: 'hermes',
};

/**
 * The bridge behind a provider id, when it is one: catalog bridge presets
 * (claude-subscription / codex-subscription / opencode-subscription) and
 * agent-CLI provider ids (agent/claude-code/…, agent/codex/…).
 */
export function bridgeIdForProviderId(providerId: string): CliBridgeId | undefined {
  const preset = getProviderPreset(providerId);
  if (preset?.bridge) return preset.bridge;
  if (providerId.startsWith('agent/')) {
    const cliId = providerId.slice('agent/'.length).split('/')[0] ?? '';
    return AGENT_CLI_TO_BRIDGE[cliId];
  }
  return undefined;
}

/**
 * The account a bot's bridge turns run under. With a bridge id this is
 * the full A6 precedence (bot's per-bridge pick → legacy Claude profile
 * → user's default choice → machine default, resolved against the
 * process-wide bridge-account store); without one it keeps the A1
 * behaviour (the bot's Claude profile id, else 'default').
 */
export function bridgeAccountIdForBot(
  bot: Pick<BotConfig, 'accountProfile' | 'bridgeAccounts'>,
  bridgeId?: CliBridgeId,
): string {
  if (bridgeId) return resolveBridgeAccountId(bot, bridgeId);
  return bot.bridgeAccounts?.claude ?? bot.accountProfile ?? DEFAULT_BRIDGE_ACCOUNT_ID;
}

export interface SwapTarget {
  providerId: string;
  modelId: string;
  /**
   * A6: when the target is a SIBLING ACCOUNT of the same bridge (same
   * provider + model, different account), the account the retry runs
   * under. Absent for ordinary cross-provider targets.
   */
  accountId?: string;
}

/**
 * The backup the user pre-declared for an explicit selection, if any.
 * Per-turn options win over the bot's stored preference. The declared
 * provider is used exactly; the model falls back to the provider's
 * catalog default, then to the bot's model (a bridge backup usually
 * declares only the provider).
 */
export function declaredSelectionBackup(
  bot: Pick<BotConfig, 'selectionBackupProvider' | 'selectionBackupModel' | 'model'>,
  opts: { selectionBackupProvider?: string; selectionBackupModel?: string } = {},
): SwapTarget | null {
  const providerId = opts.selectionBackupProvider ?? bot.selectionBackupProvider;
  if (!providerId) return null;
  const modelId =
    opts.selectionBackupModel ?? bot.selectionBackupModel ?? getDefaultModel(providerId) ?? bot.model;
  if (!modelId) return null;
  return { providerId, modelId };
}

export type SwapDecision =
  | { action: 'swap'; target: SwapTarget; via: 'declared-backup' | 'auto' | 'sibling-account' }
  | { action: 'refuse'; reason: string }
  | { action: 'fail'; reason?: string };

/**
 * Decide what a mid-job bridge/quota death may do. Pure: the caller
 * supplies the already-resolved auto target and its cooldown state.
 *
 * - explicit + quota/driver death + declared backup (≠ failed provider)
 *   → swap to EXACTLY the declared backup.
 * - explicit + quota/driver death + no declared backup → refuse loudly.
 * - explicit + declared backup naming the FAILED provider itself → refuse
 *   (swapping to the corpse is not a swap).
 * - auto + quota death + target → swap; target in cooldown → fail with
 *   the cooled reason visible (no blind retry of either backend).
 * - anything else → fail (caller surfaces the original error).
 */
export function decideBridgeSwap(args: {
  explicitSelection: boolean;
  quotaDeath: boolean;
  driverFailure: boolean;
  failedProviderId: string;
  /** The model that died (a sibling-account swap keeps the same model). */
  failedModelId?: string;
  failedReason: string;
  declaredBackup: SwapTarget | null;
  autoTarget: SwapTarget | null;
  autoTargetCooldownReason?: string | null;
  /**
   * A6: a healthy sibling account of the SAME bridge (same provider +
   * model, different account id), when one exists. AUTO lanes only —
   * an explicit selection never treats a sibling as a backup candidate
   * (the user picked that account's provider; a sibling is a different
   * sign-in they did not pick).
   */
  siblingAccount?: { accountId: string } | null;
}): SwapDecision {
  const death = args.quotaDeath || args.driverFailure;
  if (args.explicitSelection) {
    if (!death) return { action: 'fail' };
    if (args.declaredBackup && args.declaredBackup.providerId !== args.failedProviderId) {
      return { action: 'swap', target: args.declaredBackup, via: 'declared-backup' };
    }
    return {
      action: 'refuse',
      reason:
        `it died mid-job (${args.failedReason}) and no backup was pre-declared for this selection — ` +
        `declare one (selection backup) to allow a mid-job swap, or pick a different model`,
    };
  }
  if (!args.quotaDeath) return { action: 'fail' };
  // A6 sibling-account swap (auto lane only — explicit selections
  // returned above): the same provider/model on a healthy sibling
  // account of the same bridge beats leaving the bridge entirely.
  if (args.siblingAccount) {
    return {
      action: 'swap',
      target: {
        providerId: args.failedProviderId,
        modelId: args.failedModelId ?? '',
        accountId: args.siblingAccount.accountId,
      },
      via: 'sibling-account',
    };
  }
  if (!args.autoTarget) return { action: 'fail' };
  if (args.autoTargetCooldownReason) {
    return { action: 'fail', reason: args.autoTargetCooldownReason };
  }
  return { action: 'swap', target: args.autoTarget, via: 'auto' };
}

/** Marker prefix of the in-band replay note (tests + UI greps rely on it). */
export const TRANSCRIPT_REPLAY_MARKER = '[Backend swap — transcript replay]';

/**
 * Build the message list handed to the backup backend: the FULL original
 * transcript plus one system note, inserted just before the final user
 * message, stating that the previous backend died and this is a
 * continuation. The original array is not mutated. Because the runtime's
 * message array carries the whole conversation (history is loaded from
 * the durable session store at turn start), the backup receives every
 * prior turn — that IS the replay.
 */
export function buildTranscriptReplayMessages(
  messages: readonly ChatMessage[],
  info: { fromProvider: string; fromModel: string; toProvider: string; toModel: string; reason: string },
): ChatMessage[] {
  const note: ChatMessage = {
    role: 'system',
    content:
      `${TRANSCRIPT_REPLAY_MARKER} The previous backend (${info.fromProvider}/${info.fromModel}) ` +
      `stopped mid-job: ${info.reason}. The full transcript above (system prompt, prior user and ` +
      `assistant turns, tool results) is replayed into your session so the job continues with ` +
      `context — do not restart from scratch or re-ask what was already answered. You are the ` +
      `backup backend (${info.toProvider}/${info.toModel}); continue the same job from where it stopped.`,
  };
  const out = [...messages];
  let insertAt = out.length;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.role === 'user') {
      insertAt = i;
      break;
    }
  }
  out.splice(insertAt, 0, note);
  return out;
}
