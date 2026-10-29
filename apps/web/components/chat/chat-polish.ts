// SPDX-License-Identifier: Apache-2.0
// Chat polish pure helpers (OpenMausBot §1.1/§1.2/§2.6): in-chat find,
// spoiler parsing, citation normalization, unread divider, app badge.
// No React/DOM writes except setAppBadge (guarded) — unit-testable.

/** One in-chat find match: which message, and the char range inside it. */
export interface FindMatch { blockId: string; start: number; end: number; index: number }

/** All case-insensitive matches of `query` across message texts, in order. */
export function findInMessages(
  messages: Array<{ id: string; text: string }>,
  query: string,
): FindMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: FindMatch[] = [];
  for (const m of messages) {
    const hay = m.text.toLowerCase();
    let from = 0;
    for (;;) {
      const i = hay.indexOf(q, from);
      if (i < 0) break;
      out.push({ blockId: m.id, start: i, end: i + q.length, index: out.length });
      from = i + Math.max(1, q.length);
    }
  }
  return out;
}

/** Split text into plain/highlighted segments for one query (for <mark> rendering). */
export function splitByQuery(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, hit: false }];
  const out: Array<{ text: string; hit: boolean }> = [];
  const hay = text.toLowerCase();
  let last = 0;
  for (;;) {
    const i = hay.indexOf(q, last);
    if (i < 0) break;
    if (i > last) out.push({ text: text.slice(last, i), hit: false });
    out.push({ text: text.slice(i, i + q.length), hit: true });
    last = i + q.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length > 0 ? out : [{ text, hit: false }];
}

// --- Spoilers: ||wrapped|| spans render blurred until clicked -------------

export interface SpoilerSegment { text: string; spoiler: boolean }

export function parseSpoilerSegments(content: string): SpoilerSegment[] {
  const out: SpoilerSegment[] = [];
  const re = /\|\|([\s\S]+?)\|\|/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) out.push({ text: content.slice(last, m.index), spoiler: false });
    out.push({ text: m[1] ?? '', spoiler: true });
    last = m.index + m[0].length;
  }
  if (last < content.length) out.push({ text: content.slice(last), spoiler: false });
  return out.length > 0 ? out : [{ text: content, spoiler: false }];
}

// --- Citations ---------------------------------------------------------------

/** Canonical citation shape the chat renders as chips. */
export interface ChatCitation { title: string; url?: string; docId?: string; excerpt?: string }

/** Normalize a citation from either the chat shape or the KB shape ({docTitle, docId, excerpt}). */
export function normalizeCitation(raw: unknown): ChatCitation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title : typeof r.docTitle === 'string' ? r.docTitle : '';
  if (!title && typeof r.url !== 'string' && typeof r.docId !== 'string') return null;
  return {
    title: title || (typeof r.url === 'string' ? r.url : 'Source'),
    ...(typeof r.url === 'string' ? { url: r.url } : {}),
    ...(typeof r.docId === 'string' ? { docId: r.docId } : {}),
    ...(typeof r.excerpt === 'string' ? { excerpt: r.excerpt } : {}),
  };
}

export function normalizeCitations(raw: unknown): ChatCitation[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCitation).filter((c): c is ChatCitation => c !== null);
}

// --- Unread divider ------------------------------------------------------------

/**
 * Index of the first unread block: the first block after `lastReadId`
 * (or the first block with ts > lastReadTs when no id is known).
 * -1 when everything is read / nothing is known.
 */
export function unreadDividerIndex(
  blocks: Array<{ id: string; ts: number }>,
  lastRead: { id?: string; ts?: number },
): number {
  if (blocks.length === 0) return -1;
  if (lastRead.id) {
    const i = blocks.findIndex((b) => b.id === lastRead.id);
    if (i >= 0) return i + 1 < blocks.length ? i + 1 : -1;
  }
  if (typeof lastRead.ts === 'number' && lastRead.ts > 0) {
    const i = blocks.findIndex((b) => b.ts > lastRead.ts!);
    return i;
  }
  return -1;
}

// --- App badge (document.title + favicon) --------------------------------------

/** Title with a needs-you count prefix: "(3) KriyaDot". */
export function badgedTitle(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

/**
 * Set document.title and draw a count badge onto the favicon (canvas).
 * No-ops outside a browser. Pass the ORIGINAL base title each time.
 */
export function setAppBadge(baseTitle: string, count: number): void {
  if (typeof document === 'undefined') return;
  document.title = badgedTitle(baseTitle, count);
  try {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (count <= 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#7c6cf0';
    ctx.beginPath(); ctx.arc(32, 32, 30, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(count > 99 ? '99+' : String(count), 32, 34);
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = canvas.toDataURL('image/png');
  } catch { /* badge is best-effort */ }
}
