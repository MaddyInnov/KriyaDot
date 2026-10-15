// SPDX-License-Identifier: Apache-2.0
// Offline fallback page, served by the service worker when the network fails.
'use client';

export default function OfflinePage() {
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        textAlign: 'center',
        padding: 24,
      }}
    >
      <img src="/icons/icon-192.png" alt="KriyaDot" width={72} height={72} style={{ borderRadius: 18, opacity: 0.7 }} />
      <h1 style={{ fontSize: 22, margin: 0 }}>You're offline</h1>
      <p className="muted" style={{ maxWidth: 320, margin: 0 }}>
        KriyaDot needs a connection to reach your agents. Check your network and try again —
        your chats and data are safe on the server.
      </p>
      <button className="btn primary" onClick={() => window.location.reload()}>
        Retry
      </button>
    </div>
  );
}
