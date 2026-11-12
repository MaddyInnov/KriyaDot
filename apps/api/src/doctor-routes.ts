// SPDX-License-Identifier: Apache-2.0
// Doctor REST surface (A14): GET /api/doctor → { ok, report }.
//
// The report is the same DoctorReport the `kriyadot doctor` CLI verb
// renders (doctor.ts is the contract). HTTP status stays 200 even when
// checks fail — a failing check is data for the operator, not a failed
// request; the CLI maps report.exitCode to its process exit code.
//
// HOST WIRING (index.ts):
//   app.use('/api/doctor', createDoctorRouter({
//     dataDir: config.dataDir, guard: resourceGuard, pcAccessStore,
//     counts: () => ({ activeTurns: agentRuntime.turnStates.size }),
//   }));

import express, { type Router } from 'express';
import { runDoctor, type DoctorHost } from './doctor.js';

export function createDoctorRouter(host: DoctorHost): Router {
  const router = express.Router();
  router.get('/', async (_req, res) => {
    try {
      const report = await runDoctor({ dataDir: host.dataDir, host });
      res.json({ ok: true, report });
    } catch (err) {
      // runDoctor degrades per-section and should not throw; this is a
      // last-resort guard so the route still answers honestly.
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return router;
}
