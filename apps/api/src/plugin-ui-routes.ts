// SPDX-License-Identifier: Apache-2.0
// CA-24 (reduced slice): plugin UI contribution serving.
//
// Plugins may declare ONE sandboxed web component (see
// @mvp/plugins bundle.ts uiContribution). This register-style module
// serves its static entry behind:
//   - a default-off feature flag (PLUGIN_UI_ENABLED),
//   - a per-render nonce + the MCP-Apps-style CSP from @mvp/plugins,
//   - sandbox iframe headers, connect-src 'none' — the component can
//     only talk to the host via postMessage, never the network, and
//     never receives a key or token.
// Manifest validation is covered in @mvp/plugins tests; here we test
// the flag gate and the served headers/document.

import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isPluginUiEnabled, pluginUiCsp, renderPluginUiIframe, type PluginUiContribution } from '@mvp/plugins';

export interface PluginUiDeps {
  /** Feature flag value (env PLUGIN_UI_ENABLED in the host). Default off. */
  enabled?: boolean | string;
  /** Resolve a plugin's UI contribution + file contents. Host binds PluginManager. */
  resolveContribution: (pluginId: string) => { contribution: PluginUiContribution; html: string } | undefined;
  audit?: (action: string, fields: Record<string, unknown>) => void;
}

export function pluginUiNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** Register-style routes. Mount under /api/plugin-ui (wiring note). */
export function registerPluginUiRoutes(router: Router, deps: PluginUiDeps): void {
  router.get('/:pluginId/frame', (req: Request, res: Response) => {
    if (!isPluginUiEnabled(deps.enabled)) {
      res.status(404).json({ error: 'plugin UI contributions are disabled (PLUGIN_UI_ENABLED is off by default)' });
      return;
    }
    const found = deps.resolveContribution(req.params.pluginId);
    if (!found) { res.status(404).json({ error: 'plugin has no UI contribution' }); return; }
    const nonce = pluginUiNonce();
    deps.audit?.('plugin-ui.render', { pluginId: req.params.pluginId });
    res.status(200)
      .set('Content-Security-Policy', pluginUiCsp(nonce))
      .set('X-Content-Type-Options', 'nosniff')
      .type('html')
      .send(
        '<!doctype html><html><head><meta charset="utf-8"><title>' +
          found.contribution.title.replace(/[<>&"]/g, '') +
          '</title></head><body>' +
          renderPluginUiIframe({ pluginId: req.params.pluginId, contribution: found.contribution, src: 'about:srcdoc', nonce }) +
          '<template id="plugin-ui-content">' + found.html.replace(/<\/template>/gi, '') + '</template>' +
          '</body></html>',
      );
  });
}
