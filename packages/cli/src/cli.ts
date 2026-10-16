#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// kriyadot — headless CLI for KriyaDot. Entry point: parse argv, resolve
// config, dispatch the command, exit with its code.
import { createInterface } from 'node:readline/promises';
import { resolveConfig } from './config.js';
import { KriyaDotApi } from './api.js';
import { parseArgs } from './args.js';
import { runCommand } from './commands.js';
import type { CommandDeps } from './commands.js';
import { createReadlineSource } from './repl.js';

async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function prompt(question: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`kriyadot: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  let cfg;
  try {
    cfg = resolveConfig({ api: parsed.global.api, token: parsed.global.token });
  } catch (e) {
    process.stderr.write(`kriyadot: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const api = new KriyaDotApi(cfg.apiUrl, cfg.token);
  const isTTY = process.stdin.isTTY === true;

  const deps: CommandDeps = {
    cfg,
    api,
    createApi: (apiUrl: string, token: string) => new KriyaDotApi(apiUrl, token),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY,
    readStdinAll,
    prompt,
    clearScreen: () => process.stdout.write('\x1Bc'),
    createLineSource: () => createReadlineSource(process.stdin, process.stdout),
  };

  try {
    return await runCommand(parsed, deps);
  } catch (e) {
    // runCommand already formats command errors; this is a last resort.
    process.stderr.write(`kriyadot: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

const code = await main();
process.exit(code);
