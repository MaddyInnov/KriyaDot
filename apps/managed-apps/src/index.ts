// SPDX-License-Identifier: Apache-2.0
// Managed Apps boot: `node dist/index.js` listens on PORT (default 4400).
// All configuration arrives via env — see ManagedAppsConfig in server.ts
// and the README's env table.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createManagedApps } from './server.js';

export { createManagedApps, createManagedAppsServer, resolveManagedAppsConfig, isEntitled, quotaFor, DEFAULT_ENTITLED_PLANS, DEFAULT_QUOTAS, DEFAULT_GLOBAL_CAP, type ManagedApps, type ManagedAppsConfig, type ResolvedManagedAppsConfig } from './server.js';
export { ManagedStore, normalizeKind, monthKeyOf, type MeterRecord, type PendingLabel, type ExecutionKind } from './store.js';
export { deriveEntityId, resolveFrontdoorPublicKey, signServiceToken, verifyServiceToken, SERVICE_TOKEN_ISSUER, type ServiceTokenPayload } from './auth.js';
export { fetchComposioClient, type ComposioApp, type ComposioClient, type ComposioConnectedAccount, type ComposioExecuteResult, type ComposioToolDefinition, type ComposioValidateResult } from './composio.js';

function main(): void {
  const port = Number(process.env.PORT ?? 4400);
  const { server, config } = createManagedApps({});
  server.listen(port, () => {
    console.log(`[managed-apps] kriyadot-managed-apps listening on port ${port}`);
    console.log(
      `[managed-apps] data dir: ${config.dataDir}; front-door key: ${config.frontdoorPublicKeyPem ? 'configured' : 'MISSING (all /v1 calls will 401)'}; ` +
        `operator Composio key: ${config.operatorKey ? 'configured' : 'MISSING (Composio routes will 503 operator_key_missing)'}`,
    );
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
