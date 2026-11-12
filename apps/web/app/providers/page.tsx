// SPDX-License-Identifier: Apache-2.0
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  cancelCliLogin,
  clearBridgeCliPath,
  connectBridge,
  disconnectBridge,
  getCliAuthStatus,
  getModelsCatalogInfo,
  getProviders,
  pollCliLogin,
  refreshModelsCatalog,
  removeProviderKey,
  saveProviderKey,
  setBridgeCliPath,
  startCliLogin,
  submitCliLoginCode,
} from '../../lib/api';
import type { CliLoginStatus, ModelsCatalogInfo, ProviderInfo, RateLimitSnapshot } from '../../lib/api';
import { formatResetIn, formatTokens } from '../../lib/usage';
import { ChannelsPanel } from '../../components/channels/channels-panel';
import { KEYLESS_LANE_FALLBACKS, keylessLaneFor } from '../../lib/octomind-web';
import { KeySuggestionCard } from '../../components/key-suggestion-card';

/**
 * Quota line for one provider, e.g. "28/30 req remaining · 1.8M/2M tokens ·
 * resets in 42s". Renders "—" when the provider sent no rate-limit headers.
 */
function RateLimitLine({ rateLimit }: { rateLimit: RateLimitSnapshot | null }) {
  if (!rateLimit) return <p className="small muted">Quota: —</p>;
  const { remainingRequests, limitRequests, remainingTokens, limitTokens, resetAt } = rateLimit;
  const hasAny =
    remainingRequests !== undefined ||
    limitRequests !== undefined ||
    remainingTokens !== undefined ||
    limitTokens !== undefined;
  if (!hasAny) return <p className="small muted">Quota: —</p>;

  const low =
    (remainingRequests !== undefined &&
      limitRequests !== undefined &&
      limitRequests > 0 &&
      remainingRequests / limitRequests < 0.25) ||
    (remainingRequests !== undefined && limitRequests === undefined && remainingRequests <= 5);

  const parts: string[] = [];
  if (remainingRequests !== undefined || limitRequests !== undefined) {
    parts.push(`${remainingRequests ?? '?'}/${limitRequests ?? '?'} req remaining`);
  }
  if (remainingTokens !== undefined || limitTokens !== undefined) {
    const rem = remainingTokens !== undefined ? formatTokens(remainingTokens) : '?';
    const lim = limitTokens !== undefined ? formatTokens(limitTokens) : '?';
    parts.push(`${rem}/${lim} tokens remaining`);
  }
  const reset = formatResetIn(resetAt);
  return (
    <p className="small muted">
      Quota: {parts.join(' · ')}
      {reset && ` · ${reset}`}{' '}
      {low && <span className="chip amber">low</span>}
    </p>
  );
}

/** Display names + terminal sign-in commands per bridge CLI. */
const CLI_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode CLI',
};

const CLI_SIGNIN_COMMANDS: Record<string, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
  opencode: 'opencode auth login',
};

function cliLabelFor(bridge?: string): string {
  return (bridge && CLI_LABELS[bridge]) || 'CLI';
}

