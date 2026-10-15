// SPDX-License-Identifier: Apache-2.0
'use client';

import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Tasteful PWA install banner. Captures `beforeinstallprompt`, shows only on
 * small (mobile) viewports, and never nags again after dismissal/install.
 */
export default function PwaInstallBanner() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem('mvp:pwa-dismissed') === '1') setDismissed(true);
    } catch {
      /* ignore */
    }
    const mq = window.matchMedia('(max-width: 768px)');
    const onMq = () => setIsMobile(mq.matches);
    onMq();
    mq.addEventListener?.('change', onMq);

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferred(null);
      setDismissed(true);
      try {
        localStorage.setItem('mvp:pwa-dismissed', '1');
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      mq.removeEventListener?.('change', onMq);
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!deferred || dismissed || !isMobile) return null;

  const install = async () => {
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === 'accepted') setDeferred(null);
  };

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem('mvp:pwa-dismissed', '1');
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Install app"
      style={{
        position: 'fixed',
        left: 12,
        right: 12,
        bottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 18,
        background: 'var(--card, rgba(255,255,255,0.85))',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.4)',
        border: '1px solid var(--border, rgba(0,0,0,0.08))',
      }}
    >
      <img src="/icons/icon-192.png" alt="" width={40} height={40} style={{ borderRadius: 10 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Install KriyaDot</div>
        <div className="small muted" style={{ fontSize: 12 }}>
          Add to your home screen for the full mobile companion.
        </div>
      </div>
      <button className="btn primary small" onClick={install} style={{ whiteSpace: 'nowrap' }}>
        Install
      </button>
      <button className="btn small" onClick={dismiss} aria-label="Dismiss" style={{ whiteSpace: 'nowrap' }}>
        Later
      </button>
    </div>
  );
}
