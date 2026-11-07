// SPDX-License-Identifier: Apache-2.0
// Rich message content (chat polish): spoiler blur rendering,
// citation chips, and markdown rendering for assistant text.
// SpoilerText renders ||spoiler|| spans blurred until
// clicked; CitationChips activates whenever a message carries
// citations in the {title, url|docId, excerpt} shape (KB shape with
// docTitle is normalized too). AssistantMessageText renders assistant
// answers through the shared markdown renderer (./markdown — the same
// one the file preview pane uses) instead of raw plain text, so model
// output no longer shows literal ### / ** markers; ||spoiler|| spans
// inside an answer stay blurred via SpoilerSpan.

'use client';

import React, { useState } from 'react';
import { normalizeCitations, parseSpoilerSegments, type ChatCitation } from './chat-polish';
import { handleMarkdownCopyClick, renderMarkdownLite } from './markdown';

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

/**
 * Assistant message text rendered as markdown via the shared
 * renderMarkdownLite (full marked + DOMPurify pipeline — model text
 * cannot inject markup). Spoiler segments keep the blur-until-clicked
 * treatment; the surrounding text is rendered per segment, so a
 * markdown construct split by a spoiler degrades to plainer output
 * rather than breaking. The onClick delegate powers code-block Copy
 * buttons inside the rendered HTML.
 */
export function AssistantMessageText({ text }: { text: string }) {
  const segments = parseSpoilerSegments(text);
  if (!segments.some((s) => s.spoiler)) {
    return (
      <div
        className="msg-md"
        onClick={handleMarkdownCopyClick}
        dangerouslySetInnerHTML={{ __html: renderMarkdownLite(text) }}
      />
    );
  }
  return (
    <div className="msg-md" onClick={handleMarkdownCopyClick}>
      {segments.map((s, i) =>
        s.spoiler ? (
          <SpoilerSpan key={i} text={s.text} />
        ) : (
          <span
            key={i}
            style={{ display: 'contents' }}
            // renderMarkdownLite: shared marked + DOMPurify pipeline.
            dangerouslySetInnerHTML={{ __html: renderMarkdownLite(s.text) }}
          />
        ),
      )}
    </div>
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
