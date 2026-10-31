// SPDX-License-Identifier: Apache-2.0
'use client';

// File browser: tree view of the agent workspace + code viewer.
// Data from GET /api/files and GET /api/files/content?path=...

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CodeBlock } from '../code/CodeBlock';
import { authedFetch, pinWorkspaceFile, renameWorkspaceFile } from '../../lib/api';
import { workspaceDisplayName } from '../../lib/sessions-history';
import { useCollapsed, usePaneSize } from '../../lib/use-collapsed';
import { PaneCollapseButton, PaneResizeHandle, PaneStrip } from '../collapse';

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
  /** FL-12: pinned files sort first (stamped server-side from file_meta). */
  pinned?: boolean;
}

function formatBytes(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function TreeNode({
  node,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: FileNode) => void;
}) {
  const isDir = node.type === 'dir';
  const isOpen = expanded.has(node.path);
  const isSelected = selected === node.path;
  return (
    <div>
      <button
        className={`file-node${isSelected ? ' selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node))}
        aria-expanded={isDir ? isOpen : undefined}
      >
        <span className="file-icon">{isDir ? (isOpen ? '▾' : '▸') : '◦'}</span>
        <span className={`file-name${isDir ? ' dir' : ''}`}>{node.name}</span>
        {!isDir && node.size !== undefined && <span className="file-size">{formatBytes(node.size)}</span>}
      </button>
      {isDir && isOpen && node.children && (
        <div>
          {node.children.map((c) => (
            <TreeNode
              key={c.path}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              selected={selected}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FilesPanel() {
  const [tree, setTree] = useState<FileNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<FileNode | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  // Bot workspace switcher: '' = shared global workspace, else a bot id.
  const [bots, setBots] = useState<Array<{ id: string; name: string; workspace?: string }>>([]);
  const [scope, setScope] = useState<string>('');
  // Collapse pass: the tree pane collapses to a strip and the tree/viewer
  // split is resizable (`kriyadot:collapse:files-tree` +
  // `kriyadot:size:files-tree`); collapse remembers the width.
  const treeCol = useCollapsed('files-tree');
  const treeSize = usePaneSize('files-tree');

  const listUrl = scope ? `/api/bots/${encodeURIComponent(scope)}/files` : '/api/files';
  const contentUrl = (path: string) =>
    scope
      ? `/api/bots/${encodeURIComponent(scope)}/files/content?path=${encodeURIComponent(path)}`
      : `/api/files/content?path=${encodeURIComponent(path)}`;

  useEffect(() => {
    authedFetch('/api/bots')
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j)) setBots(j.map((b: { id: string; name: string; workspace?: string }) => ({ id: b.id, name: b.name, workspace: b.workspace })));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setError(null);
    setSelected(null);
    setContent(null);
    setExpanded(new Set());
    authedFetch(listUrl)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.ok) setTree(j.files);
        else setError(j.error ?? 'Failed to list files');
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [listUrl]);

  const openFile = useCallback((node: FileNode) => {
    setSelected(node);
    setContent(null);
    setTruncated(false);
    setLoading(true);
    authedFetch(contentUrl(node.path))
      .then((r) => r.json())
      .then((j) => {
        setLoading(false);
        if (j.ok) {
          setContent(typeof j.content === 'string' ? j.content : '');
          setTruncated(!!j.truncated);
        } else {
          setContent(null);
          setError(j.error ?? 'Failed to read file');
        }
      })
      .catch((e) => {
        setLoading(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const crumbs = useMemo(() => (selected ? selected.path.split('/') : []), [selected]);

  return (
    <div
      className={`files-layout kd-files${treeCol.collapsed ? ' kd-tree-collapsed' : ''}`}
      style={
        !treeCol.collapsed && treeSize.width
          ? { gridTemplateColumns: `${treeSize.width}px 12px minmax(0, 1fr)` }
          : undefined
      }
    >
      <div className={`files-tree glass kd-resizable${treeCol.collapsed ? ' kd-collapsed' : ''}`}>
        {treeCol.collapsed && (
          <PaneStrip label="Files" side="left" onExpand={() => treeCol.setCollapsed(false)} />
        )}
        <div className="files-tree-head">
          <span className="label">Workspace files</span>
          <select
            className="select"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            aria-label="Workspace scope"
            title="Switch between the shared workspace and per-bot workspaces"
            style={{ marginLeft: 8, fontSize: 12 }}
          >
            <option value="">Shared workspace</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}{b.workspace ? ` (${workspaceDisplayName(b.workspace)})` : ' (shared)'}
              </option>
            ))}
          </select>
          <span style={{ float: 'right' }}>
            <PaneCollapseButton label="file tree" side="left" onCollapse={() => treeCol.setCollapsed(true)} />
          </span>
        </div>
        {error && <div className="error-text">{error}</div>}
        {!tree && !error && <div className="muted">Loading…</div>}
        {tree &&
          tree.map((n) => (
            <TreeNode
              key={n.path}
              node={n}
              depth={0}
              expanded={expanded}
              selected={selected?.path ?? null}
              onToggle={toggle}
              onSelect={openFile}
            />
          ))}
      </div>
      {!treeCol.collapsed && (
        <PaneResizeHandle
          label="Resize file tree"
          edge="right"
          width={treeSize.width ?? 300}
          min={200}
          onResize={treeSize.setWidth}
          onReset={treeSize.reset}
        />
      )}
      <div className="files-viewer">
        {!selected && <div className="muted files-empty">Select a file to view its code.</div>}
        {selected && (
          <>
            <nav className="crumbs" aria-label="Breadcrumb">
              {crumbs.map((c, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="crumb-sep">/</span>}
                  <span className={i === crumbs.length - 1 ? 'crumb current' : 'crumb'}>{c}</span>
                </React.Fragment>
              ))}
              {/* FL-12: pin / rename act on the file record (endpoints in
                  file-metadata.ts; harmless error until the host wires them). */}
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                <button
                  className="btn btn-sm"
                  title="Pin this file (pinned files sort first in the Library)"
                  onClick={() => {
                    void pinWorkspaceFile(selected.path, !selected.pinned)
                      .then(() => setSelected({ ...selected, pinned: !selected.pinned }))
                      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
                  }}
                >
                  {selected.pinned ? 'Unpin' : 'Pin'}
                </button>
                <button
                  className="btn btn-sm"
                  title="Rename this file"
                  onClick={() => {
                    const next = window.prompt('Rename file', selected.path);
                    if (!next || next === selected.path) return;
                    void renameWorkspaceFile(selected.path, next)
                      .then(() => window.location.reload())
                      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
                  }}
                >
                  Rename
                </button>
              </span>
            </nav>
            {loading && <div className="muted">Loading…</div>}
            {!loading && content !== null && (
              <>
                <CodeBlock code={content} path={selected.path} maxHeight={560} />
                {truncated && <div className="muted small mt">Truncated — file is large.</div>}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