function BridgeCard({
  p,
  models,
  freeOnly,
  saving,
  authStatus,
  onConnect,
  onDisconnect,
  onSignIn,
  onSaveCliPath,
  onClearCliPath,
}: {
  p: ProviderInfo;
  /** Model ids to display (already filtered by the "Free only" toggle). */
  models: { id: string; free?: boolean }[];
  freeOnly: boolean;
  saving: string;
  /** In-app CLI sign-in status (undefined while loading). */
  authStatus?: CliLoginStatus;
  onConnect: (p: ProviderInfo) => void;
  onDisconnect: (p: ProviderInfo) => void;
  onSignIn: (p: ProviderInfo) => void;
  onSaveCliPath: (p: ProviderInfo, path: string) => void;
  onClearCliPath: (p: ProviderInfo) => void;
}) {
  const cliLabel = cliLabelFor(p.bridge);
  const signedIn = authStatus?.signedIn === true;
  // A8: pinned CLI path draft, seeded from the saved pin. Kept in sync
  // when the saved value changes underneath (save/clear round-trips).
  const [cliPathDraft, setCliPathDraft] = useState(p.cliPath ?? '');
  useEffect(() => {
    setCliPathDraft(p.cliPath ?? '');
  }, [p.cliPath]);
  return (
    <div className="card">
      <div className="row-between">
        <div>
          <strong>{p.name}</strong>{' '}
          <span className={`chip ${p.connected ? 'green' : 'gray'}`}>
            {p.connected ? 'connected' : 'not connected'}
          </span>{' '}
          {authStatus && (
            <span className={`chip ${signedIn ? 'green' : 'amber'}`} title={authStatus.accountHint ?? (signedIn ? 'Signed in' : 'Not signed in')}>
              {signedIn ? `signed in${authStatus.accountHint ? ` as ${authStatus.accountHint}` : ''}` : 'not signed in'}
            </span>
          )}
        </div>
        <span className="small muted mono">{p.id}</span>
      </div>
      <p className="small muted">
        {models.length > 0
          ? `Models: ${models.map((m) => modelLabel(m.id, m.free)).join(', ')}`
          : freeOnly
            ? 'No free models on this provider.'
            : 'No catalog models.'}
      </p>
      <RateLimitLine rateLimit={p.rateLimit} />
      <div className="warn-box" style={{ marginTop: 8 }}>
        <strong>Use your {cliLabel} login — no API key needed.</strong>
        <br />
        Connecting lets this app read the token your {cliLabel} already stores on this
        machine, only at the moment you chat. The token is kept in memory, never
        saved to disk, never logged, and never sent anywhere except the model
        provider. Disconnecting (or restarting the app) drops it immediately.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {!p.connected ? (
          <button
            className="btn btn-primary btn-sm"
            disabled={saving === p.id}
            onClick={() => onConnect(p)}
          >
            {saving === p.id ? 'Connecting…' : `Connect ${cliLabel} login`}
          </button>
        ) : (
          <button
            className="btn btn-danger btn-sm"
            disabled={saving === p.id}
            onClick={() => onDisconnect(p)}
          >
            {saving === p.id ? 'Disconnecting…' : 'Disconnect'}
          </button>
        )}
        {authStatus && !signedIn && authStatus.cliPresent && (
          <button className="btn btn-sm" onClick={() => onSignIn(p)} title="Start the CLI's login in your browser — no tokens to paste">
            Sign in to {cliLabel}
          </button>
        )}
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label className="label" htmlFor={`cli-path-${p.id}`}>
          CLI path
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id={`cli-path-${p.id}`}
            className="input mono"
            autoComplete="off"
            placeholder="Leave empty to auto-detect"
            value={cliPathDraft}
            onChange={(e) => setCliPathDraft(e.target.value)}
          />
          <button
            className="btn btn-sm"
            disabled={saving === p.id || cliPathDraft.trim() === (p.cliPath ?? '')}
            onClick={() => onSaveCliPath(p, cliPathDraft.trim())}
          >
            Save path
          </button>
          {(p.cliPath ?? '') !== '' && (
            <button
              className="btn btn-sm"
              disabled={saving === p.id}
              onClick={() => onClearCliPath(p)}
            >
              Clear
            </button>
          )}
        </div>
        <p className="small muted" style={{ marginTop: 4 }}>
          Leave empty to auto-detect. A pinned path is only a location hint — the program
          there is still checked to be the real {cliLabel} before anything runs it.
        </p>
      </div>
      {p.cliPathError && (
        <div className="warn-box" style={{ marginTop: 8 }}>
          {p.cliPathError}
        </div>
      )}
      {authStatus?.namesakeWarning && (
        <div className="warn-box" style={{ marginTop: 8 }}>
          {authStatus.namesakeWarning}
        </div>
      )}
      {authStatus && !signedIn && !authStatus.namesakeWarning && (
        <p className="small muted" style={{ marginTop: 8 }}>
          {authStatus.cliPresent
            ? 'Not signed in. Sign in here (browser OAuth — nothing to paste) or once in your terminal.'
            : `${cliLabel} was detected via a credential file but the executable is not on PATH.`}
        </p>
      )}
    </div>
  );
}

