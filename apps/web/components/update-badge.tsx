// SPDX-License-Identifier: Apache-2.0
'use client';

// Subtle "update available" dot. Polls /api/updates/status infrequently and
// renders a small dot when a newer release is waiting. Silent on errors —
// a failed check must never break navigation.

import { useEffect, useState } from 'react';

export function UpdateBadge() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch('/api/updates/status');
        if (!res.ok) return;
        const body = (await res.json()) as { status?: { state?: string } };
        if (alive) setAvailable(body.status?.state === 'available' || body.status?.state === 'ready');
      } catch {
        // ignore — badge is best-effort
      }
    };
    void check();
    const t = setInterval(check, 6 * 3600_000); // every 6h; the panel polls more often
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!available) return null;
  return (
    <span className="update-badge-dot" title="An update is available — see Preferences → Updates" aria-label="Update available" />
  );
}
