// SPDX-License-Identifier: Apache-2.0
'use client';

// Contextual next-step hint (closure addendum ADD-3): a small,
// reusable card for empty states that points at the matching Guide
// article instead of leaving the user at a dead end. Drop it next to
// any "nothing here yet" message:
//
//   <GuideHint articleId="workflows" text="No workflows yet — the guide walks through your first one." />

import React from 'react';
import Link from 'next/link';

export function GuideHint({
  articleId,
  text,
  label = 'Open the guide walkthrough',
}: {
  /** Guide article id (apps/api guide-content.ts) this empty state maps to. */
  articleId: string;
  text: string;
  label?: string;
}) {
  return (
    <div className="card mt" data-testid="guide-hint">
      <p className="small muted" style={{ margin: 0 }}>
        💡 {text}{' '}
        <Link href={`/more/guide#${articleId}`} className="btn btn-sm">
          {label} →
        </Link>
      </p>
    </div>
  );
}
