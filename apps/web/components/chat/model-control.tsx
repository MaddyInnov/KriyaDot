// SPDX-License-Identifier: Apache-2.0
// The ONE model control (chrome simplification, 2026-10-31): a quiet
// text-style "Provider · Model ▾" button at the composer's bottom-right,
// in the OpenCode / DeepSeek-Harness style. Its single popover carries
// everything the old header pill row + composer-footer selects held:
// provider-grouped models (checkmarked), the bot-default reset, the
// next-turn-only model, reasoning effort, sandbox/access mode, steering
// mode, and — in Universal mode — the placement pill (passed in as a
// node so its state stays owned by the chat page).

'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type QueueMode = 'interrupt' | 'queue';
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ModelControlProvider {
  id: string;
  name: string;
  configured: boolean;
  models: { id: string; name: string }[];
}

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
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  const currentProvider = providers.find((p) => p.id === providerId);
  const providerLabel = currentProvider?.name ?? providerId ?? 'Provider';
  const modelLabel = modelId
    ? (currentProvider?.models.find((m) => m.id === modelId)?.name ?? modelId)
    : botDefaultLabel;

  return (
    <div className="model-control" ref={wrapRef}>
      <button
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
        <div className="model-control-pop" role="dialog" aria-label="Model and run options">
          <div className="mc-section">
            <div className="mc-heading">Model</div>
            <button
              type="button"
              className={`mc-row${modelId === '' ? ' current' : ''}`}
              onClick={() => {
                setOpen(false);
                onSelectBotDefault();
              }}
            >
              <span className="mc-row-name">Bot default</span>
              <span className="mc-row-sub">{botDefaultLabel}</span>
              {modelId === '' && <span className="mc-check" aria-hidden="true">✓</span>}
            </button>
            {providers.map((p) => (
              <div key={p.id} className="mc-group">
                <div className="mc-group-name">
                  {p.name}
                  {!p.configured && <span className="mc-nokey">no key</span>}
                </div>
                {p.models.map((m) => {
                  const current = p.id === providerId && m.id === modelId;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={`mc-row${current ? ' current' : ''}`}
                      aria-pressed={current}
                      onClick={() => {
                        setOpen(false);
                        onSelectModel(p.id, m.id);
                      }}
                    >
                      <span className="mc-row-name">{m.name}</span>
                      {current && <span className="mc-check" aria-hidden="true">✓</span>}
                    </button>
                  );
                })}
                {p.models.length === 0 && <div className="mc-empty">No models listed</div>}
              </div>
            ))}
          </div>

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
        </div>
      )}
    </div>
  );
}
