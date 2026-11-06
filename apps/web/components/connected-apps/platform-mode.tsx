// SPDX-License-Identifier: Apache-2.0
// PlatformMode: the Composio platform mode choice (KriyaDot Managed vs
// BYOK) shown at the top of the Accounts → Composio platform section.
// Two selectable option cards with radio semantics; the active mode is
// visually marked, switching POSTs /api/composio/mode and refetches
// status, and the managed card carries the token paste / usage /
// disconnect states plus the quota-exceeded banner. The BYOK card keeps
// the existing key connect/disconnect behaviour unchanged.

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  MANAGED_PRIVACY_SENTENCE,
  MANAGED_QUOTA_EXCEEDED_MESSAGE,
  connectComposioPlatform,
  deleteComposioManagedToken,
  disconnectComposioPlatform,
  fetchComposioStatus,
  isManagedQuotaExceeded,
  saveComposioManagedToken,
  setComposioMode,
  type ComposioMode,
  type ComposioStatus,
} from '../../lib/connected-apps';
import './connected-apps.css';

export { MANAGED_PRIVACY_SENTENCE };
export const QUOTA_EXCEEDED_MESSAGE = MANAGED_QUOTA_EXCEEDED_MESSAGE;

export const MODE_SEPARATION_NOTE =
  "Your connections in one mode don't carry over to the other — each mode has its own connected accounts.";

export interface PlatformModeProps {
  /** Controlled status. When provided, the component does not fetch on mount. */
  status?: ComposioStatus | null;
  onStatusChange?: (status: ComposioStatus) => void;
  /** Optional custom BYOK content rendered inside the BYOK card (accounts page seam). */
  byokContent?: React.ReactNode;
}