/** In-app CLI sign-in modal: shows the OAuth URL, polls for completion. */
function CliSignInModal({
  cliLabel,
  cliId,
  onClose,
  onDone,
}: {
  cliLabel: string;
  cliId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'done' | 'failed'>('starting');
  const [url, setUrl] = useState('');
  const [reason, setReason] = useState('');
  const [loginId, setLoginId] = useState('');
  // Paste-code flows (Claude Code): the browser page shows a one-time
  // code after authorizing; the CLI waits to receive it via stdin.
  const [acceptsCode, setAcceptsCode] = useState(false);
  const [code, setCode] = useState('');
  const [codeState, setCodeState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      try {
        const started = await startCliLogin(cliId);
        if (cancelled) {
          void cancelCliLogin(cliId, started.loginId).catch(() => undefined);
          return;
        }
        setLoginId(started.loginId);
        setUrl(started.url);
        setAcceptsCode(started.acceptsCode === true);
        setPhase('waiting');
        timer = setInterval(async () => {
          try {
            const st = await pollCliLogin(cliId, started.loginId);
            if (st.status === 'done') {
              if (timer) clearInterval(timer);
              setPhase('done');
              onDone();
            } else if (st.status === 'failed' || st.status === 'cancelled') {
              if (timer) clearInterval(timer);
              setReason(st.reason ?? 'Login did not complete.');
              setPhase('failed');
            }
          } catch (err) {
            if (timer) clearInterval(timer);
            setReason(err instanceof Error ? err.message : String(err));
            setPhase('failed');
          }
        }, 3000);
      } catch (err) {
        if (!cancelled) {
          setReason(err instanceof Error ? err.message : String(err));
          setPhase('failed');
        }
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cliId]);

  const cancel = async () => {
    if (loginId) {
      try {
        await cancelCliLogin(cliId, loginId);
      } catch {
        // best-effort
      }
    }
    onClose();
  };

  const submitCode = async () => {
    if (!loginId || !code.trim()) return;
    setCodeState('sending');
    try {
      await submitCliLoginCode(cliId, loginId, code.trim());
      setCode('');
      setCodeState('sent');
    } catch {
      setCodeState('error');
    }
  };

  const signInCommand = CLI_SIGNIN_COMMANDS[cliId] ?? cliId;

  return (
    <div className="modal-overlay" onClick={cancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h3>Sign in to {cliLabel}</h3>
        {phase === 'starting' && <p className="small muted">Starting the {cliLabel} login…</p>}
        {phase === 'failed' && (
          <>
            <div className="error-box">{reason}</div>
            <p className="small muted">
              Fallback: sign in once in your terminal (<span className="mono">{signInCommand}</span>),
              then use “Connect” above.
            </p>
          </>
        )}
        {(phase === 'waiting' || phase === 'done') && (
          <>
            <p className="small">
              {acceptsCode
                ? 'Open the login page and authorize. The page then shows a one-time code — paste it below and this sign-in completes.'
                : 'Complete the sign-in in your browser. Nothing to paste — this page detects when the login finishes.'}
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => window.open(url, '_blank', 'noopener')}
              >
                Open login page
              </button>
              <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(url).catch(() => undefined)}>
                Copy URL
              </button>
            </div>
            <p className="small muted mono" style={{ marginTop: 8, wordBreak: 'break-all' }}>{url}</p>
            {acceptsCode && phase === 'waiting' && (
              <div style={{ marginTop: 10 }}>
                <label className="label" htmlFor="cli-login-code">
                  Code from the login page
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    id="cli-login-code"
                    className="input mono"
                    autoComplete="off"
                    placeholder="Paste the code here"
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value);
                      setCodeState('idle');
                    }}
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={!code.trim() || codeState === 'sending'}
                    onClick={() => void submitCode()}
                  >
                    {codeState === 'sending' ? 'Sending…' : 'Submit code'}
                  </button>
                </div>
                {codeState === 'sent' && (
                  <p className="small muted" style={{ marginTop: 6 }}>
                    Code sent — finishing the sign-in…
                  </p>
                )}
                {codeState === 'error' && (
                  <p className="small" style={{ marginTop: 6, color: '#b91c1c' }}>
                    That code could not be sent. Check it and try again, or use the terminal
                    fallback below.
                  </p>
                )}
                <p className="small muted" style={{ marginTop: 6 }}>
                  Terminal fallback: run <span className="mono">{signInCommand}</span> in your
                  terminal instead, then use “Connect” above.
                </p>
              </div>
            )}
            {phase === 'waiting' ? (
              <p className="small muted" style={{ marginTop: 8 }}>
                <span className="spinner" /> Waiting for you to finish signing in…
              </p>
            ) : (
              <div className="card" style={{ borderColor: '#bbf7d0', background: '#f0fdf4', marginTop: 8 }}>
                Signed in. You can now Connect {cliLabel} above.
              </div>
            )}
          </>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
          {phase === 'done' ? (
            <button className="btn btn-primary btn-sm" onClick={onClose}>Done</button>
          ) : (
            <button className="btn btn-sm" onClick={cancel}>Cancel</button>
          )}
        </div>
      </div>
    </div>
  );
}

