// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Generic renderer for structured chat-command results (#114 et al.):
 * any payload the command endpoint returns is normalized into sections
 * (see lib/octomind-web normalizeCommandResult) so /info, /report,
 * /usage, /status, /skill, … display sanely before bespoke UI exists.
 */
import { normalizeCommandResult } from '../../lib/octomind-web';

export function CommandResultCard({ title, payload }: { title: string; payload: unknown }) {
  const sections = normalizeCommandResult(payload, title);
  return (
    <div className="card" role="status" aria-label={`Command result: ${title}`} style={{ margin: '8px 0' }}>
      <strong>{title}</strong>
      {sections.map((s, i) => (
        <div key={i} style={{ marginTop: 8 }}>
          {sections.length > 1 && <div className="small muted" style={{ fontWeight: 600 }}>{s.title}</div>}
          {s.lines.map((line, j) => (
            <div key={j} className="small mono" style={{ whiteSpace: 'pre-wrap' }}>{line}</div>
          ))}
          {s.pre && (
            <pre className="mono small" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{s.pre}</pre>
          )}
        </div>
      ))}
    </div>
  );
}
