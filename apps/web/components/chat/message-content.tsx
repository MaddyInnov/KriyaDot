// SPDX-License-Identifier: Apache-2.0
// Rich message content (chat polish): spoiler blur rendering and
// citation chips. SpoilerText renders ||spoiler|| spans blurred until
// clicked; CitationChips activates whenever a message carries
// citations in the {title, url|docId, excerpt} shape (KB shape with
// docTitle is normalized too).

'use client';

import React, { useState } from 'react';
import { normalizeCitations, parseSpoilerSegments, type ChatCitation } from './chat-polish';

export type { ChatCitation };

function SpoilerSpan({ text }: { text: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      className={`spoiler${revealed ? ' revealed' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={revealed ? undefined : 'Spoiler — click to reveal'}
      title={revealed ? undefined : 'Spoiler — click to reveal'}
      onClick={() => setRevealed((v) => !v)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRevealed((v) => !v); } }}
      style={revealed ? undefined : { filter: 'blur(5px)', cursor: 'pointer', userSelect: 'none' }}
    >
      {text}
    </span>
  );
}

/** Message text with spoiler spans blurred until clicked. */
export function SpoilerText({ text }: { text: string }) {
  const segments = parseSpoilerSegments(text);
  if (!segments.some((s) => s.spoiler)) return <>{text}</>;
  return (
    <>
      {segments.map((s, i) => (s.spoiler ? <SpoilerSpan key={i} text={s.text} /> : <span key={i}>{s.text}</span>))}
    </>
  );
}

/** Citation chips linking to source docs; renders nothing without citations. */
export function CitationChips({ citations }: { citations?: unknown }) {
  const list = normalizeCitations(citations);
  if (list.length === 0) return null;
  return (
    <div className="citation-chips" aria-label="Sources" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {list.map((c, i) => {
        const label = `📄 ${c.title}`;
        const title = c.excerpt ?? c.title;
        return c.url ? (
          <a key={i} className="chip-btn citation-chip" href={c.url} target="_blank" rel="noreferrer" title={title}>{label}</a>
        ) : (
          <span key={i} className="chip-btn citation-chip" data-doc-id={c.docId} title={title}>{label}</span>
        );
      })}
    </div>
  );
}
