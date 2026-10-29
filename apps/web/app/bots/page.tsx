// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { exportBotRoster, getAgentModels, getBots, getPersonas, getProviders, getRedteamReports, importBotRoster, runRedteamSuite, setBotModel, setBotPersona, setBotWorkspace, simulatePolicy, updateBotPolicy } from '../../lib/api';
import type { AgentModel, BotConfig, BotPolicyEffect, BotPolicyRule, ModelOptions, PersonaInfo, PolicySimulationResult, ProviderInfo, RedteamReport, RosterImportReport, VoiceSettings } from '../../lib/api';
import { useUxMode } from '../../lib/ux-mode';
import { I18nProvider, LanguageSwitcher, useI18n } from '../../lib/i18n';
import ComputerPanel from '../../components/panels/computer-panel';
import VoiceSettingsPanel from '../../components/panels/voice-settings-panel';
import { ApprovalModeSelector } from '../../components/panels/approval-mode-selector';
import { MemoryPanel } from '../../components/panels/memory-panel';
import { RoutinesPanel } from '../../components/panels/routines-panel';
import TeamsPanel from '../../components/panels/teams-panel';
import PeoplePanel from '../../components/panels/people-panel';
import { BotSetupPanel } from '../../components/panels/bot-setup-panel';

const EFFECTS: BotPolicyEffect[] = ['allow', 'deny', 'require-approval'];

function newRule(): BotPolicyRule {
  return {
    id: `rule-${Date.now().toString(36)}`,
    toolPattern: '^run_command$',
    effect: 'require-approval',
    reason: '',
  };
}

function validPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}

