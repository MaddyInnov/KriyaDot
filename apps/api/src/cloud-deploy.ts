// SPDX-License-Identifier: Apache-2.0
// Lightning Studio deploy for KriyaDot (Octomind-parity closure, C2/C3).
//
// deployKriyadot() runs a fixed, scripted sequence inside the user's own
// Studio over the client's run channel (SDK `Studio.run`):
//
//   1. runtime      — ensure Node.js exists in the Studio (install via nvm
//                     when missing; installs persist across Studio restarts)
//   2. source       — git clone the configured KriyaDot source, or
//                     `git pull --ff-only` when a checkout already exists
//   3. ollama-install / ollama-pull / ollama-serve   (only when requested)
//   4. install      — `npm ci` (falling back to `npm install`)
//   5. env-file     — write ~/kriyadot/.env.cloud (mode 0600)
//   6. supervisor-script — write ~/kriyadot/supervisor.sh (mode 0700)
//   7. start        — (re)start the server under the supervisor via nohup
//   8. public-url   — resolve the ports-plugin public URL for the app port
//
// Secrets handling: the user's provider API keys are resolved from their
// vault by the HOST at deploy time (see CloudRouteDeps.providerEnvForUser
// in cloud-routes.ts) and injected over the run channel as a base64
// payload that is decoded only inside the Studio into the 0600 env file.
// Secret values therefore never appear in this process's logs, in the
// supervisor script, or in any deploy result — the env file inside the
// Studio is the one place they exist in plaintext, because the server
// process needs them, and it is mode-0600 on the user's own machine.
// The supervisor script itself contains NO secrets; it sources the env
// file at start.

import {
  DEFAULT_STUDIO_NAME,
  DEFAULT_STUDIO_PORT,
  resolveStudioPublicUrl,
  type LightningClient,
  type LightningStudio,
} from './cloud-lightning.js';

/** In-Studio locations (all on the Studio's persistent disk). */
export const CLOUD_APP_DIR = '~/kriyadot';
export const CLOUD_ENV_FILE = '~/kriyadot/.env.cloud';
export const CLOUD_SUPERVISOR_SCRIPT = '~/kriyadot/supervisor.sh';
export const CLOUD_SUPERVISOR_LOG = '~/kriyadot/supervisor.log';

/**
 * Free-tier Drive constraint (feasibility report §1/§5): the teamspace
 * Drive's first 10 GB are free and are SHARED between the KriyaDot
 * server, the user's data, the Ollama binary, and any pulled models.
 * That is why the Ollama sidecar pre-pulls exactly ONE small model.
 */
export const FREE_DRIVE_GB = 10;

/** Default (and only pre-pulled) Ollama model: Qwen3-4B, ≈2.5 GB on disk. */
export const OLLAMA_DEFAULT_MODEL = 'qwen3:4b';

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,80}$/;
const REPO_PATTERN = /^(https:\/\/|git@)[A-Za-z0-9._:/@-]+$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single-quote a string for safe embedding in a POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface OllamaDeployOptions {
  enabled: boolean;
  /**
   * Exactly ONE model to pull. A list (comma/space separated) is rejected:
   * the free Drive is 10 GB total, so the sidecar pre-pulls a single
   * small model and fetches others only on explicit demand later.
   */
  model?: string;
}

export interface DeployOptions {
  /** Git URL of the KriyaDot source to clone/pull inside the Studio. */
  repoUrl: string;
  /** App port inside the Studio. Default: DEFAULT_STUDIO_PORT (8080). */
  port?: number;
  /** Start command for the server. Default: `npm start`. */
  startCommand?: string;
  /**
   * Provider env vars (the user's own keys, resolved from their vault by
   * the host at deploy time) written into the 0600 in-Studio env file.
   */
  providerEnv?: Record<string, string>;
  ollama?: OllamaDeployOptions;
  studioName?: string;
}

export interface DeployStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DeployResult {
  studio: string;
  ok: boolean;
  steps: DeployStep[];
  publicUrl?: string;
  port: number;
  ollama?: {
    model: string;
    /** Honest storage note surfaced to the user with every Ollama deploy. */
    driveNote: string;
  };
  warnings: string[];
}

