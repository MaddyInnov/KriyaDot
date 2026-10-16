// SPDX-License-Identifier: Apache-2.0
// Slash command parsing: /bots /model /workflows /memory /activity /theme /clear /help /quit
export interface ParsedCommand {
  /** Command name without the leading slash, lowercased. */
  name: string;
  /** Raw argument string (may be empty). */
  args: string;
}

const KNOWN = new Set([
  'bots',
  'model',
  'workflows',
  'memory',
  'activity',
  'theme',
  'clear',
  'help',
  'quit',
]);

/**
 * Parse a chat input line. Returns a ParsedCommand when the line starts
 * with `/`, otherwise null (plain message). Unknown commands parse as
 * `{ name: <whatever>, args }` so the UI can report "unknown command".
 */
export function parseSlashCommand(input: string): ParsedCommand | null {
  const line = input.trim();
  if (!line.startsWith('/')) return null;
  const body = line.slice(1).trim();
  if (!body) return { name: '', args: '' };
  const space = body.search(/\s/);
  if (space === -1) return { name: body.toLowerCase(), args: '' };
  return { name: body.slice(0, space).toLowerCase(), args: body.slice(space).trim() };
}

export function isKnownCommand(name: string): boolean {
  return KNOWN.has(name);
}

export interface HelpEntry {
  command: string;
  usage: string;
  description: string;
}

export const HELP_ENTRIES: HelpEntry[] = [
  { command: '/bots', usage: '/bots', description: 'Pick a bot to chat with' },
  { command: '/model', usage: '/model [id]', description: 'List models or switch this bot to one' },
  { command: '/workflows', usage: '/workflows', description: 'Show workflows and recent runs' },
  { command: '/memory', usage: '/memory', description: 'Show this bot’s memory summary' },
  { command: '/activity', usage: '/activity', description: 'Show recent activity (audit log)' },
  { command: '/theme', usage: '/theme <name>', description: 'Switch TUI theme (light/dark/midnight/porcelain/ocean)' },
  { command: '/clear', usage: '/clear', description: 'Clear the chat transcript' },
  { command: '/help', usage: '/help', description: 'Show this help' },
  { command: '/quit', usage: '/quit', description: 'Exit the TUI' },
];

export function helpText(): string {
  return HELP_ENTRIES.map((e) => `${e.usage.padEnd(18)} ${e.description}`).join('\n');
}
