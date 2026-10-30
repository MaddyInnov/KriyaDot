// SPDX-License-Identifier: Apache-2.0
// Permissions & identity (Muse parity P-3..P-7): one pane answering
// "what may my agent do, and as whom" — surface defaults + reset,
// per-connector action trees, revocable allowances, per-item overrides,
// and the read-only network protocol panel (Pro mode only).

'use client';

import PermissionsPanel from '../../components/panels/permissions-panel';

export default function PermissionsPage() {
  return (
    <div className="page">
      <h1>Permissions &amp; identity</h1>
      <p className="muted">
        Everything your agent is allowed to do, in one place — and who it acts as when it
        does it. Enforcement lives in the governance gateway; this pane is where you see
        and change the choices that feed it.
      </p>
      <PermissionsPanel />
    </div>
  );
}
