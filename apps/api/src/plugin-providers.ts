// SPDX-License-Identifier: Apache-2.0
// A9: declarative provider plugins — host sync into the provider registry.
//
// A manifest-only provider plugin (kind "provider" in @mvp/plugins)
// declares an OpenAI-compatible provider. This module is the bridge
// between the PluginManager (which owns install state, live) and the
// agent-runtime provider catalog (which owns presets): syncPluginProviders
// diffs the manager's CURRENT provider descriptors against the presets
// this host has registered and applies the difference — register on
// install/enable, unregister on uninstall/disable. It is called after
// every plugin mutation route and once at boot, so a provider installed
// into a RUNNING server appears in the picker (listProviders iterates the
// catalog) and can serve turns through createProvider with no restart,
// and disappears the moment its plugin goes away.
//
// The driver is always the built-in OpenAI-compatible driver; the package
// contributes no code. The API key is the declaration's envKey NAME,
// resolved at turn time by the runtime's ordinary credential chain
// (environment → .env files → providers.local.json) — key VALUES never
// pass through this module or the package.
//
// Registration is fail-closed against shadowing (see catalog.ts): a
// plugin whose providerId collides with a built-in preset is refused and
// reported in the sync result, never silently substituted.

import type { PluginManager } from '@mvp/plugins';
import {
  listPluginProviderRegistrations,
  registerPluginProviderPreset,
  unregisterPluginProviderPreset,
  type ProviderPreset,
} from '@mvp/agent-runtime';

export interface PluginProviderSyncResult {
  /** Provider ids registered (or refreshed) by this sync. */
  registered: string[];
  /** Provider ids removed by this sync. */
  removed: string[];
  /** Registrations the catalog refused (id shadowing), with the reason. */
  refused: Array<{ providerId: string; pluginId: string; reason: string }>;
}

/** Build the catalog preset for one declarative provider descriptor. */
export function descriptorToPreset(descriptor: {
  pluginId: string;
  providerId: string;
  name: string;
  baseUrl: string;
  apiKeyEnv?: string;
  apiKeyRequired: boolean;
  liveModels: boolean;
  models: Array<{ id: string; name: string; default?: boolean }>;
}): ProviderPreset {
  return {
    id: descriptor.providerId,
    name: descriptor.name,
    api: 'openai-compatible',
    baseUrl: descriptor.baseUrl,
    // Keyless declarations send no Authorization header (factory keyless
    // lane). Keyed declarations resolve the named secret at turn time;
    // the synthetic envKey for the keyless case is never read.
    ...(descriptor.apiKeyRequired
      ? { envKey: descriptor.apiKeyEnv! }
      : { envKey: `PLUGIN_${descriptor.providerId.replace(/-/g, '_').toUpperCase()}_API_KEY`, keyless: true }),
    liveModels: descriptor.liveModels,
    models: descriptor.models.map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.default ? { default: true } : {}),
    })),
    notes: `Declarative provider installed by plugin "${descriptor.pluginId}". Signing proves the package's origin, not its behaviour; the endpoint receives whatever the user sends it.`,
  };
}

/**
 * Diff the manager's live provider descriptors against the registered
 * plugin presets and apply the changes. Idempotent — safe to call after
 * every mutation and at boot.
 */
export function syncPluginProviders(manager: PluginManager): PluginProviderSyncResult {
  const result: PluginProviderSyncResult = { registered: [], removed: [], refused: [] };
  const desired = new Map<string, { preset: ProviderPreset; pluginId: string }>();
  for (const descriptor of manager.providerDescriptors()) {
    desired.set(descriptor.providerId, { preset: descriptorToPreset(descriptor), pluginId: descriptor.pluginId });
  }
  // Remove presets whose plugin is gone/disabled, or whose provider id
  // has been re-declared by a DIFFERENT plugin (ownership transfer: drop
  // the stale registration so the new owner can register below).
  for (const { preset, pluginId } of listPluginProviderRegistrations()) {
    const want = desired.get(preset.id);
    if (!want || want.pluginId !== pluginId) {
      if (unregisterPluginProviderPreset(preset.id)) result.removed.push(preset.id);
    }
  }
  // Register / refresh the rest.
  for (const [providerId, { preset, pluginId }] of desired) {
    const reg = registerPluginProviderPreset(preset, pluginId);
    if (reg.ok) result.registered.push(providerId);
    else result.refused.push({ providerId, pluginId, reason: reg.reason });
  }
  if (result.refused.length > 0) {
    for (const r of result.refused) {
      console.warn(`[plugins] provider "${r.providerId}" from plugin "${r.pluginId}" refused: ${r.reason}`);
    }
  }
  return result;
}
