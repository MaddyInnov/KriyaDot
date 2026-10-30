// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * Settings → "Cloud sync & website" (Front Door spec Parts 2+4):
 *  - sync status: configured instance URL, last push/pull, pending
 *    outbox count, last error (GET /api/sync/status);
 *  - manual sync target: instance URL + link token (POST /api/sync/target);
 *  - link-token minting for another device/app (POST /api/sync/link-token,
 *    token shown ONCE);
 *  - website link: frontdoor URL + one-time code from the website + this
 *    instance's public URL (prefilled from cloud status when available)
 *    → POST /api/frontdoor/link; status from GET /api/frontdoor/status.
 *
 * Lives as a section on the Preferences (Settings) page, following its
 * card patterns.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  getFrontdoorStatus,
  getSyncStatus,
  postFrontdoorLink,
  postSyncLinkToken,
  postSyncTarget,
  type FrontdoorStatus,
  type SyncStatus,
} from '../../lib/frontdoor';
import { cloudStatus } from '../../lib/octomind-api';
import { mapCloudStatus } from '../../lib/octomind-web';

function fmtTs(ts?: string): string {
  if (!ts) return 'never';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export function CloudSyncPanel() {
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [frontdoor, setFrontdoor] = useState<FrontdoorStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  // Manual sync-target form.
  const [targetUrl, setTargetUrl] = useState('');
  const [targetToken, setTargetToken] = useState('');
  const [targetMsg, setTargetMsg] = useState('');
  const [targetError, setTargetError] = useState('');
  const [targetBusy, setTargetBusy] = useState(false);
  // Minted link token (shown once).
  const [mintedToken, setMintedToken] = useState('');
  const [mintError, setMintError] = useState('');
  const [mintBusy, setMintBusy] = useState(false);
  // Website link form.
  const [fdUrl, setFdUrl] = useState('');
  const [fdCode, setFdCode] = useState('');
  const [fdInstanceUrl, setFdInstanceUrl] = useState('');
  const [fdMsg, setFdMsg] = useState('');
  const [fdError, setFdError] = useState('');
  const [fdBusy, setFdBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([getSyncStatus(), getFrontdoorStatus()]);
      setSync(s);
      setFrontdoor(f);
      setLoadError('');
      if (s.instanceUrl) setTargetUrl((cur) => cur || s.instanceUrl || '');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
    // Prefill this instance's public URL from the cloud status when available.
    try {
      const raw = await cloudStatus();
      const view = mapCloudStatus(raw);
      if (view.publicUrl) {
        setFdInstanceUrl((cur) => cur || view.publicUrl || '');
      }
    } catch {
      // Cloud layer not connected — the field stays manually editable.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveTarget = async () => {
    setTargetBusy(true);
    setTargetError('');
    setTargetMsg('');
    try {
      await postSyncTarget({ instanceUrl: targetUrl.trim(), linkToken: targetToken.trim() });
      setTargetToken('');
      setTargetMsg('Sync target saved. Local history now syncs to your instance.');
      await refresh();
    } catch (err) {
      setTargetError(err instanceof Error ? err.message : String(err));
    } finally {
      setTargetBusy(false);
    }
  };

  const mintToken = async () => {
    setMintBusy(true);
    setMintError('');
    try {
      const res = await postSyncLinkToken();
      setMintedToken(res.token);
    } catch (err) {
      setMintError(err instanceof Error ? err.message : String(err));
    } finally {
      setMintBusy(false);
    }
  };

  const linkWebsite = async () => {
    setFdBusy(true);
    setFdError('');
    setFdMsg('');
    try {
      const res = await postFrontdoorLink({
        frontdoorUrl: fdUrl.trim(),
        code: fdCode.trim(),
        instanceUrl: fdInstanceUrl.trim(),
      });
      setFrontdoor(res);
      setFdCode('');
      setFdMsg('Linked. Your workspace now appears in your KriyaDot website account.');
      await refresh();
    } catch (err) {
      setFdError(err instanceof Error ? err.message : String(err));
    } finally {
      setFdBusy(false);
    }
  };

  return (
    <div data-testid="cloud-sync-panel">
      {loadError && <div className="error-box">{loadError}</div>}

      <h3 style={{ marginTop: 16 }}>Sync status</h3>
      {!sync ? (
        <p className="muted small">Loading sync status…</p>
      ) : sync.configured ? (
        <div className="small" style={{ display: 'grid', gap: 4 }}>
          <div>
            Instance: <span className="mono">{sync.instanceUrl ?? '—'}</span>
          </div>
          <div>Last push: {fmtTs(sync.lastPushAt)}</div>
          <div>Last pull: {fmtTs(sync.lastPullAt)}</div>
          <div>
            Pending outbox: {sync.pendingOutbox}
            {sync.pendingOutbox > 0 ? ' (queued — pushes on reconnect)' : ''}
          </div>
          {sync.lastError && (
            <div className="error-box" role="alert">
              Last sync error: {sync.lastError}
            </div>
          )}
        </div>
      ) : (
        <p className="muted small">
          No cloud instance connected — everything stays on this device. Connect your cloud (Workspace
          → Cloud) or set a sync target manually below.
        </p>
      )}

      <h3 style={{ marginTop: 20 }}>Sync target (manual)</h3>
      <p className="muted small">
        Point this app at your own instance directly: its URL plus a link token minted on that
        instance. Cloud deploy fills this in automatically; use this form to link by hand.
      </p>
      <div className="grid-2">
        <div className="field">
          <label className="label" htmlFor="sync-instance-url">Instance URL</label>
          <input
            id="sync-instance-url"
            className="input mono"
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="https://your-instance.example.com"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="sync-link-token">Link token</label>
          <input
            id="sync-link-token"
            className="input mono"
            type="password"
            value={targetToken}
            onChange={(e) => setTargetToken(e.target.value)}
            placeholder="token minted on your instance"
            autoComplete="off"
          />
        </div>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        disabled={targetBusy || !targetUrl.trim() || !targetToken.trim()}
        onClick={() => void saveTarget()}
      >
        {targetBusy ? 'Saving…' : 'Save sync target'}
      </button>
      {targetMsg && (
        <p className="small" role="status" style={{ marginTop: 8 }}>{targetMsg}</p>
      )}
      {targetError && (
        <div className="error-box" role="alert" style={{ marginTop: 8 }}>{targetError}</div>
      )}

      <h3 style={{ marginTop: 20 }}>Link another device or app</h3>
      <p className="muted small">
        Mint a link token here and paste it into the other device/app&apos;s sync-target form. The
        token is shown once — copy it now.
      </p>
      <button type="button" className="btn btn-sm" disabled={mintBusy} onClick={() => void mintToken()}>
        {mintBusy ? 'Minting…' : 'Mint link token'}
      </button>
      {mintedToken && (
        <p className="small" role="status" style={{ marginTop: 8 }}>
          Link token (shown once): <code className="mono">{mintedToken}</code>
        </p>
      )}
      {mintError && (
        <div className="error-box" role="alert" style={{ marginTop: 8 }}>{mintError}</div>
      )}

      <h3 style={{ marginTop: 20 }}>KriyaDot website account</h3>
      {frontdoor?.linked ? (
        <div className="small" style={{ display: 'grid', gap: 4 }} role="status">
          <div>
            ✓ Linked to <span className="mono">{frontdoor.frontdoorUrl ?? 'your website account'}</span>
          </div>
          {frontdoor.accountId && <div>Account: <span className="mono">{frontdoor.accountId}</span></div>}
          {frontdoor.workspaceId && <div>Workspace: <span className="mono">{frontdoor.workspaceId}</span></div>}
        </div>
      ) : (
        <>
          <p className="muted small">
            Link this instance to your KriyaDot website account so the website can launch you
            straight into your workspace. Generate a one-time link code on the website, then paste
            it here with this instance&apos;s public URL.
          </p>
          <div className="grid-2">
            <div className="field">
              <label className="label" htmlFor="fd-url">Website (front door) URL</label>
              <input
                id="fd-url"
                className="input mono"
                value={fdUrl}
                onChange={(e) => setFdUrl(e.target.value)}
                placeholder="https://kriyadot.example.com"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="fd-code">Link code from the website</label>
              <input
                id="fd-code"
                className="input mono"
                value={fdCode}
                onChange={(e) => setFdCode(e.target.value)}
                placeholder="one-time code"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="fd-instance-url">This instance&apos;s public URL</label>
              <input
                id="fd-instance-url"
                className="input mono"
                value={fdInstanceUrl}
                onChange={(e) => setFdInstanceUrl(e.target.value)}
                placeholder="https://your-instance.example.com"
                autoComplete="off"
              />
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={fdBusy || !fdUrl.trim() || !fdCode.trim() || !fdInstanceUrl.trim()}
            onClick={() => void linkWebsite()}
          >
            {fdBusy ? 'Linking…' : 'Link this instance'}
          </button>
          {fdMsg && (
            <p className="small" role="status" style={{ marginTop: 8 }}>{fdMsg}</p>
          )}
          {fdError && (
            <div className="error-box" role="alert" style={{ marginTop: 8 }}>{fdError}</div>
          )}
        </>
      )}
    </div>
  );
}
