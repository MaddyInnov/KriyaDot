// SPDX-License-Identifier: Apache-2.0
'use client';

/**
 * DatabasesPanel — Notion-style databases inside the Notes area.
 *
 * A database is a page-like object with a typed schema (text / number /
 * select / date / checkbox columns); records are child rows rendered as a
 * table grid (sort + filter + inline editing) or, when the schema has a
 * select column, as a Kanban board (group by the select column, drag cards
 * between columns). CSV import accepts Notion database CSV exports.
 *
 * Mount inside the notes area, e.g. in app/notes/page.tsx:
 *   const [tab, setTab] = useState<'notes' | 'databases'>('notes');
 *   ...
 *   {tab === 'notes' ? <NotesPanel /> : <DatabasesPanel />}
 *
 * Talk to the API at /api/databases (registerDatabasesRoutes) and
 * /api/notion (registerNotionImportRoutes).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authedFetch } from '../../lib/api';

type ColumnType = 'text' | 'number' | 'select' | 'date' | 'checkbox';
type CellValue = string | number | boolean | null;

interface DatabaseColumn {
  id: string;
  name: string;
  type: ColumnType;
  options?: string[];
}

interface Database {
  id: string;
  name: string;
  description: string;
  columns: DatabaseColumn[];
  createdAt: number;
  updatedAt: number;
  rowCount?: number;
}

interface DatabaseRow {
  id: string;
  databaseId: string;
  values: Record<string, CellValue>;
  createdAt: number;
  updatedAt: number;
}

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await authedFetch(path, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${detail || res.statusText}`);
  }
  return (await res.json()) as T;
};

const COLUMN_TYPES: ColumnType[] = ['text', 'number', 'select', 'date', 'checkbox'];
const TYPE_ICON: Record<ColumnType, string> = {
  text: '≡',
  number: '#',
  select: '▾',
  date: '◷',
  checkbox: '☑',
};

function cellText(col: DatabaseColumn, v: CellValue): string {
  if (v === null || v === undefined) return '';
  if (col.type === 'checkbox') return v ? '✓' : '☐';
  return String(v);
}

/* ------------------------------------------------------------------ */
/* Claymorphism + glassmorphism style helpers (theme CSS vars)          */
/* ------------------------------------------------------------------ */

const card: React.CSSProperties = {
  background: 'var(--glass-bg)',
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  border: '1px solid var(--glass-border)',
  borderRadius: 'var(--radius)',
  boxShadow: 'var(--clay-shadow)',
};

const btn: React.CSSProperties = {
  border: '1px solid var(--glass-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--glass-bg)',
  backdropFilter: 'blur(10px)',
  boxShadow: 'var(--clay-shadow-sm)',
  color: 'var(--text)',
  padding: '6px 12px',
  fontSize: 13,
  cursor: 'pointer',
};

const btnPrimary: React.CSSProperties = {
  ...btn,
  background: 'linear-gradient(135deg, var(--accent-from), var(--accent-to))',
  color: 'var(--accent-ink)',
  border: 'none',
  fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--surface)',
  color: 'var(--text)',
  padding: '6px 10px',
  fontSize: 13,
  boxShadow: 'var(--clay-pressed)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

const selectPill = (col: DatabaseColumn, v: CellValue): React.CSSProperties => {
  const idx = (col.options ?? []).indexOf(String(v ?? ''));
  const hues = [268, 200, 150, 330, 20, 100, 180, 300];
  const hue = idx >= 0 ? hues[idx % hues.length] : 220;
  return {
    display: 'inline-block',
    padding: '1px 10px',
    borderRadius: 999,
    fontSize: 12,
    background: `hsla(${hue}, 70%, 60%, 0.18)`,
    border: `1px solid hsla(${hue}, 70%, 60%, 0.45)`,
    color: 'var(--text)',
  };
};

/* ------------------------------------------------------------------ */
/* Cell editor                                                         */
/* ------------------------------------------------------------------ */

