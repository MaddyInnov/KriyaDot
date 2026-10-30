// SPDX-License-Identifier: Apache-2.0
'use client';

// First-run onboarding tour (closure addendum ADD-3): a lightweight
// step-through of KriyaDot's six destinations plus this Guide. It
// shows ONCE for a fresh install — gated on the localStorage flag
// below — and can be re-opened any time from the Guide page by
// rendering it with `forceOpen`.
//
// The show-once helpers take an injectable storage so tests (and SSR)
// never depend on a real window.localStorage.

import React, { useEffect, useState } from 'react';
import Link from 'next/link';

export const TOUR_STORAGE_KEY = 'kriyadot:guide-tour-seen';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** True when the tour should auto-show: never seen on this install. */
export function shouldShowTour(storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(TOUR_STORAGE_KEY) !== '1';
  } catch {
    return false;
  }
}

/** Record that the tour was finished or skipped — it will not auto-show again. */
export function markTourSeen(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(TOUR_STORAGE_KEY, '1');
  } catch {
    // Storage unavailable (private mode) — the tour simply stays manual.
  }
}

export interface TourStep {
  title: string;
  body: string;
  /** Destination this step is about; the step links straight to it. */
  href: string;
  linkLabel: string;
}

/** The tour walks the six real destinations, then lands on the Guide. */
export const TOUR_STEPS: TourStep[] = [
  {
    title: 'Welcome to KriyaDot',
    body: 'One team of specialist AI bots, on your machine and in your own cloud. This short tour walks the six places you will actually use — it takes under a minute, and you can replay it from the User Guide any time.',
    href: '/',
    linkLabel: 'Start in Chat',
  },
  {
    title: 'Chat — Universal Chat',
    body: 'Just ask. The composer routes each message for you: everyday questions are answered directly, clear topics go to a specialist bot (watch for the "✦ Handled by …" chip), and multi-part asks are split and fused into one answer. Type @ and a bot name to pin a specific bot.',
    href: '/',
    linkLabel: 'Open Chat',
  },
  {
    title: 'Bots — your specialists',
    body: 'Create bots with "✨ Set me up", give each a persona, model, workspace and policy, and set where it runs: this device, cloud with reporting back, or cloud only.',
    href: '/bots',
    linkLabel: 'Open Bots',
  },
  {
    title: 'Workflows — repeatable automations',
    body: 'Saved multi-step jobs you (or your bots) can run on demand. Dry-run first to see the plan for free, and schedule routines that anchor to your cloud so they fire even while your PC is off.',
    href: '/workflows',
    linkLabel: 'Open Workflows',
  },
  {
    title: 'Marketplace — install capability',
    body: 'Ready-made bots, skills, MCP servers and plugins. Installs route through the safety flow for their kind — MCP servers and plugins ask for approval before they can run.',
    href: '/marketplace',
    linkLabel: 'Open Marketplace',
  },
  {
    title: 'Workspace — your content',
    body: 'Notes, tasks, pages and knowledge live here, shared by the whole team and synced through your own cloud instance to your other devices.',
    href: '/workspace',
    linkLabel: 'Open Workspace',
  },
  {
    title: 'Activity — the audit trail',
    body: 'Every run, routing decision, approval and denial is logged here. When a bot asks to do something consequential, you approve or deny it — nothing sensitive runs silently.',
    href: '/activity',
    linkLabel: 'Open Activity',
  },
  {
    title: 'The User Guide — help that stays',
    body: 'Stuck later? The Guide has a walkthrough for each of these, a search box, and a "How do I…?" box that answers from the guide and links you to the exact screen. That is the tour — go ask your team something.',
    href: '/more/guide',
    linkLabel: 'Open the User Guide',
  },
];

export function GuideTour({ forceOpen = false }: { forceOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (forceOpen) {
      setIndex(0);
      setOpen(true);
    }
  }, [forceOpen]);

  useEffect(() => {
    if (!forceOpen && shouldShowTour()) setOpen(true);
    // Auto-show is a mount-time decision only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!open) return null;
  const step = TOUR_STEPS[index];
  const isLast = index === TOUR_STEPS.length - 1;

  const close = () => {
    markTourSeen();
    setOpen(false);
  };

  return (
    <div className="card mt" role="dialog" aria-label="KriyaDot tour" data-testid="guide-tour">
      <div className="row-between">
        <strong>
          Tour · {index + 1} of {TOUR_STEPS.length}
        </strong>
        <button type="button" className="btn btn-sm" onClick={close} aria-label="Skip tour">
          Skip tour
        </button>
      </div>
      <h3 className="mt">{step.title}</h3>
      <p className="small muted">{step.body}</p>
      <div className="mt" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Link className="btn btn-sm" href={step.href} onClick={close}>
          {step.linkLabel} →
        </Link>
        {index > 0 && (
          <button type="button" className="btn btn-sm" onClick={() => setIndex((i) => i - 1)}>
            Back
          </button>
        )}
        {!isLast ? (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setIndex((i) => i + 1)}>
            Next
          </button>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" onClick={close}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}
