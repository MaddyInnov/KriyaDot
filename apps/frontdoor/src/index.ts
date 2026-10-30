// SPDX-License-Identifier: Apache-2.0
// Frontdoor boot: `node dist/index.js` listens on PORT (default 4300).
// All configuration arrives via env — see FrontdoorConfig in server.ts.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFrontdoor } from './server.js';

export { createFrontdoor, createFrontdoorServer, type Frontdoor, type FrontdoorConfig } from './server.js';
export { FrontdoorStore, hashToken, type Account, type LinkCode, type SessionRecord, type Workspace } from './store.js';
export {
  loadHandoffKeys,
  mintHandoffToken,
  verifyHandoffToken,
  type HandoffKeys,
  type HandoffPayload,
} from './handoff.js';
export { OidcClient, type OidcClaims } from './oidc.js';

function main(): void {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const port = Number(process.env.PORT ?? 4300);
  const { server, handoffKeys } = createFrontdoor({
    stateDir: resolve(process.env.FRONTDOOR_STATE_DIR ?? join(appDir, 'frontdoor-state')),
    siteDir: resolve(process.env.FRONTDOOR_SITE_DIR ?? join(appDir, '..', '..', 'site')),
    baseUrl: process.env.FRONTDOOR_BASE_URL,
    googleClientId: process.env.FRONTDOOR_GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.FRONTDOOR_GOOGLE_CLIENT_SECRET,
    oidcIssuer: process.env.FRONTDOOR_OIDC_ISSUER,
    handoffPrivateKeyPem: process.env.FRONTDOOR_HANDOFF_PRIVATE_KEY,
    handoffKeyFile: process.env.FRONTDOOR_HANDOFF_KEY_FILE,
  });
  server.listen(port, () => {
    console.log(`[frontdoor] kriyadot-frontdoor listening on port ${port}`);
    console.log(
      `[frontdoor] handoff public key (${handoffKeys.ephemeral ? 'ephemeral' : 'configured'}) at GET /api/handoff/public-key`,
    );
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
