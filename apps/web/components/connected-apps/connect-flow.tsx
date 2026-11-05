// SPDX-License-Identifier: Apache-2.0
// ConnectFlow (W4): the Composio connect wizard used by the Connected Apps
// hub. Steps: (1) optional label → create connect link → open the provider
// sign-in in a new tab and poll until the account appears; (2) choose which
// bots may use the account — NONE are pre-checked, and the flow never
// silently enables an app for all bots; (3) success with Try it / Automate
// it / Done. Cancel is available at every step; errors surface inline.

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  composioSlugFor,
  createComposioLink,
  fetchComposioAccounts,
  setComposioAppEnabledForBot,
  storeChatPrefill,
  type ConnectedAppEntry,
  type WebBot,
} from '../../lib/connected-apps';
import './connected-apps.css';

export interface ConnectFlowProps {
  app: ConnectedAppEntry;
  bots: WebBot[];
  onDone: () => void;
  onAutomate: (slug: string) => void;
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120_000;

export function ConnectFlow({ app, bots, onDone, onAutomate }: ConnectFlowProps) {
  const router = useRouter();
  const slug = composioSlugFor(app);
  const [step, setStep] = useState<'label' | 'waiting' | 'bots' | 'done'>('label');
  const [label, setLabel] = useState('');
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const knownIds = useRef<Set<string>>(new Set());
  const pollRef = useRef<{ interval: ReturnType<typeof setInterval> | null; timeout: ReturnType<typeof setTimeout> | null }>({
    interval: null,
    timeout: null,
  });

  const stopPolling = () => {
    if (pollRef.current.interval) clearInterval(pollRef.current.interval);
    if (pollRef.current.timeout) clearTimeout(pollRef.current.timeout);
    pollRef.current = { interval: null, timeout: null };
  };

  useEffect(() => stopPolling, []);

  const startPolling = () => {
    stopPolling();
    setTimedOut(false);
    pollRef.current.interval = setInterval(() => {
      void (async () => {
        try {
          const data = await fetchComposioAccounts();
          const appeared = (data.accounts ?? []).some(
            (a) => a.toolkitSlug === slug && !knownIds.current.has(a.id),
          );
          if (appeared) {
            stopPolling();
            setStep('bots');
          }
        } catch {
          // Poll failures are non-fatal; the next tick retries.
        }
      })();
    }, POLL_INTERVAL_MS);
    pollRef.current.timeout = setTimeout(() => {
      stopPolling();
      setTimedOut(true);
    }, POLL_TIMEOUT_MS);
  };

  const createLink = async () => {
    setBusy('link');
    setError(null);
    try {
      const before = await fetchComposioAccounts().catch(() => null);
      knownIds.current = new Set((before?.accounts ?? []).map((a) => a.id));
      const data = await createComposioLink(slug, label.trim() || undefined);
      setRedirectUrl(data.redirectUrl);
      if (typeof window !== 'undefined') {
        window.open(data.redirectUrl, '_blank', 'noopener');
      }
      setStep('waiting');
      startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const applyBots = async () => {
    setBusy('apply');
    setError(null);
    try {
      const selected = bots.filter((b) => checked[b.id]);
      for (const bot of selected) {
        await setComposioAppEnabledForBot(slug, bot.id, true);
      }
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const cancel = () => {
    stopPolling();
    onDone();
  };

  const tryIt = () => {
    const task = app.starterTasks?.[0];
    if (task) {
      storeChatPrefill(task.prompt);
      router.push('/');
    }
    onDone();
  };

  return (
    <div className="ca-manage" data-testid="connect-flow">
      {error && (
        <p className="small" style={{ color: 'var(--red, #c0392b)' }}>
          {error}
        </p>
      )}

      {step === 'label' && (
        <div>
          <p className="small muted">
            Connect {app.name}. You can label this account first (useful when you connect more
            than one, e.g. a work and a personal account).
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <strong>Label (optional)</strong>
              <input
                className="input"
                aria-label="Account label (optional)"
                placeholder='e.g. "work account"'
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy === 'link'}
              onClick={() => void createLink()}
            >
              {busy === 'link' ? 'Creating link…' : 'Create connect link'}
            </button>
            <button className="btn btn-sm" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === 'waiting' && (
        <div>
          <p>
            <strong>Waiting for you to finish signing in…</strong>
          </p>
          <p className="small muted">
            A sign-in tab opened for {app.name}. Authorize there, then come back — this updates
            automatically.
          </p>
          {timedOut && (
            <p className="small">
              Still no account after a couple of minutes.{' '}
              <button className="btn btn-sm" onClick={startPolling}>
                Keep waiting (retry)
              </button>
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {redirectUrl && (
              <a className="btn btn-sm" href={redirectUrl} target="_blank" rel="noreferrer">
                Open sign-in page again
              </a>
            )}
            <button className="btn btn-sm" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === 'bots' && (
        <div>
          <p>
            <strong>{app.name} is connected.</strong>
          </p>
          <p className="small muted">
            Choose which bots may use this account — you can change this anytime. Nothing is
            enabled until you pick.
          </p>
          {bots.length === 0 && <p className="small muted">No bots yet — create one on the Bots page.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {bots.map((bot) => (
              <label key={bot.id} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  aria-label={`Allow ${bot.name} to use ${app.name}`}
                  checked={Boolean(checked[bot.id])}
                  onChange={(e) => setChecked((prev) => ({ ...prev, [bot.id]: e.target.checked }))}
                />
                {bot.name}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy === 'apply'}
              onClick={() => void applyBots()}
            >
              {busy === 'apply' ? 'Applying…' : 'Apply'}
            </button>
            <button className="btn btn-sm" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div>
          <p>
            <strong>All set — {app.name} is ready.</strong>
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {app.starterTasks?.[0] && (
              <button className="btn btn-primary btn-sm" onClick={tryIt}>
                Try it
              </button>
            )}
            <button
              className="btn btn-sm"
              onClick={() => {
                onAutomate(slug);
                onDone();
              }}
            >
              Automate it
            </button>
            <button className="btn btn-sm" onClick={onDone}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ConnectFlow;
