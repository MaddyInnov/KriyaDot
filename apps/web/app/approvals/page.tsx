// SPDX-License-Identifier: Apache-2.0
import { ApprovalsPanel } from '../../components/panels/approvals-panel';
import { TeamInboxPanel } from '../../components/panels/people-panel';

export default function ApprovalsPage() {
  return (
    <>
      <ApprovalsPanel />
      <TeamInboxPanel />
    </>
  );
}
