// SPDX-License-Identifier: Apache-2.0
// Shared chat markdown renderer (moved out of file-preview-pane.tsx so the
// file preview and chat message text use ONE implementation — the pane's
// header comment used to note "the chat has no shared md renderer"; this
// module is that shared renderer). Minimal and safe: all source HTML is
// escaped before any markdown substitution, so model/file text can never
// inject markup.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

/** Minimal, safe markdown → HTML (headings, lists, quotes, code fences, paragraphs). */
export function renderMarkdownLite(src: string): string {
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };
  for (const line of src.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        out.push(`<pre class="md-pre">${escapeHtml(codeBuf.join('\n'))}</pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1]!.length + 1; // h1 in a pane → start at h2
      out.push(`<h${level}>${inlineMd(heading[2]!)}</h${level}>`);
      continue;
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${inlineMd(item[1]!)}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('> ')) {
      out.push(`<blockquote>${inlineMd(line.trimStart().slice(2))}</blockquote>`);
      continue;
    }
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  if (inCode) out.push(`<pre class="md-pre">${escapeHtml(codeBuf.join('\n'))}</pre>`);
  closeList();
  return out.join('\n');
}