function validateDeployOptions(opts: DeployOptions): Required<Pick<DeployOptions, 'port' | 'startCommand' | 'studioName'>> & DeployOptions {
  if (typeof opts.repoUrl !== 'string' || !REPO_PATTERN.test(opts.repoUrl.trim())) {
    throw new Error('deploy requires a valid repoUrl (https://… or git@… git URL)');
  }
  const ollamaModel = opts.ollama?.model ?? OLLAMA_DEFAULT_MODEL;
  if (opts.ollama?.enabled) {
    if (/[,\s]/.test(ollamaModel.trim()) || !MODEL_PATTERN.test(ollamaModel.trim())) {
      throw new Error(
        'ollama.model must be exactly ONE model id (e.g. "qwen3:4b") — the free Drive is 10 GB, so only one model is pre-pulled',
      );
    }
  }
  for (const key of Object.keys(opts.providerEnv ?? {})) {
    if (!ENV_KEY_PATTERN.test(key)) throw new Error(`providerEnv key "${key}" is not a valid env var name`);
  }
  return {
    ...opts,
    repoUrl: opts.repoUrl.trim(),
    port: opts.port ?? DEFAULT_STUDIO_PORT,
    startCommand: opts.startCommand ?? 'npm start',
    studioName: opts.studioName ?? DEFAULT_STUDIO_NAME,
  };
}

/** The on-boot/on-wake supervisor script. Contains no secrets. */
export function buildSupervisorScript(port: number, startCommand: string): string {
  return [
    '#!/bin/sh',
    '# KriyaDot in-Studio supervisor — restarts the server when it exits and',
    '# is itself (re)started by the cloud supervisor after Lightning wakes',
    '# or restarts the Studio (free tier: every 4 hours). No secrets here:',
    '# provider keys live in the mode-0600 env file sourced below.',
    'set -u',
    `cd ${CLOUD_APP_DIR} || exit 1`,
    `if [ -f ${CLOUD_ENV_FILE} ]; then set -a; . ${CLOUD_ENV_FILE}; set +a; fi`,
    `export PORT=${port}`,
    'while true; do',
    `  ${startCommand} >> supervisor.log 2>&1`,
    '  echo "[supervisor] server exited ($?) — restarting in 2s" >> supervisor.log',
    '  sleep 2',
    'done',
    '',
  ].join('\n');
}

