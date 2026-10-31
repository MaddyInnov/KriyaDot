// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getWorkflows, runWorkflow } from '../../../lib/api';
import { useCollapsed } from '../../../lib/use-collapsed';
import { PaneCollapseButton, PaneStrip } from '../../../components/collapse';
import type { WorkflowDefinition } from '../../../lib/api';
import {
  DEFAULT_NODE_CONFIGS,
  NODE_TYPES,
  graphToWorkflow,
  suggestNodeId,
  validateGraph,
  workflowToGraph,
  type CanvasGraph,
  type CanvasNode,
  type CanvasNodeType,
} from './lib';

const NODE_W = 190;
const NODE_H = 92;

const TYPE_CHIP: Record<CanvasNodeType, string> = {
  trigger: 'blue',
  agent: 'green',
  tool: 'gray',
  http: 'amber',
  delay: 'gray',
  approval: 'red',
  if: 'blue',
  set: 'green',
  code: 'gray',
};

function freshGraph(): CanvasGraph {
  return {
    id: `workflow-${Date.now().toString(36)}`,
    name: 'Untitled workflow',
    nodes: [{ id: 'trigger', type: 'trigger', name: 'Start', config: {}, x: 40, y: 40 }],
    edges: [],
  };
}

export default function CanvasPage() {
  // Collapse pass: the node palette rail collapses against the canvas
  // (`kriyadot:collapse:wf-palette`).
  const paletteCol = useCollapsed('wf-palette');
  const [graph, setGraph] = useState<CanvasGraph>(freshGraph);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [pro, setPro] = useState(false);
  const [defs, setDefs] = useState<WorkflowDefinition[]>([]);
  const [loadId, setLoadId] = useState('');
  const [rawJson, setRawJson] = useState('');
  const [runInput, setRunInput] = useState('');
  const [runInfo, setRunInfo] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [configText, setConfigText] = useState('');
  const [configError, setConfigError] = useState('');
  const [nodeIdText, setNodeIdText] = useState('');
  const [nodeNameText, setNodeNameText] = useState('');

  const dragRef = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getWorkflows()
      .then(setDefs)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const selected: CanvasNode | null = useMemo(
    () => graph.nodes.find((n) => n.id === selectedId) ?? null,
    [graph, selectedId],
  );

  // Keep the inspector text fields in sync when selection changes.
  useEffect(() => {
    if (selected) {
      setConfigText(JSON.stringify(selected.config, null, 2));
      setConfigError('');
      setNodeIdText(selected.id);
      setNodeNameText(selected.name);
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const problems = useMemo(() => validateGraph(graph), [graph]);
  const workflow = useMemo(() => graphToWorkflow(graph), [graph]);

  // ---- Node ops ------------------------------------------------------------

  const addNode = (type: CanvasNodeType) => {
    setGraph((g) => {
      const id = suggestNodeId(type, new Set(g.nodes.map((n) => n.id)));
      const k = g.nodes.length;
      const node: CanvasNode = {
        id,
        type,
        name: `${type[0].toUpperCase() + type.slice(1)} node`,
        config: JSON.parse(JSON.stringify(DEFAULT_NODE_CONFIGS[type])) as Record<string, unknown>,
        x: 40 + (k % 6) * 60,
        y: 40 + Math.floor(k / 6) * 40 + (k % 6) * 10,
      };
      return { ...g, nodes: [...g.nodes, node] };
    });
    setError('');
  };

  const updateNode = (id: string, patch: Partial<CanvasNode>) => {
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  };

  const renameNodeId = (oldId: string, newId: string) => {
    const clean = newId.trim();
    if (!clean || clean === oldId) return;
    if (graph.nodes.some((n) => n.id === clean)) {
      setError(`Node id "${clean}" is already taken.`);
      return;
    }
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === oldId ? { ...n, id: clean } : n)),
      edges: g.edges.map(([f, t, b]) =>
        (b === undefined
          ? [f === oldId ? clean : f, t === oldId ? clean : t]
          : [f === oldId ? clean : f, t === oldId ? clean : t, b]) as [string, string, ('true' | 'false')?],
      ),
    }));
    setSelectedId(clean);
    setError('');
  };

  const deleteNode = (id: string) => {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.filter((n) => n.id !== id),
      edges: g.edges.filter(([f, t]) => f !== id && t !== id),
    }));
    if (selectedId === id) setSelectedId(null);
    setConnectMode(false);
  };

  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    setGraph((g) => {
      // Edges leaving an if node default to the 'true' branch; change the
      // label in Pro mode by clicking the edge badge.
      const fromNode = g.nodes.find((n) => n.id === from);
      const branch = fromNode?.type === 'if' ? ('true' as const) : undefined;
      if (g.edges.some(([f, t, b]) => f === from && t === to && b === branch)) return g;
      return { ...g, edges: [...g.edges, branch === undefined ? [from, to] : [from, to, branch]] };
    });
  };

  const deleteEdge = (from: string, to: string, branch?: 'true' | 'false') => {
    setGraph((g) => ({
      ...g,
      edges: g.edges.filter(([f, t, b]) => !(f === from && t === to && b === branch)),
    }));
  };

  /** Cycle an if-edge's branch label: true → false → unlabeled → true. */
  const cycleEdgeBranch = (from: string, to: string, branch?: 'true' | 'false') => {
    setGraph((g) => ({
      ...g,
      edges: g.edges.map(([f, t, b]) => {
        if (f !== from || t !== to || b !== branch) return [f, t, b] as [string, string, ('true' | 'false')?];
        const next = branch === 'true' ? 'false' : branch === 'false' ? undefined : 'true';
        return (next === undefined ? [f, t] : [f, t, next]) as [string, string, ('true' | 'false')?];
      }),
    }));
  };

  // ---- Drag ----------------------------------------------------------------

  const onNodeMouseDown = (e: React.MouseEvent, id: string) => {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return;
    dragRef.current = { id, dx: e.clientX - node.x, dy: e.clientY - node.y, moved: false };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.moved = true;
      const x = Math.max(0, e.clientX - drag.dx);
      const y = Math.max(0, e.clientY - drag.dy);
      setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === drag.id ? { ...n, x, y } : n)) }));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onNodeClick = (id: string) => {
    if (dragRef.current?.moved) return; // was a drag, not a click
    if (connectMode && selectedId && selectedId !== id) {
      addEdge(selectedId, id);
      setConnectMode(false);
      return;
    }
    setSelectedId(id);
  };

  // ---- Load / save ---------------------------------------------------------

  const loadDefinition = useCallback(
    (def: WorkflowDefinition) => {
      const g = workflowToGraph(def);
      setGraph(g);
      setSelectedId(null);
      setConnectMode(false);
      setRawJson(JSON.stringify(graphToWorkflow(g), null, 2));
      setRunInfo('');
      setError('');
    },
    [],
  );

  const loadSelected = () => {
    const def = defs.find((d) => d.id === loadId);
    if (!def) {
      setError('Pick a workflow to load.');
      return;
    }
    loadDefinition(def);
  };

  const loadFromRawJson = () => {
    try {
      const parsed = JSON.parse(rawJson) as WorkflowDefinition;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
        throw new Error('JSON must be a workflow definition with nodes[] and edges[].');
      }
      loadDefinition(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(workflow, null, 2));
      setRunInfo('Workflow JSON copied to clipboard.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${graph.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startRun = async () => {
    if (problems.length > 0) {
      setError(`Fix ${problems.length} problem(s) before running.`);
      return;
    }
    let input: unknown;
    const raw = runInput.trim();
    if (raw) {
      try {
        input = JSON.parse(raw) as unknown;
      } catch {
        setError('Run input is not valid JSON.');
        return;
      }
    }
    setRunning(true);
    setRunInfo('');
    try {
      const { runId } = await runWorkflow(graph.id, input);
      setRunInfo(`Run started: ${runId}`);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const applyConfigText = () => {
    if (!selected) return;
    try {
      const parsed = JSON.parse(configText) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Config must be a JSON object.');
      }
      updateNode(selected.id, { config: parsed as Record<string, unknown> });
      setConfigError('');
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    }
  };

  const nodeById = (id: string): CanvasNode | undefined => graph.nodes.find((n) => n.id === id);

  return (
    <div>
      <div className="row-between">
        <div>
          <h1 className="page-title">Workflow canvas</h1>
          <p className="page-sub">
            Drag nodes, connect them, and the canvas serializes to the standard workflow JSON.
          </p>
        </div>
        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={pro} onChange={(e) => setPro(e.target.checked)} />
          Pro mode (raw JSON, edge tools)
        </label>
      </div>
      {error && <div className="error-box">{error}</div>}
      {runInfo && <div className="card small">{runInfo}</div>}

      <div className="card">
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="field" style={{ minWidth: 220, flex: 1 }}>
            <label className="label" htmlFor="wf-name">
              Workflow name
            </label>
            <input
              id="wf-name"
              className="input"
              value={graph.name}
              onChange={(e) => setGraph((g) => ({ ...g, name: e.target.value }))}
            />
          </div>
          <div className="field" style={{ minWidth: 220, flex: 1 }}>
            <label className="label" htmlFor="wf-desc">
              Description (optional)
            </label>
            <input
              id="wf-desc"
              className="input"
              value={graph.description ?? ''}
              onChange={(e) => setGraph((g) => ({ ...g, description: e.target.value }))}
              placeholder="What does this workflow do?"
            />
          </div>
          <div className="field" style={{ minWidth: 220, flex: 1 }}>
            <label className="label" htmlFor="wf-load">
              Load existing
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <select id="wf-load" className="select" value={loadId} onChange={(e) => setLoadId(e.target.value)}>
                <option value="">— choose —</option>
                {defs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.id})
                  </option>
                ))}
              </select>
              <button className="btn btn-sm" onClick={loadSelected}>
                Load
              </button>
            </div>
          </div>
        </div>
        <div className="small muted mono">id: {graph.id}</div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', marginTop: 12 }}>
        {/* Palette */}
        <div className="card" style={{ width: paletteCol.collapsed ? 44 : 170, flexShrink: 0, padding: paletteCol.collapsed ? 4 : undefined }}>
          {paletteCol.collapsed ? (
            <PaneStrip label="Add node" side="left" onExpand={() => paletteCol.setCollapsed(false)} />
          ) : (
            <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <strong className="small">Add node</strong>
            <PaneCollapseButton label="node palette" side="left" onCollapse={() => paletteCol.setCollapsed(true)} />
          </div>
          <div className="mt">
            {NODE_TYPES.map((t) => (
              <button
                key={t}
                className="btn btn-sm"
                style={{ display: 'block', width: '100%', marginBottom: 6, textAlign: 'left' }}
                onClick={() => addNode(t)}
              >
                <span className={`chip ${TYPE_CHIP[t]}`}>{t}</span>
              </button>
            ))}
          </div>
          <div className="mt small muted">
            Click a node to select it. With a node selected, use “Connect from selected”, then click the target node.
            Edges from an <span className="mono">if</span> node carry a true/false branch badge — click it to cycle.
          </div>
          <button
            className={`btn btn-sm mt${connectMode ? ' btn-primary' : ''}`}
            disabled={!selectedId}
            onClick={() => setConnectMode((c) => !c)}
          >
            {connectMode ? 'Cancel connect' : 'Connect from selected'}
          </button>
            </>
          )}
        </div>

        {/* Canvas */}
        <div className="card" style={{ flex: 1, padding: 0, overflow: 'hidden' }}>
          <div
            ref={canvasRef}
            style={{ position: 'relative', height: 480, overflow: 'auto', background: 'var(--canvas-bg, #0d1117)' }}
          >
            <div style={{ position: 'relative', width: 1600, height: 1000 }}>
              <svg style={{ position: 'absolute', inset: 0, width: 1600, height: 1000, pointerEvents: pro ? 'auto' : 'none' }}>
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 1 L 9 5 L 0 9 z" fill="#9aa4b2" />
                  </marker>
                </defs>
                {graph.edges.map(([from, to, branch]) => {
                  const a = nodeById(from);
                  const b = nodeById(to);
                  if (!a || !b) return null;
                  const x1 = a.x + NODE_W;
                  const y1 = a.y + NODE_H / 2;
                  const x2 = b.x;
                  const y2 = b.y + NODE_H / 2;
                  const mx = (x1 + x2) / 2;
                  const my = (y1 + y2) / 2;
                  return (
                    <g key={`${from}→${to}:${branch ?? ''}`}>
                      {pro && (
                        <line
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                          stroke="transparent"
                          strokeWidth={14}
                          style={{ cursor: 'pointer' }}
                          onClick={() => deleteEdge(from, to, branch)}
                        >
                          <title>Delete edge (Pro)</title>
                        </line>
                      )}
                      <path
                        d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                        fill="none"
                        stroke={branch === 'true' ? '#3fb950' : branch === 'false' ? '#f85149' : '#9aa4b2'}
                        strokeWidth={2}
                        markerEnd="url(#arrow)"
                      />
                      {branch !== undefined && (
                        <g
                          onClick={() => cycleEdgeBranch(from, to, branch)}
                          style={{ cursor: 'pointer' }}
                        >
                          <title>Click to cycle branch (true → false → unlabeled)</title>
                          <rect
                            x={mx - 24}
                            y={my - 11}
                            width={48}
                            height={22}
                            rx={11}
                            fill={branch === 'true' ? '#12261a' : '#2c1414'}
                            stroke={branch === 'true' ? '#3fb950' : '#f85149'}
                            strokeWidth={1}
                          />
                          <text
                            x={mx}
                            y={my + 4}
                            textAnchor="middle"
                            fontSize={11}
                            fill={branch === 'true' ? '#3fb950' : '#f85149'}
                          >
                            {branch}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
              </svg>
              {graph.nodes.map((n) => (
                <div
                  key={n.id}
                  onMouseDown={(e) => onNodeMouseDown(e, n.id)}
                  onClick={() => onNodeClick(n.id)}
                  style={{
                    position: 'absolute',
                    left: n.x,
                    top: n.y,
                    width: NODE_W,
                    height: NODE_H,
                    border: selectedId === n.id ? '2px solid #2f81f7' : '1px solid #3d444d',
                    borderRadius: 8,
                    background: '#161b22',
                    color: '#e6edf3',
                    padding: 8,
                    cursor: connectMode ? 'crosshair' : 'move',
                    userSelect: 'none',
                    boxSizing: 'border-box',
                  }}
                >
                  <div className="row-between">
                    <span className={`chip ${TYPE_CHIP[n.type]}`}>{n.type}</span>
                    <span className="small muted mono truncate" style={{ maxWidth: 90 }}>
                      {n.id}
                    </span>
                  </div>
                  <div className="truncate" style={{ marginTop: 6 }}>
                    <strong>{n.name}</strong>
                  </div>
                  <div className="small muted truncate">{summarizeConfig(n)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Inspector */}
        <div className="card" style={{ width: 280, flexShrink: 0 }}>
          <strong className="small">Inspector</strong>
          {!selected ? (
            <p className="small muted mt">Select a node on the canvas to edit it.</p>
          ) : (
            <div className="mt">
              <div className="field">
                <label className="label" htmlFor="node-id">
                  Node id
                </label>
                <input
                  id="node-id"
                  className="input mono"
                  value={nodeIdText}
                  onChange={(e) => setNodeIdText(e.target.value)}
                  onBlur={() => renameNodeId(selected.id, nodeIdText)}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="node-name">
                  Name
                </label>
                <input
                  id="node-name"
                  className="input"
                  value={nodeNameText}
                  onChange={(e) => setNodeNameText(e.target.value)}
                  onBlur={() => updateNode(selected.id, { name: nodeNameText.trim() || selected.name })}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="node-type">
                  Type
                </label>
                <select
                  id="node-type"
                  className="select"
                  value={selected.type}
                  onChange={(e) => {
                    const t = e.target.value as CanvasNodeType;
                    updateNode(selected.id, {
                      type: t,
                      config: JSON.parse(JSON.stringify(DEFAULT_NODE_CONFIGS[t])) as Record<string, unknown>,
                    });
                    setConfigText(JSON.stringify(DEFAULT_NODE_CONFIGS[t], null, 2));
                  }}
                >
                  {NODE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="node-config">
                  Config (JSON) — supports {'{{input}}'} and {'{{nodes.<id>.output}}'} templates
                </label>
                <textarea
                  id="node-config"
                  className="textarea mono"
                  rows={8}
                  value={configText}
                  onChange={(e) => setConfigText(e.target.value)}
                  onBlur={applyConfigText}
                />
                {configError && <div className="error-box small">{configError}</div>}
              </div>
              <button className="btn btn-sm btn-danger" onClick={() => deleteNode(selected.id)}>
                Delete node
              </button>
            </div>
          )}

          <div className="mt">
            <strong className="small">Validation</strong>
            {problems.length === 0 ? (
              <p className="small muted">Graph is valid.</p>
            ) : (
              <ul className="small">
                {problems.map((p, i) => (
                  <li key={i} style={{ color: '#f85149' }}>
                    {p}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {pro && (
        <div className="card mt">
          <strong>Raw workflow JSON (Pro)</strong>
          <p className="small muted">
            This is exactly what the canvas serializes to. Edit and “Apply” to put it back on the canvas.
          </p>
          <div className="field">
            <textarea
              className="textarea mono"
              rows={14}
              value={rawJson || JSON.stringify(workflow, null, 2)}
              onChange={(e) => setRawJson(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-primary" onClick={loadFromRawJson}>
              Apply JSON to canvas
            </button>
            <button className="btn btn-sm" onClick={() => setRawJson(JSON.stringify(workflow, null, 2))}>
              Refresh from canvas
            </button>
            <button className="btn btn-sm" onClick={() => void copyJson()}>
              Copy JSON
            </button>
            <button className="btn btn-sm" onClick={downloadJson}>
              Download JSON
            </button>
          </div>
        </div>
      )}

      <div className="card mt">
        <strong>Run workflow</strong>
        <p className="small muted">
          Runs the workflow whose id is on the canvas (<span className="mono">{graph.id}</span>) via the existing
          run endpoint. New unsaved graphs have no server definition yet — load an existing workflow first, or hand
          the JSON to the seed/definitions file.
        </p>
        <div className="field">
          <label className="label" htmlFor="run-input">
            Input JSON (optional)
          </label>
          <textarea
            id="run-input"
            className="textarea mono"
            rows={2}
            value={runInput}
            onChange={(e) => setRunInput(e.target.value)}
            placeholder='{"key": "value"}'
          />
        </div>
        <button className="btn btn-primary" onClick={() => void startRun()} disabled={running}>
          {running ? 'Starting…' : 'Run workflow'}
        </button>
      </div>
    </div>
  );
}

/** One-line summary of a node's config for the canvas card. */
function summarizeConfig(n: CanvasNode): string {
  const c = n.config ?? {};
  switch (n.type) {
    case 'agent':
      return typeof c['botId'] === 'string' && c['botId'] ? `bot: ${c['botId']}` : 'bot: —';
    case 'tool':
      return typeof c['tool'] === 'string' && c['tool'] ? `tool: ${c['tool']}` : 'tool: —';
    case 'http':
      return typeof c['url'] === 'string' && c['url'] ? String(c['url']).slice(0, 32) : 'url: —';
    case 'delay':
      return `wait ${Number(c['seconds'] ?? 0)}s`;
    case 'approval':
      return 'needs human ok';
    case 'if':
      return typeof c['condition'] === 'string' && c['condition']
        ? `if ${String(c['condition']).slice(0, 28)}`
        : 'if —';
    case 'set': {
      const n = c['assignments'] && typeof c['assignments'] === 'object' ? Object.keys(c['assignments']).length : 0;
      return `set ${n} field${n === 1 ? '' : 's'}`;
    }
    case 'code':
      return 'js function';
    case 'trigger':
      return 'entry point';
    default:
      return '';
  }
}
