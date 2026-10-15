// SPDX-License-Identifier: Apache-2.0
// File browser API — lets the UI show the code the agent writes.
//
// The agent's write_file/edit_file tools write into config.workspaceDir
// (confined). These endpoints expose that directory read-only so the
// Workspace "Files" tab and the chat diff viewer can display project code.
// All paths are confined to the workspace root — traversal is rejected.

import fs from 'node:fs';
import path from 'node:path';

export interface FileNode {
  name: string;
  path: string; // workspace-relative, posix separators
  type: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
}

const MAX_FILES = 2000;
const MAX_FILE_BYTES = 512 * 1024; // 512 KB cap per read
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build', '.next']);

/** Resolve `p` inside `root`. Throws if it escapes. */
export function confineFile(root: string, p: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, p);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Path escapes workspace');
  }
  return resolved;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function listWorkspaceFiles(root: string, rel = ''): FileNode[] {
  const abs = confineFile(root, rel);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const nodes: FileNode[] = [];
  let count = 0;
  const walk = (dirAbs: string, dirRel: string): FileNode[] => {
    const out: FileNode[] = [];
    const ents = fs.readdirSync(dirAbs, { withFileTypes: true });
    for (const e of ents) {
      if (count >= MAX_FILES) break;
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const childRel = dirRel ? `${dirRel}/${e.name}` : e.name;
      const childAbs = path.join(dirAbs, e.name);
      count++;
      if (e.isDirectory()) {
        out.push({ name: e.name, path: childRel, type: 'dir', children: walk(childAbs, childRel) });
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(childAbs).size;
        } catch { /* ignore */ }
        out.push({ name: e.name, path: childRel, type: 'file', size });
      }
    }
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return out;
  };
  return walk(abs, toPosix(rel));
}

export function readWorkspaceFile(root: string, rel: string): { content: string; truncated: boolean; size: number } {
  const abs = confineFile(root, rel);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error('Not a file');
  if (stat.size > MAX_FILE_BYTES) {
    const buf = Buffer.alloc(MAX_FILE_BYTES);
    const fd = fs.openSync(abs, 'r');
    fs.readSync(fd, buf, 0, MAX_FILE_BYTES, 0);
    fs.closeSync(fd);
    return { content: buf.toString('utf-8'), truncated: true, size: stat.size };
  }
  return { content: fs.readFileSync(abs, 'utf-8'), truncated: false, size: stat.size };
}
