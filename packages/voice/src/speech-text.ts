// SPDX-License-Identifier: Apache-2.0
// Speech-text preparation: rewrite assistant markdown into text that
// sounds right when read aloud by a TTS provider.
//
// LLM replies are markdown: headings, bold, links, tables, and fenced
// code blocks. Spoken verbatim, a TTS engine reads the punctuation
// ("hash hash heading", "star star bold") and drones through raw URLs
// and source code. prepareSpeechText() rewrites the text first:
//
//   - fenced code blocks collapse to a short spoken placeholder
//     (source code is never worth reading aloud character by character)
//   - links expand to their link text; bare URLs shrink to their host
//   - images keep their alt text
//   - headings, emphasis, blockquotes, list markers, and table pipes
//     are stripped, keeping the words
//   - inline code keeps its text (it is usually a name or a value)
//   - HTML tags are dropped, keeping the text they wrapped
//
// The function is pure and total: any string in, a speakable string
// out (possibly empty, e.g. input that was only a table separator).

/** Spoken stand-in for a fenced code block. */
export const DEFAULT_CODE_BLOCK_PLACEHOLDER = 'Code omitted.';

export interface SpeechTextOptions {
  /** Replacement sentence for each fenced code block. */
  codeBlockPlaceholder?: string;
}

/** Host part of a URL for spoken output ("https://a.b/c?d" → "a.b"). */
function spokenHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host || 'link';
  } catch {
    return 'link';
  }
}

/**
 * Rewrite markdown `input` into speakable plain text. See the file
 * header for the exact rules. Returns '' when nothing speakable
 * remains.
 */
export function prepareSpeechText(input: string, opts: SpeechTextOptions = {}): string {
  if (typeof input !== 'string' || !input.trim()) return '';
  const placeholder = opts.codeBlockPlaceholder ?? DEFAULT_CODE_BLOCK_PLACEHOLDER;
  let text = input.replace(/\r\n?/g, '\n');

  // Fenced code blocks (``` or ~~~, optional language tag) → placeholder.
  // A line-wise scan (not one big regex) so a closing fence can never be
  // mistaken for a new opening fence. An unterminated fence swallows the
  // rest of the message; its placeholder is still spoken exactly once.
  {
    const lines = text.split('\n');
    const kept: string[] = [];
    let fence: { char: string; len: number } | null = null;
    for (const line of lines) {
      const m = /^[ \t]*(`{3,}|~{3,})/.exec(line);
      if (!fence && m) {
        fence = { char: m[1]![0]!, len: m[1]!.length };
        kept.push('', placeholder, '');
        continue;
      }
      if (fence && m && m[1]![0] === fence.char && m[1]!.length >= fence.len) {
        fence = null;
        continue;
      }
      if (!fence) kept.push(line);
    }
    text = kept.join('\n');
  }

  // Reference-style link definitions are metadata, not speech.
  text = text.replace(/^[ \t]*\[[^\]]+\]:\s*\S+.*$/gm, '');

  // Images keep their alt text; links keep their link text.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');

  // Autolinks: <https://…> speaks as its host; <name@host> stays as-is.
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, (_m, url: string) => spokenHost(url));
  text = text.replace(/<([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)>/g, '$1');

  // Inline code keeps its contents (a name, flag, or short value).
  text = text.replace(/`([^`\n]+)`/g, '$1');
  // Any stray backticks left over (unbalanced) are punctuation noise.
  text = text.replace(/`+/g, '');

  // HTML tags drop out, keeping the wrapped text.
  text = text.replace(/<[^>\n]+>/g, ' ');

  // Tables: separator rows vanish; cell pipes become pauses.
  text = text.replace(/^[ \t]*\|?[\s:|-]+\|[\s:|-]*$/gm, '');
  text = text.replace(/\|/g, ', ');

  // Line-level structure: headings, blockquotes, list markers, rules.
  text = text
    .split('\n')
    .map((line) => {
      let out = line;
      out = out.replace(/^[ \t]*#{1,6}[ \t]+/, ''); // ATX heading
      out = out.replace(/^[ \t]*(>[ \t]?)+/, ''); // blockquote
      out = out.replace(/^[ \t]*[-*_]{3,}[ \t]*$/, ''); // horizontal rule
      out = out.replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/, ''); // task list
      out = out.replace(/^[ \t]*[-*+][ \t]+/, ''); // bullet list
      out = out.replace(/^[ \t]*\d{1,3}[.)][ \t]+/, ''); // numbered list
      return out;
    })
    .join('\n');
  // Setext heading underlines (=== / --- under a title line).
  text = text.replace(/^[ \t]*=+[ \t]*$/gm, '');

  // Emphasis and strikethrough keep their words.
  text = text.replace(/(\*\*\*|___)(.+?)\1/g, '$2');
  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');
  text = text.replace(/~~(.+?)~~/g, '$1');
  text = text.replace(/\*([^*\n]+)\*/g, '$1');
  text = text.replace(/\b_([^_\n]+)_\b/g, '$1');

  // Bare URLs speak as their host — nobody wants to hear a query string.
  text = text.replace(/https?:\/\/[^\s)\]]+/g, (url) => spokenHost(url.replace(/[.,;:!?]+$/, '')));

  // Collapse whitespace: one space between words, tidy placeholder joins.
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n+/g, '\n');
  text = text.replace(/\n/g, ' ');
  text = text.replace(/\s+([.,;:!?])/g, '$1');
  text = text.replace(/,\s*,/g, ',');
  return text.replace(/\s+/g, ' ').trim();
}

/** Alias matching the markdown→speech naming used by callers. */
export const markdownToSpeechText = prepareSpeechText;
