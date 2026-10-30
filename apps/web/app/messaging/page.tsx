// SPDX-License-Identifier: Apache-2.0
'use client';

// Messaging channels page: connection status + unified secure connect /
// disconnect per provider (CH-2/CH-3), per-channel richness config, and the
// durable provider side chats (CH-1/CH-5). Nav entry is added by the
// integrator (see the wave-4 WIRING note) — this page is reachable at
// /messaging once linked.

import { ChannelsPanel } from '../../components/channels/channels-panel';
import { MessagingChannelsPanel } from '../../components/channels/messaging-channels-panel';

export default function MessagingPage() {
  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: 16 }}>
      <h1>Messaging</h1>
      <p className="muted small">
        Your agent on the channels you already use — connected securely, with structured approvals and
        one mirrored side chat per conversation.
      </p>
      <MessagingChannelsPanel />
      <ChannelsPanel />
    </main>
  );
}