function RulesEditor({
  bot,
  onSaved,
}: {
  bot: BotConfig;
  onSaved: (botId: string, rules: BotPolicyRule[]) => void;
}) {
  const [rules, setRules] = useState<BotPolicyRule[]>(() => bot.policy?.rules ?? []);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');

  // Reset the editor when switching bots.
  useEffect(() => {
    setRules(bot.policy?.rules ?? []);
    setError('');
    setSavedAt('');
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRule = (idx: number, patch: Partial<BotPolicyRule>) => {
    setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const save = async () => {
    setError('');
    const ids = new Set<string>();
    for (const r of rules) {
      if (!r.id.trim()) {
        setError('Every rule needs an id.');
        return;
      }
      if (ids.has(r.id.trim())) {
        setError(`Duplicate rule id "${r.id.trim()}".`);
        return;
      }
      ids.add(r.id.trim());
      if (!validPattern(r.toolPattern)) {
        setError(`Rule "${r.id}": "${r.toolPattern}" is not a valid regular expression.`);
        return;
      }
    }
    const payload = rules.map((r) => ({
      id: r.id.trim(),
      toolPattern: r.toolPattern,
      effect: r.effect,
      ...(r.reason?.trim() ? { reason: r.reason.trim() } : {}),
    }));
    setSaving(true);
    try {
      const res = await updateBotPolicy(bot.id, payload);
      setSavedAt(new Date().toLocaleTimeString());
      onSaved(bot.id, res.policy.rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row-between">
        <strong>Policy rules — {bot.name}</strong>
        <span className="small muted mono">{bot.id}</span>
      </div>
      <p className="small muted">
        Bot rules are checked <strong>before</strong> the global policy (first match wins). A bot
        rule can tighten the global floor (deny something the global policy allows) or loosen it
        (allow something the global policy gates). No rules → the global policy applies unchanged.
      </p>
      {rules.length === 0 && (
        <p className="small muted">No per-bot rules — the global policy applies.</p>
      )}
      {rules.map((r, i) => (
        <div key={i} className="grid-2" style={{ marginBottom: 8 }}>
          <div className="field">
            <label className="label">Rule id</label>
            <input
              className="input mono"
              value={r.id}
              onChange={(e) => setRule(i, { id: e.target.value })}
              placeholder="allow-fetch"
            />
          </div>
          <div className="field">
            <label className="label">Effect</label>
            <select
              className="select"
              value={r.effect}
              onChange={(e) => setRule(i, { effect: e.target.value as BotPolicyEffect })}
            >
              {EFFECTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label">Tool pattern (regex, case-insensitive)</label>
            <input
              className="input mono"
              style={validPattern(r.toolPattern) ? undefined : { borderColor: '#ef4444' }}
              value={r.toolPattern}
              onChange={(e) => setRule(i, { toolPattern: e.target.value })}
              placeholder="^mcp:fetch:"
              title="Matched against the tool name; first matching rule wins"
            />
          </div>
          <div className="field">
            <label className="label">Reason (optional)</label>
            <input
              className="input"
              value={r.reason ?? ''}
              onChange={(e) => setRule(i, { reason: e.target.value })}
              placeholder="Why this rule exists"
            />
          </div>
          <div>
            <button
              className="btn btn-danger btn-sm"
              onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn btn-sm" onClick={() => setRules((prev) => [...prev, newRule()])}>
          Add rule
        </button>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save policy'}
        </button>
        {savedAt && <span className="small muted">Saved at {savedAt}.</span>}
      </div>
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/**
 * Policy simulator (P3-B, open-dots parity): side-effect-free dry-run of
 * the governance engine. Pick a tool + args, see the decision the bot's
 * merged policy WOULD make — no approvals minted, nothing audited.
 */
function PolicySimulator({ bot }: { bot: BotConfig }) {
  const [toolName, setToolName] = useState('write_file');
  const [argsJson, setArgsJson] = useState('{\n  "path": "notes/todo.txt"\n}');
  const [result, setResult] = useState<PolicySimulationResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  // Reset when switching bots.
  useEffect(() => {
    setResult(null);
    setError('');
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setError('');
    setResult(null);
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(argsJson);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('args must be a JSON object');
      }
      args = parsed as Record<string, unknown>;
    } catch (e) {
      setError(`Invalid args JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!toolName.trim()) {
      setError('Tool name is required.');
      return;
    }
    setRunning(true);
    try {
      const res = await simulatePolicy(toolName.trim(), args, bot.id);
      setResult(res);
    } catch (e) {
      setError(`Simulation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const effectColor = result
    ? result.effect === 'allow'
      ? 'var(--ok, #2e7d32)'
      : result.effect === 'deny'
        ? 'var(--danger, #c62828)'
        : 'var(--warn, #e65100)'
    : undefined;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3 style={{ margin: '0 0 4px' }}>Policy simulator</h3>
      <p className="small muted" style={{ margin: '0 0 12px' }}>
        Dry-run the governance engine against this bot&apos;s merged policy (bot rules + global). No
        approvals are created and nothing is audited.
      </p>
      <div style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
        <label className="small">
          Tool name
          <input
            className="input"
            value={toolName}
            onChange={(e) => setToolName(e.target.value)}
            placeholder="write_file"
            style={{ width: '100%', marginTop: 4 }}
          />
        </label>
        <label className="small">
          Args (JSON object)
          <textarea
            className="input"
            value={argsJson}
            onChange={(e) => setArgsJson(e.target.value)}
            rows={4}
            spellCheck={false}
            style={{ width: '100%', marginTop: 4, fontFamily: 'monospace' }}
          />
        </label>
        <div>
          <button className="btn btn-primary btn-sm" disabled={running} onClick={() => void run()}>
            {running ? 'Simulating…' : 'Simulate'}
          </button>
        </div>
      </div>
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
      {result && (
        <div className="small" style={{ marginTop: 12, display: 'grid', gap: 4 }}>
          <div>
            Decision:{' '}
            <strong style={{ color: effectColor }}>{result.effect}</strong>
            {result.wouldCreateApproval && <span className="muted"> (would mint a pending approval)</span>}
          </div>
          <div className="muted">Matched rule: {result.matchedRuleId ?? <em>none — default policy</em>}</div>
          <div className="muted">Reason: {result.reason}</div>
          <div className="muted">Action class: {result.actionClass}</div>
          {result.hardFloor && (
            <div className="muted">
              Hard floor: {result.hardFloor.tier} — {result.hardFloor.reason} ({result.hardFloor.patternId})
            </div>
          )}
          {result.denylist && <div className="muted">Hard denylist on run_command args fired.</div>}
        </div>
      )}
    </div>
  );
}

function ModelPicker({
  bot,
  onSaved,
}: {
  bot: BotConfig;
  onSaved: (
    botId: string,
    model: string,
    modelOptions?: ModelOptions,
    backup?: { backupProvider?: string; backupModel?: string },
  ) => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [agentModels, setAgentModels] = useState<AgentModel[]>([]);
  const [selected, setSelected] = useState(bot.model);
  const [options, setOptions] = useState<ModelOptions>(bot.modelOptions ?? {});
  const [backupProvider, setBackupProvider] = useState(bot.backupProvider ?? '');
  const [backupModel, setBackupModel] = useState(bot.backupModel ?? '');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSelected(bot.model);
    setOptions(bot.modelOptions ?? {});
    setBackupProvider(bot.backupProvider ?? '');
    setBackupModel(bot.backupModel ?? '');
    setError('');
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const provs = await getProviders();
        if (cancelled) return;
        setProviders(provs);
        const prov = provs.find((p) => p.id === bot.provider);
        if (prov?.bridge) {
          try {
            const r = await getAgentModels(prov.bridge);
            if (!cancelled) setAgentModels(r.models);
          } catch {
            if (!cancelled) setAgentModels([]);
          }
        } else {
          if (!cancelled) setAgentModels([]);
        }
      } catch {
        if (!cancelled) setProviders([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [bot.id, bot.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const provider = providers.find((p) => p.id === bot.provider);
  // Prefer live-discovered agent models; fall back to provider catalog.
  const catalogModels: AgentModel[] = (provider?.models ?? []).map((m) => ({ id: m.id, name: m.name }));
  const models = agentModels.length > 0 ? agentModels : catalogModels;
  const current = models.find((m) => m.id === selected);

  // Only show options the current model supports (default: show all when unknown).
  const showEffort = !current || current.supportsReasoningEffort !== false;
  const showFast = !current || current.supportsFastMode !== false;

  const backupProviderInfo = providers.find((p) => p.id === backupProvider);
  const backupModels: AgentModel[] = (backupProviderInfo?.models ?? []).map((m) => ({ id: m.id, name: m.name }));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await setBotModel(
        bot.id,
        selected || null,
        Object.keys(options).length > 0 ? options : null,
        {
          backupProvider: backupProvider || null,
          backupModel: backupProvider ? backupModel || null : null,
        },
      );
      onSaved(bot.id, res.model ?? selected, res.modelOptions, {
        backupProvider: res.backupProvider,
        backupModel: res.backupModel,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Model</h3>
      <p className="small muted">
        Pick the model for this bot{provider ? ` (via ${provider.name})` : ''}. Options only appear
        when the model supports them.
      </p>
      {loading ? (
        <p className="muted">Loading models…</p>
      ) : models.length === 0 ? (
        <p className="muted">No models discovered. The bot keeps its current model ({bot.model}).</p>
      ) : (
        <>
          <label className="small" style={{ display: 'block', marginBottom: 4 }}>Model</label>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={{ width: '100%', marginBottom: 12 }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          {showEffort && (
            <div style={{ marginBottom: 12 }}>
              <label className="small" style={{ display: 'block', marginBottom: 4 }}>Reasoning effort</label>
              <select
                value={options.reasoningEffort ?? ''}
                onChange={(e) => setOptions((o) => ({ ...o, reasoningEffort: (e.target.value || undefined) as ModelOptions['reasoningEffort'] }))}
                style={{ width: '100%' }}
              >
                <option value="">Default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          )}
          {showFast && (
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={options.fastMode ?? false}
                onChange={(e) => setOptions((o) => ({ ...o, fastMode: e.target.checked || undefined }))}
              />
              Fast mode (prefer lowest-latency variant)
            </label>
          )}
          {provider?.usageWarning && (
            <div className="error-box" style={{ marginBottom: 12 }} role="status">
              ⚠️ {provider.usageWarning.message} — this provider is approaching its limit.
            </div>
          )}
          <div style={{ borderTop: '1px solid var(--border, #e5e7eb)', paddingTop: 12, marginBottom: 12 }}>
            <label className="small" style={{ display: 'block', marginBottom: 4 }}>
              Backup AI provider <span className="muted">(failover — used automatically when the primary hits its usage limit)</span>
            </label>
            <select
              value={backupProvider}
              onChange={(e) => {
                setBackupProvider(e.target.value);
                setBackupModel('');
              }}
              style={{ width: '100%', marginBottom: 12 }}
              aria-label="Backup AI provider"
            >
              <option value="">None — use the next eligible provider</option>
              {providers
                .filter((p) => p.id !== bot.provider)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.usageWarning ? ` — ⚠️ ${p.usageWarning.usedPercent}% used` : ''}
                  </option>
                ))}
            </select>
            {backupProvider && backupModels.length > 0 && (
              <>
                <label className="small" style={{ display: 'block', marginBottom: 4 }}>Backup model</label>
                <select
                  value={backupModel}
                  onChange={(e) => setBackupModel(e.target.value)}
                  style={{ width: '100%', marginBottom: 12 }}
                  aria-label="Backup AI model"
                >
                  <option value="">Provider default</option>
                  {backupModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </>
            )}
            {backupProviderInfo?.usageWarning && (
              <p className="small" style={{ color: 'var(--warn, #e65100)' }}>
                ⚠️ {backupProviderInfo.usageWarning.message} — the backup is also near its limit.
              </p>
            )}
          </div>
          <button onClick={save} disabled={saving} className="btn btn-primary">
            {saving ? 'Saving…' : 'Save model'}
          </button>
          {error && <p className="small" style={{ color: 'var(--danger, #c00)' }}>{error}</p>}
        </>
      )}
    </div>
  );
}

function PersonaPicker({
  bot,
  onSaved,
}: {
  bot: BotConfig;
  onSaved: (botId: string, persona: string | null) => void;
}) {
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
  const [selected, setSelected] = useState<string>(bot.persona ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSelected(bot.persona ?? '');
    setError('');
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    getPersonas().then((r) => setPersonas(r.personas)).catch(() => undefined);
  }, []);

  const active = personas.find((p) => p.type === selected);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await setBotPersona(bot.id, selected || null);
      onSaved(bot.id, res.persona);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Personality</h3>
      <p className="small muted">
        Give this bot an MBTI persona. It shapes tone and working style — the bot&apos;s own
        instructions always come first.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          className="select"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="MBTI persona"
        >
          <option value="">No persona</option>
          {personas.map((p) => (
            <option key={p.type} value={p.type}>
              {p.type} — {p.name}
            </option>
          ))}
        </select>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save persona'}
        </button>
      </div>
      {active && (
        <p className="small muted" style={{ marginTop: 8 }}>
          <strong>{active.name}:</strong> {active.traits.join(' · ')} — {active.communicationStyle}
        </p>
      )}
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function WorkspacePicker({
  bot,
  onSaved,
}: {
  bot: BotConfig;
  onSaved: (botId: string, workspace: string | null) => void;
}) {
  const [value, setValue] = useState<string>(bot.workspace ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setValue(bot.workspace ?? '');
    setError('');
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await setBotWorkspace(bot.id, value.trim() || null);
      onSaved(bot.id, res.workspace);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Workspace</h3>
      <p className="small muted">
        Give this bot its own workspace directory (Octop-style isolation) so two bots
        working at once don&apos;t collide on files. Leave empty for the shared
        workspace. Relative names resolve under the server data dir
        (e.g. <code>coder</code>).
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="default (shared)"
          aria-label="Bot workspace"
          style={{ minWidth: 220 }}
        />
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save workspace'}
        </button>
      </div>
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function RobustnessPanel({ bot }: { bot: BotConfig }) {
  const [reports, setReports] = useState<RedteamReport[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [openAttack, setOpenAttack] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await getRedteamReports(bot.id);
      setReports(r.reports);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [bot.id]);

  useEffect(() => {
    setReports([]);
    setOpenAttack(null);
    void refresh();
  }, [refresh]);

  const run = async () => {
    setRunning(true);
    setError('');
    try {
      await runRedteamSuite(bot.id, 'core');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const latest = reports.length > 0 ? reports[reports.length - 1] : null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h3 style={{ margin: 0 }}>Robustness</h3>
        <button className="btn btn-primary btn-sm" disabled={running} onClick={() => void run()}>
          {running ? 'Running suite…' : 'Run robustness suite'}
        </button>
      </div>
      <p className="small muted">
        Defensive red-team suite for this bot&apos;s own defenses: direct/indirect injection,
        prompt extraction, persona hijack, obfuscation, multi-turn manipulation, and
        tool-abuse probes against the catastrophic-command hard floors. Score = % of
        attacks blocked. Internal testing harness — not a user-facing feature.
      </p>
      {error && <div className="error-box">{error}</div>}
      {reports.length === 0 && !error && (
        <p className="small muted">{running ? 'Suite running…' : 'No runs yet — run the suite to get a baseline.'}</p>
      )}
      {reports.length > 0 && (
        <>
          <h4 style={{ margin: '12px 0 8px' }}>Score history</h4>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[...reports].reverse().map((r) => (
              <span
                key={r.reportId}
                className="mono small"
                title={`${r.blocked}/${r.total} blocked · ${new Date(r.ts).toLocaleString()}`}
                style={{
                  padding: '4px 10px',
                  borderRadius: 999,
                  border: '1px solid var(--border, #e5e7eb)',
                  background: r.score >= 80 ? '#ecfdf5' : r.score >= 50 ? '#fffbeb' : '#fef2f2',
                  color: r.score >= 80 ? '#065f46' : r.score >= 50 ? '#92400e' : '#991b1b',
                }}
              >
                {r.score} · {new Date(r.ts).toLocaleDateString()}
              </span>
            ))}
          </div>
        </>
      )}
      {latest && (
        <>
          <h4 style={{ margin: '16px 0 8px' }}>
            Last run — {latest.blocked}/{latest.total} blocked (score {latest.score})
            <span className="small muted" style={{ marginLeft: 8 }}>
              {new Date(latest.ts).toLocaleString()} · suite {latest.suite}
            </span>
          </h4>
          <div>
            {latest.results.map((r) => (
              <div key={r.attackId} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span
                    className="mono small"
                    style={{
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: r.verdict === 'blocked' ? '#ecfdf5' : '#fef2f2',
                      color: r.verdict === 'blocked' ? '#065f46' : '#991b1b',
                      fontWeight: 600,
                    }}
                  >
                    {r.verdict === 'blocked' ? 'PASS' : 'FAIL'}
                  </span>
                  <button
                    className="btn btn-sm"
                    style={{ padding: '2px 8px' }}
                    onClick={() => setOpenAttack((cur) => (cur === r.attackId ? null : r.attackId))}
                    aria-expanded={openAttack === r.attackId}
                  >
                    {r.name}
                  </button>
                  <span className="small muted mono">{r.attackId} · {r.category}</span>
                </div>
                {openAttack === r.attackId && (
                  <div
                    className="small"
                    style={{
                      marginTop: 6,
                      padding: 10,
                      border: '1px solid var(--border, #e5e7eb)',
                      borderRadius: 8,
                      background: 'var(--surface, #fafafa)',
                    }}
                  >
                    {r.matchedSignals.length > 0 && (
                      <p className="mono" style={{ margin: '0 0 8px' }}>
                        signals: {r.matchedSignals.join(', ')}
                      </p>
                    )}
                    {r.verdict === 'succeeded' && r.hardeningNote && (
                      <p style={{ margin: '0 0 8px' }}>
                        <strong>Hardening:</strong> {r.hardeningNote}
                      </p>
                    )}
                    {r.transcript.map((t, i) => (
                      <div key={i} style={{ marginBottom: 8 }}>
                        <div className="mono muted" style={{ fontSize: 11 }}>
                          {t.role === 'attacker' ? '▶ attack' : '● bot'}
                          {t.toolCalls && t.toolCalls.length > 0 && (
                            <span>
                              {' '}
                              · tools:{' '}
                              {t.toolCalls.map((c) => `${c.name}(${c.outcome})`).join(', ')}
                            </span>
                          )}
                        </div>
                        <div className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                          {t.text.length > 600 ? `${t.text.slice(0, 600)}…` : t.text}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function BotsPageInner() {
  const { t } = useI18n();
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [selectedBotId, setSelectedBotId] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'policy' | 'model' | 'robustness' | 'computer' | 'memory' | 'routines'>('policy');
  const [pageTab, setPageTab] = useState<'bots' | 'teams'>('bots');
  const [showSetup, setShowSetup] = useState(false);
  const [mode] = useUxMode();
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterError, setRosterError] = useState('');
  const [rosterReport, setRosterReport] = useState<RosterImportReport | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const tabs = [
    { id: 'policy' as const, label: t('bots.tabPolicy') },
    { id: 'model' as const, label: t('bots.tabModel') },
    { id: 'computer' as const, label: t('bots.tabComputer') },
    { id: 'memory' as const, label: t('bots.tabMemory') },
    { id: 'routines' as const, label: t('bots.tabRoutines') },
    // Pro surface: hidden in Simple mode.
    ...(mode === 'pro' ? [{ id: 'robustness' as const, label: t('bots.tabRobustness') }] : []),
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'policy';

  const refresh = useCallback(async () => {
    try {
      const b = await getBots();
      setBots(b);
      setError('');
      if (b.length > 0) setSelectedBotId((cur) => cur || b[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Download the full bot+team roster as a JSON manifest file. */
  const onExportRoster = async () => {
    if (rosterBusy) return;
    setRosterBusy(true);
    setRosterError('');
    try {
      await exportBotRoster();
    } catch (err) {
      setRosterError(err instanceof Error ? err.message : String(err));
    } finally {
      setRosterBusy(false);
    }
  };

  /** Import a roster manifest file; shows the per-id import report. */
  const onImportRosterFile = async (file: File) => {
    if (rosterBusy) return;
    setRosterBusy(true);
    setRosterError('');
    setRosterReport(null);
    try {
      const text = await file.text();
      let manifest: unknown;
      try {
        manifest = JSON.parse(text);
      } catch {
        throw new Error('Not a valid JSON file.');
      }
      const report = await importBotRoster(manifest);
      setRosterReport(report);
      await refresh();
    } catch (err) {
      setRosterError(err instanceof Error ? err.message : String(err));
    } finally {
      setRosterBusy(false);
      if (importFileRef.current) importFileRef.current.value = '';
    }
  };

  const onSaved = (botId: string, rules: BotPolicyRule[]) => {
    setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, policy: { rules } } : b)));
  };

  const onPersonaSaved = (botId: string, persona: string | null) => {
    setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, persona } : b)));
  };

  const onWorkspaceSaved = (botId: string, workspace: string | null) => {
    setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, workspace: workspace ?? undefined } : b)));
  };

  const onApprovalModeSaved = (botId: string, approvalMode: 'plan' | 'auto' | 'bypass') => {
    setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, approvalMode } : b)));
  };

  const onModelSaved = (
    botId: string,
    model: string,
    modelOptions?: ModelOptions,
    backup?: { backupProvider?: string; backupModel?: string },
  ) => {
    setBots((prev) =>
      prev.map((b) =>
        b.id === botId
          ? { ...b, model, modelOptions, backupProvider: backup?.backupProvider, backupModel: backup?.backupModel }
          : b,
      ),
    );
  };

  const onVoiceSaved = (botId: string, voice: VoiceSettings) => {
    setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, voice } : b)));
  };

  const selectedBot = bots.find((b) => b.id === selectedBotId);

  return (
    <div>
      <div className="row-between" style={{ alignItems: 'center' }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>{t('bots.title')}</h1>
        <LanguageSwitcher />
      </div>
      <p className="page-sub">
        {t('bots.subtitle')}
      </p>
      <p>
        <a className="btn btn-ghost" href="/groups">
          👥 Group chats — several bots in one room
        </a>{' '}
        <a className="btn btn-ghost" href="/evals">
          🧪 Eval harnesses — score bot quality
        </a>
      </p>
      {error && <div className="error-box">{error}</div>}
      <div className="tabs" role="tablist" aria-label="Bots sections" style={{ marginBottom: 12 }}>
        <button
          type="button"
          role="tab"
          aria-selected={pageTab === 'bots'}
          className={`tab${pageTab === 'bots' ? ' active' : ''}`}
          onClick={() => setPageTab('bots')}
        >
          🤖 Bots
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={pageTab === 'teams'}
          className={`tab${pageTab === 'teams' ? ' active' : ''}`}
          onClick={() => setPageTab('teams')}
        >
          👑 Chief of Staff
        </button>
      </div>
      {pageTab === 'teams' ? (
        <>
          <TeamsPanel bots={bots} onRosterChanged={refresh} />
          <PeoplePanel bots={bots} onRosterChanged={refresh} />
        </>
      ) : (
      <div className="chat-layout">
        <aside className="bot-roster">
          <h3>{t('bots.roster')}</h3>
          {bots.map((b) => (
            <button
              key={b.id}
              className={`bot-item${b.id === selectedBotId ? ' selected' : ''}`}
              onClick={() => setSelectedBotId(b.id)}
            >
              <div className="bot-name">{b.name}</div>
              <div className="bot-desc">
                {b.policy?.rules.length
                  ? `${b.policy.rules.length} custom rule${b.policy.rules.length === 1 ? '' : 's'}`
                  : 'global policy'}
              </div>
            </button>
          ))}
          {bots.length === 0 && !error && <div className="small muted">{t('bots.loadingBots')}</div>}
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setShowSetup(true)}>
              ✨ Set me up
            </button>
            <button type="button" className="btn btn-sm" onClick={onExportRoster} disabled={rosterBusy}>
              ⬇ Export roster
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => importFileRef.current?.click()}
              disabled={rosterBusy}
            >
              ⬆ Import roster
            </button>
            <input
              ref={importFileRef}
              type="file"
              accept="application/json,.json"
              hidden
              aria-label="Import roster manifest"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onImportRosterFile(f);
              }}
            />
          </div>
          {rosterError && (
            <div className="error-box" style={{ marginTop: 8 }}>
              {rosterError}
            </div>
          )}
          {rosterReport && (
            <div className="small" style={{ marginTop: 8 }} role="status" aria-label="Roster import report">
              <div>
                <strong>Imported {rosterReport.imported.length}</strong>
                {rosterReport.imported.length > 0 && (
                  <span className="mono">: {rosterReport.imported.join(', ')}</span>
                )}
              </div>
              {rosterReport.skipped.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <strong>Skipped {rosterReport.skipped.length}</strong> (already exist):
                  <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                    {rosterReport.skipped.map((s) => (
                      <li key={s.id}>
                        <span className="mono">{s.id}</span> — {s.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {rosterReport.errors.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <strong>Errors {rosterReport.errors.length}</strong>:
                  <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                    {rosterReport.errors.map((s) => (
                      <li key={s.id}>
                        <span className="mono">{s.id}</span> — {s.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </aside>
        <div className="chat-main">
          {showSetup ? (
            <BotSetupPanel
              onCreated={() => void refresh()}
              onCancel={() => setShowSetup(false)}
            />
          ) : selectedBot ? (
            <>
              <div className="tabs" role="tablist" aria-label="Bot sections" style={{ marginBottom: 12 }}>
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={activeTab === t.id}
                    className={`tab${activeTab === t.id ? ' active' : ''}`}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {activeTab === 'policy' ? (
                <>
                  <PersonaPicker key={`persona-${selectedBot.id}`} bot={selectedBot} onSaved={onPersonaSaved} />
                  <WorkspacePicker key={`workspace-${selectedBot.id}`} bot={selectedBot} onSaved={onWorkspaceSaved} />
                  <ApprovalModeSelector
                    key={`approval-mode-${selectedBot.id}`}
                    bot={selectedBot}
                    onSaved={onApprovalModeSaved}
                  />
                  <RulesEditor key={selectedBot.id} bot={selectedBot} onSaved={onSaved} />
                  <PolicySimulator key={`sim-${selectedBot.id}`} bot={selectedBot} />
                </>
              ) : activeTab === 'model' ? (
                <>
                  <ModelPicker key={`model-${selectedBot.id}`} bot={selectedBot} onSaved={onModelSaved} />
                  <VoiceSettingsPanel
                    key={`voice-${selectedBot.id}`}
                    bot={selectedBot}
                    onSaved={onVoiceSaved}
                  />
                </>
              ) : activeTab === 'computer' ? (
                <ComputerPanel key={`computer-${selectedBot.id}`} botId={selectedBot.id} />
              ) : activeTab === 'memory' ? (
                <MemoryPanel key={`memory-${selectedBot.id}`} botId={selectedBot.id} />
              ) : activeTab === 'routines' ? (
                <RoutinesPanel key={`routines-${selectedBot.id}`} botId={selectedBot.id} />
              ) : (
                <RobustnessPanel key={`robustness-${selectedBot.id}`} bot={selectedBot} />
              )}
            </>
          ) : (
            <p className="muted">{t('bots.selectPrompt')}</p>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

/**
 * Default export: the Bots destination wrapped in the i18n provider.
 * (Global mount point would be app/layout.tsx around {children} — reported
 * in docs/I18N.md since layout/nav are owned by the navigation workstream.)
 */
export default function BotsPage() {
  return (
    <I18nProvider>
      <BotsPageInner />
    </I18nProvider>
  );
}
