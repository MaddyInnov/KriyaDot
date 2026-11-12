// SPDX-License-Identifier: Apache-2.0
// B2 (Timon parity programme): the org/member surface's Pro notice.
//
// Renders NOTHING unless the instance's license gate is ON and its
// license lacks the multi-user (Pro) feature — the decision lives in
// lib/multi-user-gate.ts (shouldShowMultiUserProNotice) so this stays a
// pure presentational component. Gate OFF (the default) and Pro-licensed
// instances see exactly the UI they had before B2: no banner, no badge,
// no upsell noise. There is deliberately no buy/checkout action here —
// B2 is packaging behaviour only, and how a license is obtained is an
// operator decision made outside this surface.

'use client';

import React from 'react';
import {
  MULTI_USER_PRO_MESSAGE,
  shouldShowMultiUserProNotice,
  type MultiUserGateStatus,
} from '../../lib/multi-user-gate';

export function MultiUserProNotice({ status }: { status: MultiUserGateStatus | null }): React.JSX.Element | null {
  if (!shouldShowMultiUserProNotice(status)) return null;
  return (
    <div className="notice" role="note" data-testid="multi-user-pro-notice">
      <strong>Pro required — multi-user teams.</strong>{' '}
      {status?.message ?? MULTI_USER_PRO_MESSAGE}
    </div>
  );
}

export default MultiUserProNotice;
