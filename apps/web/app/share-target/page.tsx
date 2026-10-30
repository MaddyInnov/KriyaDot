// SPDX-License-Identifier: Apache-2.0
'use client';

// OS share-target landing (C-11). The PWA manifest's share_target points
// here with ?title=&text=&url=; this page forwards the payload to the
// durable intake (POST /api/share-target) and confirms receipt, with a
// path into Chat where the shared item waits in the composer tray.

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { authedFetch } from '../../lib/api';

function ShareTargetInner() {
  const params = useSearchParams();
  const title = params.get('title') ?? '';
  const text = params.get('text') ?? '';
  const url = params.get('url') ?? '';
  const [state, setState] = useState<'saving' | 'saved' | 'empty' | 'error'>('saving');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    if (!title && !text && !url) { setState('empty'); return; }
    let live = true;
    (async () => {
      try {
        const res = await authedFetch('/api/share-target', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, text, url }),
        });
        if (!live) return;
        if (res.ok) setState('saved');
        else { setState('error'); setDetail(`API ${res.status}`); }
      } catch (e) {
        if (live) { setState('error'); setDetail(e instanceof Error ? e.message : String(e)); }
      }
    })();
    return () => { live = false; };
  }, [title, text, url]);

  return (
    <div>
      <h1 className="page-title">Shared to KriyaDot</h1>
      {state === 'saving' ? <p className="page-sub">Saving what you shared…</p> : null}
      {state === 'empty' ? <p className="page-sub">Nothing was shared — this page is the target for your device&apos;s Share sheet.</p> : null}
      {state === 'error' ? <div className="error-box">Could not save the share ({detail}). The content is still shown below so nothing is lost.</div> : null}
      {state === 'saved' ? <p className="page-sub">Saved. It is waiting in Chat — open it and ask any bot about it.</p> : null}
      {(title || text || url) ? (
        <div className="card mt">
          {title ? <strong>{title}</strong> : null}
          {text ? <p className="small mt">{text}</p> : null}
          {url ? <p className="small mt"><a href={url} target="_blank" rel="noreferrer">{url}</a></p> : null}
        </div>
      ) : null}
      <p className="mt"><Link className="btn" href="/">Open Chat</Link></p>
    </div>
  );
}

export default function ShareTargetPage() {
  return (
    <Suspense fallback={<p className="page-sub">Loading…</p>}>
      <ShareTargetInner />
    </Suspense>
  );
}
