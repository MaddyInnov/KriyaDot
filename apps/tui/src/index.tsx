#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// kriyadot-tui — terminal client for KriyaDot.
import React from 'react';
import { render } from 'ink';
import { KriyaDotApi, readLoopbackToken } from './api.js';
import { App } from './components/App.js';
import { loadConfig, normalizeApiUrl, parseCliArgs, printHelp, saveConfig } from './config.js';
import { isThemeName } from './themes.js';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(printHelp());
  process.exit(0);
}

const cli = parseCliArgs(argv);
const config = loadConfig();
if (cli.api) config.apiUrl = cli.api;
if (cli.bot) config.defaultBot = cli.bot;
if (cli.theme && isThemeName(cli.theme)) config.theme = cli.theme;

try {
  config.apiUrl = normalizeApiUrl(config.apiUrl);
} catch (err) {
  console.error(`kriyadot-tui: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Persist CLI/env overrides so the next run remembers them.
try {
  saveConfig(config);
} catch {
  // best-effort
}

// The API requires a per-boot loopback bearer token (written to
// <dataDir>/.api-token on startup). Without it every call 401s.
let apiToken: string;
try {
  apiToken = readLoopbackToken();
} catch (err) {
  console.error(`kriyadot-tui: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const api = new KriyaDotApi(config.apiUrl, apiToken);
const { waitUntilExit } = render(<App api={api} config={config} />);
void waitUntilExit().then(() => {
  process.exit(0);
});