export function PlatformMode({ status: statusProp, onStatusChange, byokContent }: PlatformModeProps) {
  const isControlled = statusProp !== undefined;
  const [internalStatus, setInternalStatus] = useState<ComposioStatus | null>(null);
  const status = isControlled ? (statusProp ?? null) : internalStatus;

  const [managedToken, setManagedToken] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const applyStatus = useCallback(
    (next: ComposioStatus) => {
      if (!isControlled) setInternalStatus(next);
      onStatusChange?.(next);
    },
    [isControlled, onStatusChange],
  );

  const refreshStatus = useCallback(async () => {
    const next = await fetchComposioStatus();
    applyStatus(next);
    return next;
  }, [applyStatus]);

  useEffect(() => {
    if (isControlled) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchComposioStatus();
        if (!cancelled) applyStatus(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isControlled]);

  const mode: ComposioMode = status?.mode ?? 'byok';
  const managed = status?.managed;
  const serviceConfigured = Boolean(managed?.serviceConfigured);
  const tokenConfigured = Boolean(managed?.tokenConfigured);
  const quotaExceeded = isManagedQuotaExceeded(managed);

  const switchMode = async (nextMode: ComposioMode) => {
    if (nextMode === mode) return;
    if (nextMode === 'managed' && !serviceConfigured) return;
    setBusy(`mode-${nextMode}`);
    setError(null);
    setNotice('');
    try {
      await setComposioMode(nextMode);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const saveToken = async () => {
    const token = managedToken.trim();
    if (!token) {
      setError('Paste your managed access token first.');
      return;
    }
    setBusy('managed-save');
    setError(null);
    setNotice('');
    try {
      await saveComposioManagedToken(token);
      setManagedToken('');
      setNotice('Managed is on — you can connect apps with a normal sign-in.');
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const disconnectManaged = async () => {
    setBusy('managed-disconnect');
    setError(null);
    setNotice('');
    try {
      await deleteComposioManagedToken();
      setNotice('Managed token removed. Your own Composio key (if any) was not touched.');
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const connectByok = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError('Paste your Composio API key first.');
      return;
    }
    setBusy('byok-connect');
    setError(null);
    setNotice('');
    try {
      await connectComposioPlatform(key);
      setApiKey('');
      setNotice('Composio connected. The key is stored encrypted server-side.');
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const disconnectByok = async () => {
    setBusy('byok-disconnect');
    setError(null);
    setNotice('');
    try {
      await disconnectComposioPlatform();
      setNotice('Composio disconnected — the API key was deleted.');
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const showUsage =
    managed && typeof managed.used === 'number' && typeof managed.quota === 'number';

  // In BYOK mode, `connected` reflects the BYOK key. In managed mode the
  // BYOK key state is not reported separately, so only show the BYOK
  // disconnect when BYOK is the active mode and connected.
  const byokConnected = mode === 'byok' && Boolean(status?.connected);

  return (
    <div data-testid="platform-mode">
      {error && (
        <p className="small" style={{ color: 'var(--danger, #c0392b)' }}>
          {error}
        </p>
      )}
      {notice && (
        <div className="card" style={{ borderColor: '#bbf7d0', background: '#f0fdf4' }}>
          {notice}
        </div>
      )}

      {quotaExceeded && (
        <div
          role="alert"
          data-testid="managed-quota-banner"
          className="card"
          style={{ borderColor: '#f59e0b', background: '#fffbeb', marginBottom: 12 }}
        >
          <p style={{ margin: 0 }}>
            <strong>{QUOTA_EXCEEDED_MESSAGE}</strong>
          </p>
        </div>
      )}

      <p className="small muted">{MODE_SEPARATION_NOTE}</p>

      <div
        role="radiogroup"
        aria-label="App platform mode"
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        {/* Managed card */}
        <div
          role="radio"
          aria-checked={mode === 'managed'}
          aria-disabled={!serviceConfigured}
          data-testid="platform-mode-managed"
          data-active={mode === 'managed' ? 'true' : 'false'}
          tabIndex={0}
          className="card"
          style={{
            cursor: serviceConfigured ? 'pointer' : 'not-allowed',
            opacity: serviceConfigured ? 1 : 0.75,
            outline: mode === 'managed' ? '2px solid var(--accent, #2563eb)' : undefined,
            borderColor: mode === 'managed' ? 'var(--accent, #2563eb)' : undefined,
          }}
          onClick={() => void switchMode('managed')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void switchMode('managed');
            }
          }}
        >
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <strong>
              KriyaDot Managed — included with your plan
            </strong>
            {mode === 'managed' && <span className="chip green">Active</span>}
          </div>
          <p className="small muted">
            Connect apps with a normal sign-in — no Composio account or API key of your own
            needed. Usage counts against your plan&apos;s managed allowance.
          </p>
          <p className="small muted">{MANAGED_PRIVACY_SENTENCE}</p>

          {!serviceConfigured && (
            <p className="small muted">
              Managed apps aren&apos;t switched on for this instance yet.
            </p>
          )}

          {serviceConfigured && !tokenConfigured && (
            <div
              style={{ marginTop: 8 }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <label
                className="small"
                htmlFor="managed-token-input"
                style={{ display: 'block', marginBottom: 6 }}
              >
                <strong>Managed access token — from your KriyaDot account</strong>
              </label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  id="managed-token-input"
                  className="input mono"
                  type="password"
                  autoComplete="off"
                  aria-label="Managed access token — from your KriyaDot account"
                  placeholder="paste managed access token"
                  value={managedToken}
                  onChange={(e) => setManagedToken(e.target.value)}
                  style={{ flex: 1, minWidth: 200 }}
                />
                <button
                  className="btn btn-primary"
                  disabled={busy === 'managed-save' || !managedToken.trim()}
                  onClick={() => void saveToken()}
                >
                  {busy === 'managed-save' ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}

          {serviceConfigured && tokenConfigured && (
            <div
              style={{ marginTop: 8 }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <p className="small" style={{ margin: '0 0 6px' }}>
                <span className="chip green">Managed is on</span>
                {managed?.plan ? (
                  <span className="small muted"> · Plan: {managed.plan}</span>
                ) : null}
              </p>
              {showUsage && (
                <p className="small muted" style={{ margin: '0 0 8px' }}>
                  {managed.used} of {managed.quota} managed actions used this month
                </p>
              )}
              <button
                className="btn btn-sm btn-danger"
                disabled={busy === 'managed-disconnect'}
                onClick={() => void disconnectManaged()}
              >
                {busy === 'managed-disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          )}
        </div>

        {/* BYOK card */}
        <div
          role="radio"
          aria-checked={mode === 'byok'}
          data-testid="platform-mode-byok"
          data-active={mode === 'byok' ? 'true' : 'false'}
          tabIndex={0}
          className="card"
          style={{
            cursor: 'pointer',
            outline: mode === 'byok' ? '2px solid var(--accent, #2563eb)' : undefined,
            borderColor: mode === 'byok' ? 'var(--accent, #2563eb)' : undefined,
          }}
          onClick={() => void switchMode('byok')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void switchMode('byok');
            }
          }}
        >
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <strong>Use my own Composio key</strong>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span className="chip gray">Advanced</span>
              {mode === 'byok' && <span className="chip green">Active</span>}
            </span>
          </div>
          <p className="small muted">
            Bring your own Composio API key. Usage runs through your own Composio account and
            is not counted against your managed allowance.
          </p>

          {byokContent ? (
            <div
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {byokContent}
            </div>
          ) : mode === 'byok' ? (
            <div
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {byokConnected ? (
                <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <span className="chip green">connected</span>{' '}
                    <span className="small muted">key stored in the vault (never shown)</span>
                  </div>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busy === 'byok-disconnect'}
                    onClick={() => void disconnectByok()}
                  >
                    {busy === 'byok-disconnect' ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                </div>
              ) : (
                <div>
                  <div
                    className="card"
                    style={{ borderStyle: 'dashed', textAlign: 'center', padding: 24 }}
                  >
                    <p style={{ fontSize: 32, margin: '0 0 8px' }} aria-hidden="true">
                      🔌
                    </p>
                    <p>
                      <strong>Composio is not connected.</strong>
                    </p>
                    <p className="small muted">
                      Connect a Composio API key to give your bots access to 1,000+ external
                      apps. The key is stored in the encrypted vault and is never shown again.
                    </p>
                    <p className="small">
                      <a
                        href="https://dashboard.composio.dev"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Get a free API key
                      </a>{' '}
                      <span className="muted">
                        (dashboard.composio.dev → Settings → API Keys, PLATFORM mode)
                      </span>
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                    <input
                      className="input mono"
                      type="password"
                      autoComplete="off"
                      aria-label="Composio API key"
                      placeholder="paste Composio API key (ak_…)"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <button
                      className="btn btn-primary"
                      disabled={busy === 'byok-connect' || !apiKey.trim()}
                      onClick={() => void connectByok()}
                    >
                      {busy === 'byok-connect' ? 'Connecting…' : 'Connect'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="small muted">
              Switch to this mode to connect or disconnect your own Composio key.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default PlatformMode;