function CellEditor({
  col,
  value,
  onCommit,
}: {
  col: DatabaseColumn;
  value: CellValue;
  onCommit: (v: string | boolean | null) => void;
}) {
  if (col.type === 'checkbox') {
    return (
      <button
        onClick={() => onCommit(!(value === true))}
        style={{ ...btn, padding: '2px 10px', fontSize: 14 }}
        aria-label={`toggle ${col.name}`}
      >
        {value === true ? '✓' : '☐'}
      </button>
    );
  }
  if (col.type === 'select') {
    return (
      <select
        value={value === null ? '' : String(value)}
        onChange={(e) => onCommit(e.target.value === '' ? null : e.target.value)}
        style={inputStyle}
      >
        <option value="">—</option>
        {(col.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {value !== null && !(col.options ?? []).includes(String(value)) && (
          <option value={String(value)}>{String(value)} (new)</option>
        )}
      </select>
    );
  }
  const inputType = col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : 'text';
  return (
    <input
      type={inputType}
      defaultValue={value === null ? '' : String(value)}
      placeholder={col.type === 'date' ? 'YYYY-MM-DD' : ''}
      onBlur={(e) => {
        const raw = e.target.value;
        onCommit(raw === '' ? null : raw);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      style={inputStyle}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Main panel                                                          */
/* ------------------------------------------------------------------ */

export function DatabasesPanel() {
  const [databases, setDatabases] = useState<Database[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [view, setView] = useState<'table' | 'board'>('table');
  const [boardColumn, setBoardColumn] = useState<string | null>(null);
  const [sort, setSort] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showSchema, setShowSchema] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => databases.find((d) => d.id === selectedId) ?? null,
    [databases, selectedId],
  );
  const selectColumns = useMemo(
    () => (selected ? selected.columns.filter((c) => c.type === 'select') : []),
    [selected],
  );

  const loadDatabases = useCallback(async () => {
    try {
      const list = await api<Database[]>('/api/databases');
      setDatabases(list);
      if (list.length > 0 && !list.some((d) => d.id === selectedId)) {
        setSelectedId(list[0].id);
      } else if (list.length === 0) {
        setSelectedId(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load databases');
    }
  }, [selectedId]);

  const loadRows = useCallback(async () => {
    if (!selectedId) {
      setRows([]);
      return;
    }
    try {
      const params = new URLSearchParams();
      if (sort) params.set('sort', sort);
      if (q.trim()) params.set('q', q.trim());
      const qs = params.toString();
      const list = await api<DatabaseRow[]>(
        `/api/databases/${selectedId}/rows${qs ? `?${qs}` : ''}`,
      );
      setRows(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load rows');
    }
  }, [selectedId, sort, q]);

  useEffect(() => {
    void loadDatabases();
  }, [loadDatabases]);
  useEffect(() => {
    void loadRows();
  }, [loadRows]);
  useEffect(() => {
    // Default the board to the first select column.
    if (view === 'board' && selectColumns.length > 0 && !boardColumn) {
      setBoardColumn(selectColumns[0].id);
    }
  }, [view, selectColumns, boardColumn]);

  const refreshDb = useCallback(async () => {
    await loadDatabases();
  }, [loadDatabases]);

  const patchRow = async (rowId: string, colId: string, v: string | boolean | null) => {
    setError(null);
    try {
      const updated = await api<DatabaseRow>(`/api/databases/${selectedId}/rows/${rowId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { [colId]: v } }),
      });
      setRows((rs) => rs.map((r) => (r.id === rowId ? updated : r)));
      // A new select option may have been auto-created → refresh schema.
      if (selected && selected.columns.some((c) => c.id === colId && c.type === 'select')) {
        await refreshDb();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to update row');
    }
  };

  const addRow = async (preset?: Record<string, CellValue>) => {
    if (!selectedId) return;
    setError(null);
    try {
      const row = await api<DatabaseRow>(`/api/databases/${selectedId}/rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: preset ?? {} }),
      });
      setRows((rs) => [...rs, row]);
      await refreshDb();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to add row');
    }
  };

  const deleteRow = async (rowId: string) => {
    if (!selectedId) return;
    setError(null);
    try {
      await api(`/api/databases/${selectedId}/rows/${rowId}`, { method: 'DELETE' });
      setRows((rs) => rs.filter((r) => r.id !== rowId));
      await refreshDb();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to delete row');
    }
  };

  const toggleSort = (colId: string) => {
    setSort((s) => {
      if (s === `${colId}:asc`) return `${colId}:desc`;
      if (s === `${colId}:desc`) return null;
      return `${colId}:asc`;
    });
  };

  const onDropCard = async (e: React.DragEvent, rowId: string, targetValue: string | null) => {
    e.preventDefault();
    if (!boardColumn) return;
    await patchRow(rowId, boardColumn, targetValue);
  };

  /* ---------------- CSV / Notion ZIP import ---------------- */

  const importCsvFile = async (file: File) => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const text = await file.text();
      const result = await api<{ imported: number; skipped: number }>(
        `/api/databases/${selectedId}/import-csv`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv: text }),
        },
      );
      await loadRows();
      await refreshDb();
      if (result.skipped > 0) setError(`${result.imported} rows imported, ${result.skipped} cells skipped (bad type)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'CSV import failed');
    } finally {
      setBusy(false);
    }
  };

  const importZipFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const base64 = btoa(
        Array.from(new Uint8Array(buf))
          .map((b) => String.fromCharCode(b))
          .join(''),
      );
      const result = await api<{
        pages: Array<{ title: string }>;
        databases: Array<{ name: string; rowCount: number }>;
        warnings: string[];
      }>('/api/notion/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zip: base64 }),
      });
      await refreshDb();
      const warns = result.warnings.length > 0 ? ` Warnings: ${result.warnings.join('; ')}` : '';
      setError(
        `Imported ${result.pages.length} page(s), ${result.databases.length} database(s).${warns}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Notion import failed');
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- render ---------------- */

  return (
    <div style={{ display: 'flex', gap: 16, padding: 16, height: '100%', boxSizing: 'border-box' }}>
      {/* Database list */}
      <div style={{ ...card, width: 240, flexShrink: 0, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: 14 }}>Databases</strong>
          <button style={btnPrimary} onClick={() => setShowCreate(true)}>
            + New
          </button>
        </div>
        {databases.map((d) => (
          <button
            key={d.id}
            onClick={() => setSelectedId(d.id)}
            style={{
              ...btn,
              textAlign: 'left',
              background: d.id === selectedId ? 'var(--accent-soft)' : 'var(--glass-bg)',
              fontWeight: d.id === selectedId ? 600 : 400,
            }}
          >
            <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {d.name}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
              {d.rowCount ?? 0} rows · {d.columns.length} cols
            </div>
          </button>
        ))}
        {databases.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--text-2)' }}>
            No databases yet. Create one, or import a Notion export below.
          </p>
        )}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button style={btn} disabled={busy} onClick={() => zipRef.current?.click()}>
            ⬆ Import Notion ZIP
          </button>
          <input
            ref={zipRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importZipFile(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {error && (
          <div
            style={{
              ...card,
              padding: '8px 12px',
              fontSize: 13,
              background: 'var(--amber-soft)',
              border: '1px solid var(--amber)',
            }}
            role="alert"
          >
            {error}
            <button style={{ ...btn, marginLeft: 12 }} onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {!selected ? (
          <div style={{ ...card, padding: 32, textAlign: 'center', color: 'var(--text-2)' }}>
            Select or create a database to get started.
          </div>
        ) : (
          <>
            <div style={{ ...card, padding: '12px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{selected.name}</div>
                {selected.description && (
                  <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{selected.description}</div>
                )}
              </div>
              <input
                placeholder="Search rows…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                style={{ ...inputStyle, width: 200 }}
              />
              <div style={{ display: 'flex', gap: 4, ...card, padding: 4, boxShadow: 'var(--clay-shadow-sm)' }}>
                {(['table', 'board'] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    style={{
                      ...btn,
                      border: 'none',
                      boxShadow: 'none',
                      background: view === v ? 'var(--accent-soft)' : 'transparent',
                      fontWeight: view === v ? 600 : 400,
                      textTransform: 'capitalize',
                    }}
                  >
                    {v === 'table' ? '▦ Table' : '⧉ Board'}
                  </button>
                ))}
              </div>
              {view === 'board' && selectColumns.length > 0 && (
                <select
                  value={boardColumn ?? ''}
                  onChange={(e) => setBoardColumn(e.target.value)}
                  style={{ ...inputStyle, width: 160 }}
                  title="Group board by"
                >
                  {selectColumns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              <button style={btn} onClick={() => setShowSchema((s) => !s)}>
                ⚙ Schema
              </button>
              <button style={btn} onClick={() => fileRef.current?.click()} disabled={busy}>
                ⬆ CSV
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importCsvFile(f);
                  e.target.value = '';
                }}
              />
              <button style={btnPrimary} onClick={() => void addRow()}>
                + Row
              </button>
            </div>

            {showSchema && (
              <SchemaEditor
                database={selected}
                onChanged={async () => {
                  await refreshDb();
                  await loadRows();
                }}
                onDeleted={async () => {
                  setSelectedId(null);
                  await refreshDb();
                }}
              />
            )}

            {showCreate && (
              <CreateDatabaseForm
                onCreated={async (db) => {
                  setShowCreate(false);
                  await refreshDb();
                  setSelectedId(db.id);
                }}
                onCancel={() => setShowCreate(false)}
              />
            )}

            {view === 'table' ? (
              <TableView
                database={selected}
                rows={rows}
                sort={sort}
                onToggleSort={toggleSort}
                onPatchRow={(rowId, colId, v) => void patchRow(rowId, colId, v)}
                onDeleteRow={(rowId) => void deleteRow(rowId)}
              />
            ) : (
              <BoardView
                database={selected}
                rows={rows}
                groupColumnId={boardColumn}
                onDropCard={(e, rowId, v) => void onDropCard(e, rowId, v)}
                onAddCard={(v) =>
                  void addRow(boardColumn ? { [boardColumn]: v } : undefined)
                }
                onPatchRow={(rowId, colId, v) => void patchRow(rowId, colId, v)}
                onDeleteRow={(rowId) => void deleteRow(rowId)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Table view                                                          */
/* ------------------------------------------------------------------ */

function TableView({
  database,
  rows,
  sort,
  onToggleSort,
  onPatchRow,
  onDeleteRow,
}: {
  database: Database;
  rows: DatabaseRow[];
  sort: string | null;
  onToggleSort: (colId: string) => void;
  onPatchRow: (rowId: string, colId: string, v: string | boolean | null) => void;
  onDeleteRow: (rowId: string) => void;
}) {
  return (
    <div style={{ ...card, padding: 0, overflow: 'auto', flex: 1 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead style={{ position: 'sticky', top: 0, background: 'var(--surface-2)', zIndex: 1 }}>
          <tr>
            {database.columns.map((col) => {
              const active = sort?.startsWith(`${col.id}:`);
              return (
                <th
                  key={col.id}
                  onClick={() => onToggleSort(col.id)}
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    userSelect: 'none',
                    background: active ? 'var(--accent-soft)' : undefined,
                  }}
                  title="Click to sort"
                >
                  <span style={{ color: 'var(--text-3)', marginRight: 6 }}>{TYPE_ICON[col.type]}</span>
                  {col.name}
                  {active && (sort === `${col.id}:asc` ? ' ▲' : ' ▼')}
                </th>
              );
            })}
            <th style={{ width: 48, borderBottom: '1px solid var(--border)' }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} style={{ borderBottom: '1px solid var(--border)' }}>
              {database.columns.map((col) => {
                const v = row.values[col.id] ?? null;
                return (
                  <td key={col.id} style={{ padding: '6px 12px', minWidth: 120 }}>
                    {col.type === 'select' && v !== null ? (
                      <span style={selectPill(col, v)}>{cellText(col, v)}</span>
                    ) : col.type === 'checkbox' ? (
                      <CellEditor col={col} value={v} onCommit={(nv) => onPatchRow(row.id, col.id, nv)} />
                    ) : (
                      <CellEditor col={col} value={v} onCommit={(nv) => onPatchRow(row.id, col.id, nv)} />
                    )}
                  </td>
                );
              })}
              <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                <button
                  style={{ ...btn, padding: '2px 8px', color: 'var(--red)' }}
                  onClick={() => onDeleteRow(row.id)}
                  title="Delete row"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={database.columns.length + 1}
                style={{ padding: 24, textAlign: 'center', color: 'var(--text-2)' }}
              >
                No rows yet — add one with “+ Row” or import a CSV.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Board (Kanban) view — groups rows by a select column                */
/* ------------------------------------------------------------------ */

function BoardView({
  database,
  rows,
  groupColumnId,
  onDropCard,
  onAddCard,
  onPatchRow,
  onDeleteRow,
}: {
  database: Database;
  rows: DatabaseRow[];
  groupColumnId: string | null;
  onDropCard: (e: React.DragEvent, rowId: string, v: string | null) => void;
  onAddCard: (v: string | null) => void;
  onPatchRow: (rowId: string, colId: string, v: string | boolean | null) => void;
  onDeleteRow: (rowId: string) => void;
}) {
  const groupCol = database.columns.find((c) => c.id === groupColumnId) ?? null;
  const titleCol = database.columns.find((c) => c.type === 'text') ?? database.columns[0];
  const [dragOver, setDragOver] = useState<string | null>(null);

  if (!groupCol) {
    return (
      <div style={{ ...card, padding: 32, textAlign: 'center', color: 'var(--text-2)' }}>
        Add a <strong>select</strong> column in ⚙ Schema to use the board view.
      </div>
    );
  }

  const lanes: Array<{ value: string | null; label: string }> = [
    ...(groupCol.options ?? []).map((o) => ({ value: o as string | null, label: o })),
    { value: null, label: 'No status' },
  ];

  return (
    <div style={{ display: 'flex', gap: 12, overflowX: 'auto', flex: 1, paddingBottom: 8 }}>
      {lanes.map((lane) => {
        const laneRows = rows.filter((r) => {
          const v = r.values[groupCol.id] ?? null;
          return lane.value === null ? v === null : v === lane.value;
        });
        const key = lane.value ?? '__none__';
        return (
          <div
            key={key}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(key);
            }}
            onDragLeave={() => setDragOver((d) => (d === key ? null : d))}
            onDrop={(e) => {
              setDragOver(null);
              const rowId = e.dataTransfer.getData('text/db-row');
              if (rowId) onDropCard(e, rowId, lane.value);
            }}
            style={{
              ...card,
              minWidth: 260,
              maxWidth: 300,
              flexShrink: 0,
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              alignSelf: 'flex-start',
              maxHeight: '100%',
              overflowY: 'auto',
              outline: dragOver === key ? '2px dashed var(--accent)' : 'none',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 13 }}>
                {lane.value !== null ? <span style={selectPill(groupCol, lane.value)}>{lane.label}</span> : lane.label}
              </strong>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{laneRows.length}</span>
            </div>
            {laneRows.map((row) => (
              <div
                key={row.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/db-row', row.id)}
                style={{
                  ...card,
                  boxShadow: 'var(--clay-shadow-sm)',
                  padding: 10,
                  cursor: 'grab',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>
                    {cellText(titleCol, row.values[titleCol.id] ?? null) || '(untitled)'}
                  </strong>
                  <button
                    style={{ ...btn, padding: '0 6px', fontSize: 11, color: 'var(--red)' }}
                    onClick={() => onDeleteRow(row.id)}
                    title="Delete row"
                  >
                    ✕
                  </button>
                </div>
                {database.columns
                  .filter((c) => c.id !== groupCol.id && c.id !== titleCol.id)
                  .slice(0, 4)
                  .map((c) => (
                    <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                      <span style={{ color: 'var(--text-3)', minWidth: 64 }}>{c.name}</span>
                      {c.type === 'select' && row.values[c.id] != null ? (
                        <span style={selectPill(c, row.values[c.id])}>{cellText(c, row.values[c.id])}</span>
                      ) : (
                        <span style={{ flex: 1 }}>
                          <CellEditor
                            col={c}
                            value={row.values[c.id] ?? null}
                            onCommit={(v) => onPatchRow(row.id, c.id, v)}
                          />
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            ))}
            <button style={{ ...btn, fontSize: 12 }} onClick={() => onAddCard(lane.value)}>
              + Add card
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Schema editor                                                       */
/* ------------------------------------------------------------------ */

function SchemaEditor({
  database,
  onChanged,
  onDeleted,
}: {
  database: Database;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [columns, setColumns] = useState<DatabaseColumn[]>(database.columns);
  const [name, setName] = useState(database.name);
  const [description, setDescription] = useState(database.description);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setColumns(database.columns);
    setName(database.name);
    setDescription(database.description);
    setConfirmDelete(false);
  }, [database.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setError(null);
    try {
      await api<Database>(`/api/databases/${database.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, columns }),
      });
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to save schema');
    }
  };

  const addColumn = () => {
    setColumns((cs) => [
      ...cs,
      { id: `col_${Date.now().toString(36)}`, name: `Column ${cs.length + 1}`, type: 'text' as ColumnType },
    ]);
  };

  const removeColumn = (id: string) => {
    setColumns((cs) => cs.filter((c) => c.id !== id));
  };

  const setColumn = (id: string, patch: Partial<DatabaseColumn>) => {
    setColumns((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const doDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await api(`/api/databases/${database.id}`, { method: 'DELETE' });
    await onDeleted();
  };

  return (
    <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 14 }}>Schema</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnPrimary} onClick={() => void save()}>
            Save
          </button>
          <button
            style={{ ...btn, color: 'var(--red)' }}
            onClick={() => void doDelete()}
          >
            {confirmDelete ? 'Confirm delete database' : 'Delete database'}
          </button>
        </div>
      </div>
      {error && (
        <div style={{ fontSize: 12, color: 'var(--red)' }} role="alert">
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} placeholder="Database name" />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          style={inputStyle}
          placeholder="Description (optional)"
        />
      </div>
      {columns.map((col) => (
        <div key={col.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={col.name}
            onChange={(e) => setColumn(col.id, { name: e.target.value })}
            style={{ ...inputStyle, maxWidth: 220 }}
          />
          <select
            value={col.type}
            onChange={(e) => setColumn(col.id, { type: e.target.value as ColumnType })}
            style={{ ...inputStyle, maxWidth: 140 }}
          >
            {COLUMN_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_ICON[t]} {t}
              </option>
            ))}
          </select>
          {col.type === 'select' && (
            <input
              value={(col.options ?? []).join(', ')}
              onChange={(e) =>
                setColumn(col.id, {
                  options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean),
                })
              }
              style={inputStyle}
              placeholder="options, comma, separated"
              title="Select options (comma-separated)"
            />
          )}
          <button style={{ ...btn, color: 'var(--red)' }} onClick={() => removeColumn(col.id)}>
            Remove
          </button>
        </div>
      ))}
      <button style={btn} onClick={addColumn}>
        + Add column
      </button>
      <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
        Removing a column deletes that column's values from all rows.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create database form                                                */
/* ------------------------------------------------------------------ */

function CreateDatabaseForm({
  onCreated,
  onCancel,
}: {
  onCreated: (db: Database) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) {
      setError('Give the database a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const db = await api<Database>('/api/databases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          columns: [
            { id: 'title', name: 'Name', type: 'text' },
            { id: 'status', name: 'Status', type: 'select', options: ['Todo', 'Doing', 'Done'] },
          ],
        }),
      });
      await onCreated(db);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to create database');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ ...card, padding: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void create();
        }}
        placeholder="New database name…"
        style={inputStyle}
        autoFocus
      />
      <button style={btnPrimary} onClick={() => void create()} disabled={busy}>
        Create
      </button>
      <button style={btn} onClick={onCancel}>
        Cancel
      </button>
      {error && (
        <span style={{ fontSize: 12, color: 'var(--red)' }} role="alert">
          {error}
        </span>
      )}
      <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
        Starts with Name + Status columns — edit the schema after.
      </span>
    </div>
  );
}