/** Shell command that (re)starts the supervisor detached; used by deploy + supervisor. */
export function startSupervisorCommand(): string {
  return (
    `pkill -f "sh ${CLOUD_SUPERVISOR_SCRIPT}" 2>/dev/null; ` +
    `nohup sh ${CLOUD_SUPERVISOR_SCRIPT} > ${CLOUD_SUPERVISOR_LOG} 2>&1 & echo started`
  );
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * Deploy (or redeploy) KriyaDot into a Studio. Every step goes through
 * the injected LightningClient, so tests assert the exact step sequence
 * against FakeLightningClient with zero subprocesses and zero network.
 * A failing step aborts the deploy: later steps are not attempted and
 * the failed step carries the runner's stderr (truncated).
 */
export async function deployKriyadot(
  client: LightningClient,
  rawOpts: DeployOptions,
): Promise<DeployResult> {
  const opts = validateDeployOptions(rawOpts);
  const name = opts.studioName;
  const steps: DeployStep[] = [];
  let ollamaModel: string | undefined;
  const warnings: string[] = [
    'Free Lightning tier: this Studio sleeps when idle and restarts every 4 hours. It is always REACHABLE (wake-on-traffic), not always running. Uninterrupted always-on requires the user\'s own Lightning Pro plan.',
  ];

  const run = async (step: string, command: string): Promise<boolean> => {
    const res = await client.runInStudio(name, command);
    if (res.exitCode !== 0) {
      steps.push({
        name: step,
        ok: false,
        detail: (res.stderr || res.stdout).slice(0, 300) || `exit ${res.exitCode}`,
      });
      return false;
    }
    steps.push({ name: step, ok: true });
    return true;
  };

  // Make sure the Studio exists before running anything inside it.
  const studio: LightningStudio = await client.ensureStudio(name);
  steps.push({ name: 'ensure-studio', ok: true, detail: `state=${studio.state}` });

  // 1. Runtime: Node.js (a Studio is Python-first; installs persist).
  if (
    !(await run(
      'runtime',
      'command -v node >/dev/null 2>&1 || (curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install --lts)',
    ))
  )
    return finish();

  // 2. Source: clone or fast-forward pull.
  if (
    !(await run(
      'source',
      `if [ -d ${CLOUD_APP_DIR}/.git ]; then git -C ${CLOUD_APP_DIR} pull --ff-only; else git clone ${shellQuote(opts.repoUrl)} ${CLOUD_APP_DIR}; fi`,
    ))
  )
    return finish();

  // 3. Optional Ollama sidecar: install, pull exactly ONE model, serve.
  if (opts.ollama?.enabled) {
    ollamaModel = (opts.ollama.model ?? OLLAMA_DEFAULT_MODEL).trim();
    if (!(await run('ollama-install', 'command -v ollama >/dev/null 2>&1 || curl -fsSL https://ollama.com/install.sh | sh')))
      return finish();
    if (!(await run('ollama-pull', `ollama pull ${shellQuote(ollamaModel)}`))) return finish();
    if (
      !(await run(
        'ollama-serve',
        'pgrep -x ollama >/dev/null 2>&1 || (OLLAMA_KEEP_ALIVE=10m nohup ollama serve > ~/ollama.log 2>&1 & echo serving)',
      ))
    )
      return finish();
  }

  // 4. Dependencies.
  if (!(await run('install', `cd ${CLOUD_APP_DIR} && (npm ci || npm install)`))) return finish();

  // 5. Env file (0600). Provider keys arrive from the host's vault lookup
  //    at deploy time; they are base64-wrapped for the run channel and
  //    decoded only inside the Studio. The Ollama registration below is
  //    how the deployed instance learns its local provider: Ollama on
  //    loopback inside the same Studio, with the one pulled model.
  const envLines: string[] = [`PORT=${opts.port}`, 'KRIYADOT_CLOUD=lightning'];
  for (const [k, v] of Object.entries(opts.providerEnv ?? {})) envLines.push(`${k}=${v}`);
  if (ollamaModel) {
    envLines.push('OLLAMA_HOST=http://127.0.0.1:11434');
    envLines.push('KRIYADOT_LOCAL_PROVIDER=ollama');
    envLines.push(`KRIYADOT_LOCAL_MODEL=${ollamaModel}`);
  }
  if (
    !(await run(
      'env-file',
      `printf %s ${shellQuote(b64(envLines.join('\n') + '\n'))} | base64 -d > ${CLOUD_ENV_FILE} && chmod 600 ${CLOUD_ENV_FILE}`,
    ))
  )
    return finish();

  // 6. Supervisor script (0700, secret-free).
  if (
    !(await run(
      'supervisor-script',
      `printf %s ${shellQuote(b64(buildSupervisorScript(opts.port, opts.startCommand)))} | base64 -d > ${CLOUD_SUPERVISOR_SCRIPT} && chmod 700 ${CLOUD_SUPERVISOR_SCRIPT}`,
    ))
  )
    return finish();

  // 7. Start under the supervisor.
  if (!(await run('start', startSupervisorCommand()))) return finish();

  // 8. Public URL via the ports plugin pattern the client resolved.
  const after = await client.getStudio(name);
  const publicUrl = after ? resolveStudioPublicUrl(after, opts.port) : studio.publicUrl;
  steps.push({ name: 'public-url', ok: true, ...(publicUrl ? { detail: publicUrl } : { detail: 'not yet published — open the Studio ports plugin' }) });

  return finish(publicUrl);

  function finish(publicUrl?: string): DeployResult {
    const ok = steps.every((s) => s.ok);
    return {
      studio: name,
      ok,
      steps,
      ...(publicUrl ? { publicUrl } : {}),
      port: opts.port,
      ...(ollamaModel
        ? {
            ollama: {
              model: ollamaModel,
              driveNote:
                `Ollama sidecar: exactly one model pre-pulled (${ollamaModel}, ~2.5 GB). ` +
                `The free teamspace Drive is ${FREE_DRIVE_GB} GB total, shared with the KriyaDot server and user data — ` +
                'additional models are pulled on demand only, never pre-pulled.',
            },
          }
        : {}),
      warnings,
    };
  }
}
