// SPDX-License-Identifier: Apache-2.0
// Departments (chat polish): bot folders with shared instructions.
// A department groups bots; each bot belongs to at most one department.
// Shared instructions are DATA here — runtime prompt injection is a
// separate workstream; it should call getDepartmentInstructions().
//
// HOST WIRING (parent):
//   const departmentStore = new DepartmentStore(config.dataDir);
//   app.use('/api', createDepartmentsRouter({ store: departmentStore, audit }));
// Routes: GET/POST /departments · PATCH/DELETE /departments/:id
//         POST /departments/:id/bots { botId } · DELETE /departments/:id/bots/:botId
//         GET /departments/by-bot/:botId

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';

export interface Department { id: string; name: string; sharedInstructions: string; createdAt: number }

interface DepartmentsFile { departments: Department[]; membership: Record<string, string> }

export class DepartmentStore {
  private data: DepartmentsFile = { departments: [], membership: {} };
  constructor(private readonly dataDir?: string) {
    if (dataDir) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'departments.json'), 'utf8')) as DepartmentsFile;
        if (parsed && Array.isArray(parsed.departments)) this.data = { departments: parsed.departments, membership: parsed.membership ?? {} };
      } catch { /* start empty */ }
    }
  }
  private save(): void {
    if (!this.dataDir) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = path.join(this.dataDir, 'departments.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(this.dataDir, 'departments.json'));
  }
  list(): Array<Department & { botIds: string[] }> {
    return this.data.departments.map((d) => ({ ...d, botIds: this.botsIn(d.id) }));
  }
  get(id: string): Department | undefined { return this.data.departments.find((d) => d.id === id); }
  create(input: { name: string; sharedInstructions?: string }): Department {
    const name = input.name.trim(); if (!name) throw new Error('name is required');
    const dept: Department = {
      id: `dept_${randomUUID().replace(/-/g, '').slice(0, 16)}`, name: name.slice(0, 80),
      sharedInstructions: (input.sharedInstructions ?? '').slice(0, 8000), createdAt: Date.now(),
    };
    this.data.departments.push(dept); this.save(); return dept;
  }
  update(id: string, patch: { name?: string; sharedInstructions?: string }): Department | undefined {
    const d = this.get(id); if (!d) return undefined;
    if (patch.name !== undefined) { const n = patch.name.trim(); if (!n) throw new Error('name is required'); d.name = n.slice(0, 80); }
    if (patch.sharedInstructions !== undefined) d.sharedInstructions = patch.sharedInstructions.slice(0, 8000);
    this.save(); return d;
  }
  remove(id: string): boolean {
    const before = this.data.departments.length;
    this.data.departments = this.data.departments.filter((d) => d.id !== id);
    if (this.data.departments.length === before) return false;
    for (const [bot, dept] of Object.entries(this.data.membership)) if (dept === id) delete this.data.membership[bot];
    this.save(); return true;
  }
  /** Move a bot into a department (removing it from any previous one). */
  addBot(deptId: string, botId: string): boolean {
    if (!this.get(deptId) || !botId.trim()) return false;
    this.data.membership[botId] = deptId; this.save(); return true;
  }
  removeBot(deptId: string, botId: string): boolean {
    if (this.data.membership[botId] !== deptId) return false;
    delete this.data.membership[botId]; this.save(); return true;
  }
  botsIn(deptId: string): string[] {
    return Object.entries(this.data.membership).filter(([, d]) => d === deptId).map(([b]) => b);
  }
  departmentOf(botId: string): Department | undefined {
    const id = this.data.membership[botId];
    return id ? this.get(id) : undefined;
  }
  /** Shared instructions for a bot's department ('' when unassigned). */
  instructionsForBot(botId: string): string {
    return this.departmentOf(botId)?.sharedInstructions ?? '';
  }
}

/** Helper for the later runtime-injection workstream. */
export function getDepartmentInstructions(store: DepartmentStore, botId: string): string {
  return store.instructionsForBot(botId);
}

export function createDepartmentsRouter(deps: { dataDir?: string; store?: DepartmentStore; audit?: (a: string, f: Record<string, unknown>) => void }): express.Router {
  const store = deps.store ?? new DepartmentStore(deps.dataDir);
  const router = express.Router();
  const bad = (res: express.Response, s: number, e: string) => res.status(s).json({ ok: false, error: e });

  router.get('/departments', (_req, res) => res.json({ ok: true, departments: store.list() }));
  router.post('/departments', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const department = store.create({ name: typeof b.name === 'string' ? b.name : '', sharedInstructions: typeof b.sharedInstructions === 'string' ? b.sharedInstructions : undefined });
      deps.audit?.('chat.department_create', { detail: { departmentId: department.id } });
      res.status(201).json({ ok: true, department });
    } catch (e) { bad(res, 400, e instanceof Error ? e.message : String(e)); }
  });
  router.patch('/departments/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const department = store.update(req.params.id, {
        ...(typeof b.name === 'string' ? { name: b.name } : {}),
        ...(typeof b.sharedInstructions === 'string' ? { sharedInstructions: b.sharedInstructions } : {}),
      });
      if (!department) { bad(res, 404, 'department not found'); return; }
      res.json({ ok: true, department });
    } catch (e) { bad(res, 400, e instanceof Error ? e.message : String(e)); }
  });
  router.delete('/departments/:id', (req, res) => {
    if (!store.remove(req.params.id)) { bad(res, 404, 'department not found'); return; }
    deps.audit?.('chat.department_delete', { detail: { departmentId: req.params.id } });
    res.json({ ok: true, deleted: req.params.id });
  });
  router.get('/departments/by-bot/:botId', (req, res) => {
    const dept = store.departmentOf(req.params.botId);
    res.json({ ok: true, botId: req.params.botId, department: dept ?? null, sharedInstructions: dept?.sharedInstructions ?? '' });
  });
  router.post('/departments/:id/bots', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const botId = typeof b.botId === 'string' ? b.botId : '';
    if (!store.addBot(req.params.id, botId)) { bad(res, 404, 'department not found or botId missing'); return; }
    deps.audit?.('chat.department_move_bot', { detail: { departmentId: req.params.id, botId } });
    res.json({ ok: true, departmentId: req.params.id, botId, botIds: store.botsIn(req.params.id) });
  });
  router.delete('/departments/:id/bots/:botId', (req, res) => {
    if (!store.removeBot(req.params.id, req.params.botId)) { bad(res, 404, 'bot is not in this department'); return; }
    res.json({ ok: true, removed: true });
  });
  return router;
}
