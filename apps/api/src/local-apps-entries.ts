// SPDX-License-Identifier: Apache-2.0
// Adapter: local desktop apps (blender.ts listLocalApps) → ConnectedAppEntry
// rows for the Connected Apps aggregate view (connected-apps.ts sources).
//
// Honest capability framing: only Blender has a real bridge (its own
// Python/background mode). Every other local app is GUI-only — a bot can
// open it and drive it through governed computer use; there is NO API-level
// control, and the copy here never claims otherwise.

import {
  createDefaultLocalAppsProbe,
  listLocalApps,
  type LocalAppInfo,
} from './blender.js';
import type { ConnectedAppEntry } from './connected-apps.js';

const BLENDER_CAPABILITIES = [
  'Open .blend files in Blender',
  'Run approved Blender Python scripts in background mode',
  'Render images and animations into the workspace',
];

const GUI_CAPABILITIES = [
  'Open the app on this computer',
  'Drive it through governed computer use (screen, mouse, keyboard) — no API control',
];

function entryFor(app: LocalAppInfo): ConnectedAppEntry {
  const isBlender = app.key === 'blender';
  return {
    id: `local:${app.key}`,
    name: app.name,
    category: 'local',
    source: 'local',
    connectionType: 'On this computer',
    status: app.installed ? 'on_this_computer' : 'not_installed',
    accounts: [],
    enabledBotIds: [],
    capabilities: isBlender ? BLENDER_CAPABILITIES : GUI_CAPABILITIES,
    starterTasks: isBlender
      ? [
          {
            label: 'Check Blender status',
            prompt:
              'Use the blender_status tool to check whether Blender is installed on this computer and report its version. Do not install anything.',
          },
          {
            label: 'Render a scene',
            prompt:
              'I want to render a Blender scene. First call blender_status, then ask me for the .blend file name inside the workspace and use blender_render to render frame 1 into the workspace. Any script execution needs my approval.',
          },
        ]
      : [
          {
            label: `Open ${app.name}`,
            prompt: `Open ${app.name} on this computer using computer_open_app.`,
          },
        ],
    local: {
      installed: app.installed,
      ...(app.version ? { version: app.version } : {}),
      ...(app.running !== undefined ? { running: app.running === true } : {}),
      ...(app.detectionNote ? { detectionNote: app.detectionNote } : {}),
    },
  };
}

/** ConnectedAppEntry[] for every catalogued local app (never throws). */
export async function localAppEntries(): Promise<ConnectedAppEntry[]> {
  try {
    const apps = await listLocalApps(createDefaultLocalAppsProbe());
    return apps.map(entryFor);
  } catch {
    return [];
  }
}
