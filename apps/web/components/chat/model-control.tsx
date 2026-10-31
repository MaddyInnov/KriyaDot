// SPDX-License-Identifier: Apache-2.0
// The ONE model control (chrome simplification, 2026-10-31): a quiet
// text-style "Provider · Model ▾" button at the composer's bottom-right,
// in the OpenCode / DeepSeek-Harness style. Its single popover carries
// everything the old header pill row + composer-footer selects held:
// provider-grouped models (checkmarked), the bot-default reset, the
// next-turn-only model, reasoning effort, sandbox/access mode, steering
// mode, and — in Universal mode — the placement pill (passed in as a
// node so its state stays owned by the chat page).
//
// The popover opens with a pinned "Search models…" filter: the backend
// serves LIVE model lists for liveModels providers (a linked OpenRouter
// account returns hundreds of models), so the list is filterable with
// keyboard navigation (↑/↓ + Enter), harness-style.

'use client';

import React, {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type QueueMode = 'interrupt' | 'queue';
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ModelControlProvider {
  id: string;
  name: string;
  configured: boolean;
  models: { id: string; name: string }[];
}

/** One selectable row in the popover's flattened, filter-aware order. */
type FlatEntry =
  | { kind: 'default'; key: string }
  | { kind: 'model'; key: string; providerId: string; modelId: string };

interface ModelControlProps {
  providers: ModelControlProvider[];
  providerId: string;
  /** '' = the bot's own provider/model (no session override). */
  modelId: string;
  /** Label shown when modelId is '' (the bot's default model name). */
  botDefaultLabel: string;
  onSelectModel: (providerId: string, modelId: string) => void;
  onSelectBotDefault: () => void;
  /** Next-turn-only model override ('' = session model). */
  turnModel: string;
  onTurnModelChange: (modelId: string) => void;
  sandboxMode: SandboxMode;
  onSandboxChange: (mode: SandboxMode) => void;
  reasoningEffort: ReasoningEffort;
  onEffortChange: (effort: ReasoningEffort) => void;
  queueMode: QueueMode;
  onQueueModeChange: (mode: QueueMode) => void;
  /** Universal-mode placement pill (optional). */
  placementNode?: ReactNode;
  disabled?: boolean;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="mc-seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`mc-seg-opt${o.value === value ? ' active' : ''}`}
          aria-pressed={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ModelControl(props: ModelControlProps) {
  const {
    providers,
    providerId,
    modelId,
    botDefaultLabel,
    onSelectModel,
    onSelectBotDefault,
    turnModel,
    onTurnModelChange,
    sandboxMode,
    onSandboxChange,
    reasoningEffort,
    onEffortChange,
    queueMode,
    onQueueModeChange,
    placementNode,
    disabled,
  } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /** Latest flattened row order, mirrored for the open effect below. */
  const flatRef = useRef<FlatEntry[]>([]);

  // Close on outside click / Escape (Escape returns focus to the control).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  // On open: focus the search box and highlight the current selection.
  // On close: clear the search so the next open starts from the full list.
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const currentIdx = flatRef.current.findIndex(
      (e) =>
        (e.kind === 'default' && modelId === '') ||
        (e.kind === 'model' && e.providerId === providerId && e.modelId === modelId),
    );
    setHighlight(currentIdx >= 0 ? currentIdx : 0);
    searchRef.current?.focus();
  }, [open ]);

  const currentProvider = providers.find((p) => p.id === providerId);
  const providerLabel = currentProvider?.name ?? providerId ?? 'Provider';
  const modelLabel = modelId
    ? (currentProvider?.models.find((m) => m.id === modelId)?.name ?? modelId)
    : botDefaultLabel;

  // --- Search / filter ---------------------------------------------------
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const matchesText = (text: string) => text.toLowerCase().includes(q);
  const botDefaultVisible =
    !searching || matchesText('Bot default') || matchesText(botDefaultLabel);
  const visibleGroups = providers
    .map((p) => {
      // A provider-name hit keeps its whole model list; otherwise models
      // match on their own name/id.
      const providerHit = matchesText(p.name) || matchesText(p.id);
      return {
        provider: p,
        models: searching
          ? p.models.filter((m) => providerHit || matchesText(m.name) || matchesText(m.id))
          : p.models,
      };
    })
    // Groups with no visible models disappear — except the unfiltered
    // "No models listed" note for providers that genuinely list none.
    .filter((g) => g.models.length > 0 || (!searching && g.provider.models.length === 0));

  const flat: FlatEntry[] = [];
  if (botDefaultVisible) flat.push({ kind: 'default', key: 'default' });
  for (const g of visibleGroups) {
    for (const m of g.models) {
      flat.push({
        kind: 'model',
        key: `${g.provider.id}::${m.id}`,
        providerId: g.provider.id,
        modelId: m.id,
      });
    }
  }
  flatRef.current = flat;
  const indexByKey = new Map(flat.map((e, i) => [e.key, i] as const));
  /** Highlight clamped into the current (possibly filtered) range. */
  const hl = flat.length === 0 ? -1 : Math.min(Math.max(highlight, 0), flat.length - 1);

  const choose = (entry: FlatEntry) => {
    setOpen(false);
    if (entry.kind === 'default') onSelectBotDefault();
    else onSelectModel(entry.providerId, entry.modelId);
  };

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setHighlight(Math.min(Math.max(hl + delta, 0), flat.length - 1));
    } else if (e.key === 'Enter') {
      const entry = hl >= 0 ? flat[hl] : undefined;
      if (entry) {
        e.preventDefault();
        choose(entry);
      }
    }
  };

  // Keep the keyboard-highlighted row scrolled into view.
  useEffect(() => {
    if (!open || hl < 0) return;
    const el = popRef.current?.querySelector(`#mc-opt-${hl}`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [open, hl, searching ]);

  return (
    <div className="model-control" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="model-control-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        title="Provider · model · effort · access — applies to the next message"
      >
        <span className="model-control-glyph" aria-hidden="true">◈</span>
        <span className="model-control-label">
          {providerLabel} · {modelLabel}
        </span>
        <span className="model-control-chevron" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="model-control-pop" role="dialog" aria-label="Model and run options" ref={popRef}>
          <div className="mc-search">
            <input
              ref={searchRef}
              className="mc-search-input"
              type="text"
              value={query}
              placeholder="Search models…"
              aria-label="Search models"
              aria-activedescendant={hl >= 0 ? `mc-opt-${hl}` : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          <div className="mc-section">
            <div className="mc-heading">Model</div>
            {botDefaultVisible && (
              <button
                type="button"
                id={`mc-opt-${indexByKey.get('default')}`}
                className={`mc-row${modelId === '' ? ' current' : ''}${hl === indexByKey.get('default') ? ' highlighted' : ''}`}
                onMouseEnter={() => setHighlight(indexByKey.get('default') ?? 0)}
                onClick={() => choose({ kind: 'default', key: 'default' })}
              >
                <span className="mc-row-name">Bot default</span>
                <span className="mc-row-sub">{botDefaultLabel}</span>
                {modelId === '' && <span className="mc-check" aria-hidden="true">✓</span>}
              </button>
            )}
            {visibleGroups.map((g) => (
              <div key={g.provider.id} className="mc-group">
                <div className="mc-group-name">
                  {g.provider.name}
                  {!g.provider.configured && <span className="mc-nokey">no key</span>}
                </div>
                {g.models.map((m) => {
                  const current = g.provider.id === providerId && m.id === modelId;
                  const idx = indexByKey.get(`${g.provider.id}::${m.id}`) ?? -1;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      id={`mc-opt-${idx}`}
                      className={`mc-row${current ? ' current' : ''}${hl === idx ? ' highlighted' : ''}`}
                      aria-pressed={current}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() =>
                        choose({
                          kind: 'model',
                          key: `${g.provider.id}::${m.id}`,
                          providerId: g.provider.id,
                          modelId: m.id,
                        })
                      }
                    >
                      <span className="mc-row-name">{m.name}</span>
                      {current && <span className="mc-check" aria-hidden="true">✓</span>}
                    </button>
                  );
                })}
                {g.provider.models.length === 0 && <div className="mc-empty">No models listed</div>}
              </div>
            ))}
            {searching && flat.length === 0 && (
              <div className="mc-empty">No models match “{query.trim()}”</div>
            )}
          </div>

          {!searching && (
            <>
          <div className="mc-section">
            <div className="mc-heading">Next turn only</div>
            <select
              className="mc-select"
              value={turnModel}
              aria-label="Model for next turn only"
              title="Model for the NEXT turn only — after sending, the session model applies again"
              onChange={(e) => onTurnModelChange(e.target.value)}
            >
              <option value="">Session model</option>
              {(currentProvider?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          <div className="mc-section">
            <div className="mc-heading">Effort</div>
            <Segmented<ReasoningEffort>
              value={reasoningEffort}
              onChange={onEffortChange}
              ariaLabel="Reasoning effort"
              options={[
                { value: 'low', label: 'Low', title: 'Fast, light reasoning' },
                { value: 'medium', label: 'Med', title: 'Balanced reasoning' },
                { value: 'high', label: 'High', title: 'Thorough reasoning' },
              ]}
            />
          </div>

          <div className="mc-section">
            <div className="mc-heading">Access</div>
            <Segmented<SandboxMode>
              value={sandboxMode}
              onChange={onSandboxChange}
              ariaLabel="Sandbox mode"
              options={[
                { value: 'workspace-write', label: 'Workspace', title: 'Workspace-write: the default cage' },
                { value: 'read-only', label: 'Read-only', title: 'Read-only: writes and exec blocked' },
                { value: 'danger-full-access', label: 'Full access', title: 'Danger: lifts the cage (approvals still apply)' },
              ]}
            />
          </div>

          <div className="mc-section">
            <div className="mc-heading">Steering</div>
            <Segmented<QueueMode>
              value={queueMode}
              onChange={onQueueModeChange}
              ariaLabel="Steering mode"
              options={[
                { value: 'interrupt', label: 'Interrupt', title: 'A new message aborts the running turn' },
                { value: 'queue', label: 'Queue', title: 'A new message waits for the turn boundary' },
              ]}
            />
          </div>

          {placementNode && (
            <div className="mc-section">
              <div className="mc-heading">Runs on</div>
              {placementNode}
            </div>
          )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