function loadFreeOnly(): boolean {
  try {
    return localStorage.getItem('mvp:freeOnly') === '1';
  } catch {
    return false;
  }
}

function modelLabel(id: string, free?: boolean): string {
  return free ? `${id} (free)` : id;
}

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState<string>('');
  // "Free only" toggle: filters the model lists below to free models. Default off.
  const [freeOnly, setFreeOnly] = useState<boolean>(() => loadFreeOnly());
  // Per-provider form state.
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [headers, setHeaders] = useState<Record<string, string>>({});
  // Templated presets (Azure OpenAI, Cloudflare): endpoint field values,
  // keyed by provider id then field name. Stored values are never read
  // back (keys are write-only), so a blank field on a configured provider
  // means "keep the saved value".
  const [templateVals, setTemplateVals] = useState<Record<string, Record<string, string>>>({});
  // In-app CLI sign-in status (OpenMausBot parity).
  const [cliAuth, setCliAuth] = useState<CliLoginStatus[]>([]);
  const [signInFor, setSignInFor] = useState<ProviderInfo | null>(null);
  // API keys picker: search text + the provider whose config dialog is
  // open (42 full cards were an endless scroll — the list is compact now
  // and the existing form opens in a dialog on select).
  const [keySearch, setKeySearch] = useState('');
  const [keyDialogId, setKeyDialogId] = useState<string | null>(null);
  // models.dev catalog cache (OpenMausBot parity P1 #23): manual refresh only.
  const [catalogInfo, setCatalogInfo] = useState<ModelsCatalogInfo | null>(null);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);

  const toggleFreeOnly = (on: boolean) => {
    setFreeOnly(on);
    try {
      localStorage.setItem('mvp:freeOnly', on ? '1' : '0');
    } catch {
      // ignore
    }
  };

  /** Models shown on a provider card, honouring the "Free only" toggle. */
  const shownModels = (p: ProviderInfo) =>
    freeOnly ? p.models.filter((m) => m.free) : p.models;

  const refresh = useCallback(async () => {
    try {
      setProviders(await getProviders());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    try {
      const auth = await getCliAuthStatus();
      setCliAuth(auth.clis);
    } catch {
      // sign-in status is best-effort; the page works without it
    }
    try {
      setCatalogInfo(await getModelsCatalogInfo());
    } catch {
      // catalog info is best-effort
    }
  }, []);

  const refreshCatalog = async () => {
    setRefreshingCatalog(true);
    setError('');
    try {
      const info = await refreshModelsCatalog();
      setCatalogInfo(info);
      setNotice(`Model catalog refreshed — ${info.modelCount} models from ${info.providerCount} providers.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingCatalog(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Returns true when the key was saved (the config dialog closes then). */
  const save = async (p: ProviderInfo): Promise<boolean> => {
    const apiKey = (keys[p.id] ?? '').trim();
    if (!apiKey) {
      setError('API key is required.');
      return false;
    }
    let parsedHeaders: Record<string, string> | undefined;
    const rawHeaders = (headers[p.id] ?? '').trim();
    if (rawHeaders) {
      try {
        const parsed = JSON.parse(rawHeaders) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('must be a JSON object');
        }
        parsedHeaders = parsed as Record<string, string>;
      } catch (err) {
        setError(`Invalid headers JSON: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }
    // Templated presets: every endpoint field is required on first save;
    // on re-save a blank field keeps the stored value (the API enforces
    // the same rule and names any field that is missing entirely).
    let templateValues: Record<string, string> | undefined;
    if (p.templateFields && p.templateFields.length > 0) {
      templateValues = {};
      for (const field of p.templateFields) {
        const v = (templateVals[p.id]?.[field.name] ?? '').trim();
        if (v) templateValues[field.name] = v;
        else if (!p.configured) {
          setError(`${p.name} needs its ${field.label} to build the endpoint — enter it together with the API key.`);
          return false;
        }
      }
      if (Object.keys(templateValues).length === 0) templateValues = undefined;
    }
    setSaving(p.id);
    setError('');
    setNotice('');
    try {
      await saveProviderKey(p.id, apiKey, (baseUrls[p.id] ?? '').trim() || undefined, parsedHeaders, templateValues);
      setKeys((s) => ({ ...s, [p.id]: '' }));
      setNotice(`Key saved for ${p.name}.`);
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving('');
    }
  };

  /** Returns true when the key was removed (the config dialog closes then). */
  const remove = async (p: ProviderInfo): Promise<boolean> => {
    setSaving(p.id);
    setError('');
    setNotice('');
    try {
      await removeProviderKey(p.id);
      setNotice(`Key removed for ${p.name}.`);
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving('');
    }
  };

  const connect = async (p: ProviderInfo) => {
    if (!p.bridge) return;
    setSaving(p.id);
    setError('');
    setNotice('');
    try {
      await connectBridge(p.bridge);
      setNotice(`${p.name} connected — using your CLI login.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving('');
    }
  };

  const disconnect = async (p: ProviderInfo) => {
    if (!p.bridge) return;
    setSaving(p.id);
    setError('');
    setNotice('');
    try {
      await disconnectBridge(p.bridge);
      setNotice(`${p.name} disconnected.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving('');
    }
  };

  const saveCliPath = async (p: ProviderInfo, path: string) => {
    if (!p.bridge) return;
    setSaving(p.id);
    setError('');
    setNotice('');
    try {
      const status = await setBridgeCliPath(p.bridge, path);
      if (status.cliPathError) {
        setError(status.cliPathError);
      } else {
        setNotice(
          status.cliPath
            ? `${p.name} CLI path pinned to ${status.cliPath}.`
            : `${p.name} CLI path cleared — auto-detect is back on.`,
        );
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving('');
    }
  };

  const clearCliPath = async (p: ProviderInfo) => {
    if (!p.bridge) return;
    setSaving(p.id);
    setError('');
    setNotice('');
    try {
      await clearBridgeCliPath(p.bridge);
      setNotice(`${p.name} CLI path cleared — auto-detect is back on.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving('');
    }
  };

  // Bridge providers (Claude/Codex subscriptions) are only surfaced when the
  // CLI or its credential file is detected on this machine.
  // Local providers (Ollama) need no key — they get their own section.
  const localProviders = providers.filter((p) => p.local);
  const keyProviders = providers.filter((p) => !p.bridge && !p.local);
  // A8: a bridge with a pinned CLI path stays visible even when
  // auto-detection finds nothing — the pin (and its error) must be fixable.
  const bridgeProviders = providers.filter((p) => p.bridge && (p.detected || p.cliPath));

  // API keys picker derivations: configured providers first (they're the
  // ones a returning user is looking for), then alphabetical; the search
  // filters by display name or provider id.
  const keyQuery = keySearch.trim().toLowerCase();
  const sortedKeyProviders = [...keyProviders].sort(
    (a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name),
  );
  const filteredKeyProviders = keyQuery
    ? sortedKeyProviders.filter(
        (p) => p.name.toLowerCase().includes(keyQuery) || p.id.toLowerCase().includes(keyQuery),
      )
    : sortedKeyProviders;
  const configuredKeyCount = keyProviders.filter((p) => p.configured).length;
  const keyDialogProvider = keyDialogId
    ? (providers.find((p) => p.id === keyDialogId) ?? null)
    : null;

  /**
   * The per-provider key configuration form — the exact fields the full
   * cards used to render inline for all 42 providers (models line, notes,
   * template fields, API key, base URL, headers, Save/Remove). It now
   * renders once, inside the dialog of the provider the user selected.
   * Save/Remove close the dialog on success via onDone.
   */
  const renderKeyForm = (p: ProviderInfo, onDone?: () => void) => (
    <>
      <p className="small muted">
        {shownModels(p).length > 0
          ? `Models: ${shownModels(p).map((m) => modelLabel(m.id, m.free)).join(', ')}`
          : freeOnly
            ? 'No free models on this provider.'
            : 'No catalog models.'}
      </p>
      {p.notes && <p className="small muted">{p.notes}</p>}
      {keylessLaneFor(p) && (
        <p className="small muted">
          <strong>{keylessLaneFor(p)!.label}.</strong> {keylessLaneFor(p)!.note}
          {keylessLaneFor(p)!.byokOnly && ' Pollinations is shown only as a bring-your-own-key provider — paste your own key below.'}
        </p>
      )}
      <RateLimitLine rateLimit={p.rateLimit} />
      {p.templateFields && p.templateFields.length > 0 && (
        <>
          <div className="grid-2">
            {p.templateFields.map((field) => (
              <div className="field" key={field.name}>
                <label className="label" htmlFor={`tpl-${p.id}-${field.name}`}>
                  {field.label}
                </label>
                <input
                  id={`tpl-${p.id}-${field.name}`}
                  className="input mono"
                  autoComplete="off"
                  placeholder={p.configured ? '•••••••• (saved)' : field.hint}
                  value={templateVals[p.id]?.[field.name] ?? ''}
                  onChange={(e) =>
                    setTemplateVals((s) => ({
                      ...s,
                      [p.id]: { ...(s[p.id] ?? {}), [field.name]: e.target.value },
                    }))
                  }
                />
              </div>
            ))}
          </div>
          {p.baseUrlTemplate && (
            <p className="small muted mono" style={{ marginTop: 4 }}>
              Endpoint: {p.baseUrlTemplate}
            </p>
          )}
        </>
      )}
      <div className="grid-2">
        <div className="field">
          <label className="label" htmlFor={`key-${p.id}`}>
            API key
          </label>
          <input
            id={`key-${p.id}`}
            className="input mono"
            type="password"
            autoComplete="off"
            placeholder={p.configured ? '•••••••• (saved)' : 'paste key'}
            value={keys[p.id] ?? ''}
            onChange={(e) => setKeys((s) => ({ ...s, [p.id]: e.target.value }))}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`base-${p.id}`}>
            Base URL override (optional)
          </label>
          <input
            id={`base-${p.id}`}
            className="input mono"
            placeholder="https://…"
            value={baseUrls[p.id] ?? ''}
            onChange={(e) => setBaseUrls((s) => ({ ...s, [p.id]: e.target.value }))}
          />
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor={`headers-${p.id}`}>
          Extra headers JSON (optional, for custom endpoints)
        </label>
        <textarea
          id={`headers-${p.id}`}
          className="textarea"
          rows={2}
          placeholder='{"X-Custom": "value"}'
          value={headers[p.id] ?? ''}
          onChange={(e) => setHeaders((s) => ({ ...s, [p.id]: e.target.value }))}
        />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-primary btn-sm"
          disabled={saving === p.id}
          onClick={() => {
            void (async () => {
              if (await save(p)) onDone?.();
            })();
          }}
        >
          {saving === p.id ? 'Saving…' : 'Save'}
        </button>
        {p.configured && (
          <button
            className="btn btn-danger btn-sm"
            disabled={saving === p.id}
            onClick={() => {
              void (async () => {
                if (await remove(p)) onDone?.();
              })();
            }}
          >
            Remove
          </button>
        )}
      </div>
    </>
  );

  return (
    <div>
      <h1 className="page-title">Providers</h1>
      <p className="page-sub">Bring your own API keys. The agent uses them for chat completions.</p>
      <div className="warn-box">
        <strong>Key storage:</strong> keys are stored only in environment variables or the local
        file <span className="mono">providers.local.json</span> (mode 0600) next to the API&apos;s
        data directory. They are never logged and never returned by the API.
      </div>
      <KeySuggestionCard />
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row-between">
          <div>
            <strong>Model catalog</strong>
            <p className="small muted" style={{ margin: '4px 0 0' }}>
              {catalogInfo
                ? `Updated ${catalogInfo.ageLabel} · ${catalogInfo.modelCount} models from ${catalogInfo.providerCount} providers (models.dev).`
                : 'Model catalog info unavailable.'}
              <br />
              Refresh is manual only — the app never re-fetches on its own.
            </p>
          </div>
          <button className="btn btn-sm" disabled={refreshingCatalog} onClick={() => void refreshCatalog()}>
            {refreshingCatalog ? 'Refreshing…' : 'Refresh catalog'}
          </button>
        </div>
      </div>
      <div className="row-between" style={{ marginTop: 12 }}>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={freeOnly}
            onChange={(e) => toggleFreeOnly(e.target.checked)}
          />
          <strong>Free only</strong>
          <span className="muted">— show only models that cost $0 to call</span>
        </label>
        {freeOnly && (
          <span className="chip green">free models only</span>
        )}
      </div>
      {error && <div className="error-box">{error}</div>}
      {notice && (
        <div className="card" style={{ borderColor: '#bbf7d0', background: '#f0fdf4' }}>
          {notice}
        </div>
      )}

      {bridgeProviders.length > 0 && (
        <>
          <h2 className="page-sub" style={{ marginTop: 24 }}>
            Subscription logins
          </h2>
          <p className="small muted">
            Detected on this machine. Connect to run bots on your existing subscription —
            no API key needed.
          </p>
          {bridgeProviders.map((p) => (
            <BridgeCard
              key={p.id}
              p={p}
              models={shownModels(p)}
              freeOnly={freeOnly}
              saving={saving}
              authStatus={p.bridge ? cliAuth.find((c) => c.cliId === p.bridge) : undefined}
              onConnect={connect}
              onDisconnect={disconnect}
              onSignIn={(bp) => setSignInFor(bp)}
              onSaveCliPath={(bp, path) => void saveCliPath(bp, path)}
              onClearCliPath={(bp) => void clearCliPath(bp)}
            />
          ))}
        </>
      )}
      {signInFor?.bridge && (
        <CliSignInModal
          cliLabel={cliLabelFor(signInFor.bridge)}
          cliId={signInFor.bridge}
          onClose={() => setSignInFor(null)}
          onDone={() => {
            void refresh();
          }}
        />
      )}

      <h2 className="page-sub" style={{ marginTop: 24 }}>
        Free &amp; keyless lanes
      </h2>
      <p className="small muted">
        Ways to chat with no paid API key. Labels are honest about the trade-offs: local is
        guaranteed, shared lanes are rate-limited and best-effort. Lane metadata comes from the
        provider catalog when it exposes it; otherwise the built-in labels below apply.
      </p>
      {['ollama', 'ovh-anonymous', 'llm7-anonymous', 'aihorde', 'pollinations'].map((id) => {
        const lane = KEYLESS_LANE_FALLBACKS[id]!;
        const live = providers.find((p) => p.id === id);
        return (
          <div key={id} className="card">
            <div className="row-between">
              <div>
                <strong>{live?.name ?? id}</strong>{' '}
                {lane.byokOnly ? (
                  <span className="chip amber">bring your own key</span>
                ) : (
                  <span className="chip green">no key needed</span>
                )}{' '}
                {live ? (
                  <span className={`chip ${live.configured || lane.keyless ? 'green' : 'gray'}`}>
                    {lane.keyless ? 'keyless lane' : live.configured ? 'configured' : 'no key'}
                  </span>
                ) : (
                  <span className="chip gray">not in the current catalog</span>
                )}
              </div>
              <span className="small muted mono">{id}</span>
            </div>
            <p className="small muted">
              <strong>{lane.label}.</strong> {lane.note}
              {lane.byokOnly && ' Use the API key field on its provider card below — there is no anonymous Pollinations lane.'}
              {lane.chatOnly && ' Tool calls are not available on this lane.'}
            </p>
          </div>
        );
      })}

      <h2 className="page-sub" style={{ marginTop: 24 }}>
        Local providers
      </h2>
      <p className="small muted">
        Run on your own machine — no API key needed, ever. Models are read live
        from the local instance.
      </p>
      {localProviders.map((p) => (
        <div key={p.id} className="card">
          <div className="row-between">
            <div>
              <strong>{p.name}</strong>{' '}
              <span className="chip green">Local</span>{' '}
              <span className="chip gray">no key needed</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="small muted mono">{p.id}</span>
              <button
                className="btn btn-sm"
                disabled={saving === p.id}
                onClick={() => void refresh()}
                title="Re-read the model list from the local instance"
              >
                {saving === p.id ? 'Refreshing…' : '↻ Refresh models'}
              </button>
            </div>
          </div>
          <p className="small muted">
            {shownModels(p).length > 0
              ? `Models: ${shownModels(p).map((m) => modelLabel(m.id, m.free)).join(', ')}`
              : 'No models found — is Ollama running? Start it and pull a model, e.g. "ollama pull llama3.1".'}
          </p>
          {keylessLaneFor(p) && (
            <p className="small muted">
              <strong>{keylessLaneFor(p)!.label}.</strong> {keylessLaneFor(p)!.note}
            </p>
          )}
          <RateLimitLine rateLimit={p.rateLimit} />
        </div>
      ))}
      {localProviders.length === 0 && !error && <p className="muted">Loading…</p>}

      <h2 className="page-sub" style={{ marginTop: 24 }}>
        API keys
      </h2>
      <p className="small muted">
        {keyProviders.length} providers — {configuredKeyCount} with a key saved. Search, then
        select a provider to open its key settings.
      </p>
      <div className="field" style={{ maxWidth: 420 }}>
        <label className="label" htmlFor="provider-search">
          Search providers
        </label>
        <input
          id="provider-search"
          className="input"
          type="search"
          autoComplete="off"
          placeholder="Search by name or id — e.g. groq"
          value={keySearch}
          onChange={(e) => setKeySearch(e.target.value)}
        />
      </div>
      <div data-testid="provider-picker-list">
        {filteredKeyProviders.map((p) => (
          <div
            key={p.id}
            className="card"
            role="button"
            tabIndex={0}
            aria-label={`Configure ${p.name}`}
            style={{ cursor: 'pointer', padding: '10px 14px', marginBottom: 8 }}
            onClick={() => setKeyDialogId(p.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setKeyDialogId(p.id);
              }
            }}
          >
            <div className="row-between">
              <div>
                <strong>{p.name}</strong>{' '}
                <span className={`chip ${p.configured ? 'green' : 'gray'}`}>
                  {p.configured ? 'key set' : 'no key'}
                </span>
              </div>
              <span className="small muted mono">{p.id}</span>
            </div>
          </div>
        ))}
        {filteredKeyProviders.length === 0 && keyProviders.length > 0 && (
          <p className="muted">No providers match “{keySearch}”.</p>
        )}
      </div>
      {keyDialogProvider && (
        <div className="modal-overlay" onClick={() => setKeyDialogId(null)}>
          <div
            className="modal"
            role="dialog"
            aria-label={`Configure ${keyDialogProvider.name}`}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 640 }}
          >
            <div className="row-between">
              <h3 style={{ margin: 0 }}>{keyDialogProvider.name}</h3>
              <span className="small muted mono">{keyDialogProvider.id}</span>
            </div>
            {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
            {renderKeyForm(keyDialogProvider, () => setKeyDialogId(null))}
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={() => setKeyDialogId(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {providers.length === 0 && !error && <p className="muted">Loading providers…</p>}

      <ChannelsPanel />
    </div>
  );
}
