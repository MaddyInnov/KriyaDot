// SPDX-License-Identifier: Apache-2.0
// Shared helpers for the Agent Teams page.

export interface TeamBot {
  id: string;
  name: string;
  description: string;
}

/**
 * /api/bots returns a bare array; tolerate a { bots: [...] } envelope
 * (and nullish payloads) defensively.
 */
export function normalizeBots(raw: TeamBot[] | { bots: TeamBot[] } | null | undefined): TeamBot[] {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.bots)) return raw.bots;
  return [];
}
