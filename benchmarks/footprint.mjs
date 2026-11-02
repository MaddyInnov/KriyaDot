// SPDX-License-Identifier: Apache-2.0
/**
 * KriyaDot footprint baseline (Pack B — measurement only, OH-6).
 *
 * Measures, against the BUILT artifacts (run `npm run build` at the
 * repo root first):
 *
 *  1. Server cold start — spawns the API server exactly the way the
 *     Docker image runs it (`node apps/api/dist/index.js`) with a
 *     throwaway temp DATA_DIR and a scratch PORT, and times spawn ->
 *     first successful GET /api/health (the public health route in
 *     apps/api/src/routes.ts, mounted under /api). No provider keys
 *     are set: the server boots without them (health merely reports
 *     them unconfigured), so this lane is zero-paid-API by
 *     construction.
 *  2. Idle RSS — the server process's VmRSS from /proc/<pid>/status,
 *     sampled at ready+15s, +30s, +45s and +60s; the +60s value is
 *     the reported idle RSS. Main process only (MCP warmup children,
 *     if any, are not summed — see FOOTPRINT.md notes).
 *  3. Sizes — apps/api/dist total + per-extension breakdown;
 *     apps/web/out total + per-top-level-entry sizes; the prebuilt
 *     server binary at dist/mvp-server when present; a desktop
 *     (Tauri) release binary when one exists in-tree, else
 *     'not built'.
 *  4. First-token latency on the mock lane — MockProvider from the
 *     agent-runtime dist, driven in streaming mode (chat() with an
 *     onToken callback) for a fixed prompt; time-to-first-token and
 *     total time, median of 7 runs. This measures harness/provider
 *     plumbing overhead on the mock lane only — it is NOT a real
 *     model's latency.
 *
 * Usage: node benchmarks/footprint.mjs [--write]
 * With --write, results land in benchmarks/footprint.json and
 * benchmarks/FOOTPRINT.md. The server is always killed cleanly
 * (SIGTERM, SIGKILL fallback) and the temp data dir is left in the
 * OS temp dir for inspection; its path is recorded in the output.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { MockProvider } from '../packages/agent-runtime/dist/index.js';

const ROOT = join(import.meta.dirname, '..');
const PORT = Number(process.env.BENCH_FOOTPRINT_PORT ?? 43917);
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;

// ---------------------------------------------------------------------------
// Size helpers
// ---------------------------------------------------------------------------

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

function dirSizeByExtension(dir) {
  const byExt = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        const ext = extname(entry.name) || '(none)';
        byExt[ext] = (byExt[ext] ?? 0) + statSync(p).size;
      }
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(byExt).sort((a, b) => b[1] - a[1]));
}

function topLevelSizes(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => {
      const p = join(dir, entry.name);
      return { name: entry.name, bytes: entry.isDirectory() ? dirSizeBytes(p) : statSync(p).size };
    })
    .sort((a, b) => b.bytes - a.bytes);
}

const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;

// ---------------------------------------------------------------------------
// Server cold start + idle RSS
// ---------------------------------------------------------------------------

function readRssKb(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measureServer() {
  const dataDir = mkdtempSync(join(tmpdir(), 'kriyadot-footprint-'));
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir };
  // Boot must not depend on (or spend) any provider key.
  delete env.GROQ_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;

  const started = performance.now();
  const child = spawn(process.execPath, [join(ROOT, 'apps/api/dist/index.js')], {
    cwd: join(ROOT, 'apps/api'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));

  let coldStartMs = null;
  let healthBody = null;
  try {
    const deadline = started + 120_000;
    while (performance.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(HEALTH_URL);
        if (res.ok) {
          healthBody = await res.json();
          coldStartMs = Math.round(performance.now() - started);
          break;
        }
      } catch {
        // not up yet
      }
      await sleep(100);
    }
    if (coldStartMs === null) {
      throw new Error(`server did not answer ${HEALTH_URL} within 120s (exit=${child.exitCode}); log tail: ${serverLog.slice(-500)}`);
    }

    const rssSamples = [];
    for (const atSec of [15, 30, 45, 60]) {
      const target = started + coldStartMs + atSec * 1000;
      const wait = target - performance.now();
      if (wait > 0) await sleep(wait);
      rssSamples.push({ atSecondsAfterReady: atSec, rssKb: readRssKb(child.pid) });
    }
    return { coldStartMs, healthBody, rssSamples, idleRssKb: rssSamples[rssSamples.length - 1].rssKb, dataDir, pid: child.pid };
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise((r) => child.once('exit', () => r(true))),
        sleep(5000).then(() => false),
      ]);
      if (!exited && child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

// ---------------------------------------------------------------------------
// Mock-lane first-token latency
// ---------------------------------------------------------------------------

async function measureMockStreaming(runs = 7) {
  const prompt = 'Explain what a benchmark is in one short paragraph.';
  const content =
    'A benchmark is a fixed, repeatable test used to compare systems fairly: same inputs, same scoring, same conditions, so the numbers mean the same thing on every run.';
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const provider = new MockProvider([{ content }]);
    let firstTokenMs = null;
    const t0 = performance.now();
    const response = await provider.chat([{ role: 'user', content: prompt }], [], {
      model: 'mock-model',
      onToken: () => {
        if (firstTokenMs === null) firstTokenMs = performance.now() - t0;
      },
    });
    samples.push({ firstTokenMs, totalMs: performance.now() - t0, usage: response.usage });
  }
  const median = (vals) => vals.slice().sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  return {
    runs,
    prompt,
    firstTokenMedianMs: Math.round(median(samples.map((s) => s.firstTokenMs)) * 1000) / 1000,
    totalMedianMs: Math.round(median(samples.map((s) => s.totalMs)) * 1000) / 1000,
    usagePerRun: samples[0].usage,
    samples: samples.map((s) => ({ firstTokenMs: Math.round(s.firstTokenMs * 1000) / 1000, totalMs: Math.round(s.totalMs * 1000) / 1000 })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiDist = join(ROOT, 'apps/api/dist');
  const webOut = join(ROOT, 'apps/web/out');
  const serverBinary = join(ROOT, 'dist/mvp-server');
  const tauriRelease = join(ROOT, 'apps/desktop/src-tauri/target/release');

  const sizes = {
    apiDist: existsSync(apiDist)
      ? { totalKb: kb(dirSizeBytes(apiDist)), byExtensionKb: Object.fromEntries(Object.entries(dirSizeByExtension(apiDist)).map(([k, v]) => [k, kb(v)])) }
      : null,
    webOut: existsSync(webOut)
      ? { totalKb: kb(dirSizeBytes(webOut)), topLevel: topLevelSizes(webOut).slice(0, 15).map((e) => ({ name: e.name, kb: kb(e.bytes) })) }
      : null,
    serverBinary: existsSync(serverBinary) ? { path: 'dist/mvp-server', kb: kb(statSync(serverBinary).size) } : 'not built',
    desktopBinary: 'not built',
  };
  if (existsSync(tauriRelease)) {
    const candidates = readdirSync(tauriRelease, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.includes('.'))
      .map((e) => ({ name: e.name, bytes: statSync(join(tauriRelease, e.name)).size }))
      .sort((a, b) => b.bytes - a.bytes);
    if (candidates.length) {
      sizes.desktopBinary = { path: `apps/desktop/src-tauri/target/release/${candidates[0].name}`, kb: kb(candidates[0].bytes) };
    }
  }

  console.error('[footprint] measuring server cold start + 60s idle RSS (takes ~75s)…');
  const server = await measureServer();
  const streaming = await measureMockStreaming(7);

  const report = {
    date: new Date().toISOString(),
    env: { node: process.version, platform: `${process.platform}/${process.arch}` },
    server: {
      command: 'node apps/api/dist/index.js',
      env: { PORT, DATA_DIR: server.dataDir, providerKeys: 'none set (boot does not require them)' },
      healthEndpoint: HEALTH_URL.replace(String(PORT), '<PORT>'),
      healthBody: server.healthBody,
      coldStartMs: server.coldStartMs,
      rssSamples: server.rssSamples,
      idleRssKb: server.idleRssKb,
      idleRssMb: server.idleRssKb ? Math.round((server.idleRssKb / 1024) * 10) / 10 : null,
      rssScope: 'main server process only (VmRSS from /proc/<pid>/status); child processes, if any, are not summed',
    },
    sizes,
    mockStreaming: streaming,
  };

  console.log(JSON.stringify(report, null, 2));

  if (process.argv.includes('--write')) {
    writeFileSync(join(import.meta.dirname, 'footprint.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(import.meta.dirname, 'FOOTPRINT.md'), renderMarkdown(report));
    console.error('Wrote footprint.json and FOOTPRINT.md');
  }
}

function renderMarkdown(r) {
  const rssRows = r.server.rssSamples.map((s) => `| ready+${s.atSecondsAfterReady}s | ${s.rssKb ?? '—'} |`).join('\n');
  const webRows = r.sizes.webOut ? r.sizes.webOut.topLevel.map((e) => `| ${e.name} | ${e.kb} |`).join('\n') : '(web build output not found)';
  const apiExtRows = r.sizes.apiDist
    ? Object.entries(r.sizes.apiDist.byExtensionKb)
        .map(([ext, v]) => `| ${ext} | ${v} |`)
        .join('\n')
    : '(api dist not found)';
  const desktop =
    r.sizes.desktopBinary === 'not built'
      ? 'not built (no Tauri release binary in-tree)'
      : `${r.sizes.desktopBinary.kb} KB (\`${r.sizes.desktopBinary.path}\`)`;
  const serverBin = r.sizes.serverBinary === 'not built' ? 'not built' : `${r.sizes.serverBinary.kb} KB (\`${r.sizes.serverBinary.path}\`)`;
  return `<!-- SPDX-License-Identifier: Apache-2.0 -->
# KriyaDot Footprint Baseline

Baseline section — generated by \`benchmarks/footprint.mjs\` from a
run actually executed on the date below. **Measurement only**: this
file records the starting point for a later optimization pass; no
optimizations are included or implied.

- Date: ${r.date}
- Environment: Node ${r.env.node}, ${r.env.platform}
- Machine-readable twin: \`benchmarks/footprint.json\`

## Headline numbers

| Metric | Value |
| --- | ---: |
| Server cold start (spawn → \`GET /api/health\` OK) | ${r.server.coldStartMs} ms |
| Idle RSS at ready+60s (main process) | ${r.server.idleRssKb} kB (${r.server.idleRssMb} MB) |
| apps/api dist total | ${r.sizes.apiDist ? `${r.sizes.apiDist.totalKb} KB` : 'not found'} |
| apps/web build output (\`out/\`) total | ${r.sizes.webOut ? `${r.sizes.webOut.totalKb} KB` : 'not found'} |
| Prebuilt server binary (\`dist/mvp-server\`) | ${serverBin} |
| Desktop (Tauri) binary | ${desktop} |
| Mock-lane time-to-first-token (median of ${r.mockStreaming.runs}) | ${r.mockStreaming.firstTokenMedianMs} ms |
| Mock-lane total time (median of ${r.mockStreaming.runs}) | ${r.mockStreaming.totalMedianMs} ms |

## Server cold start & idle RSS

- Command: \`${r.server.command}\` with \`PORT\` and a throwaway temp
  \`DATA_DIR\` (\`${r.server.env.DATA_DIR}\`); no provider keys set —
  the server boots without them and health reports them
  unconfigured: \`${JSON.stringify(r.server.healthBody)}\`.
- Cold start is spawn → first successful \`GET /api/health\`
  (the public health route in \`apps/api/src/routes.ts\`), polled
  every 100 ms, so the figure carries up to ~100 ms of poll
  granularity.
- RSS scope: ${r.server.rssScope}.

| Sample | RSS (kB) |
| --- | ---: |
${rssRows}

## Sizes

### apps/api/dist by extension (KB)

| Extension | KB |
| --- | ---: |
${apiExtRows}

### apps/web/out — largest top-level entries (KB)

| Entry | KB |
| --- | ---: |
${webRows}

The web export is a Next.js static export: \`out/\` holds one
\`.html\` + one \`.txt\` per page alongside \`_next/\` chunks (see
hot-spot notes).

## First-token latency (mock lane)

- Lane: \`MockProvider\` from the agent-runtime dist, streaming mode
  (\`chat()\` with an \`onToken\` callback), fixed prompt:
  "${r.mockStreaming.prompt}"
- Median of ${r.mockStreaming.runs} runs: time-to-first-token
  ${r.mockStreaming.firstTokenMedianMs} ms, total ${r.mockStreaming.totalMedianMs} ms.
- This is harness/plumbing overhead on the mock lane only. The mock
  streams instantly (no pacing delay, no network), so these numbers
  are a floor for the plumbing, **not** a real model's latency.
- Scripted usage per run: ${JSON.stringify(r.mockStreaming.usagePerRun)} (the MockProvider's fixed usage, not measured model usage).

## Observed hot spots (notes for the optimization pass — observations only, no code changed)

1. **Eager boot construction in \`apps/api/src/index.ts\`.** Before
   listen, boot constructs dozens of stores/services, each opening
   its own SQLite file in the data dir (governance, billing cost +
   spend caps, checkpoints, dots, recordings, chat queue, peer
   approvals, widgets, credential proposals, spans, run-health,
   health-sync, tiered memory, and more), plus seed loading and
   per-bot overlay passes (policies, personas, avatars, workspaces,
   models, voice, skills, approval modes, layers, memory settings,
   imported bots, chief overlays). Deferring rarely-used stores
   behind lazy access is the obvious first cold-start lever.
2. **\`ToolSpillStore.read()\` (and the newer \`search()\`) re-read
   the whole spilled file on every call**
   (\`packages/agent-runtime/src/tool-spill.ts\`: \`readFileSync\`
   of the full file, then slice/scan). A multi-MB spill paged in
   8 KB chunks re-reads the entire file per chunk.
3. **Source maps + type declarations ship in \`apps/api/dist\`.**
   The per-extension table above shows how much of the dist total
   is \`.map\` (source maps) and \`.ts\` (declaration files, counted
   by final extension) rather than runnable \`.js\`.
4. **Web export duplication.** \`apps/web/out\` contains both an
   \`.html\` and a \`.txt\` payload per page plus the \`_next\`
   chunk tree; worth checking whether the \`.txt\` payloads are
   needed by the serving path before shipping both.
5. **MCP warmup is (correctly) after listen**, so it does not block
   cold start — but it runs during the idle window measured above,
   so idle RSS/CPU in the first minute includes connector warmup
   activity, not just steady-state idling.
6. **Background timers start at boot** (e.g. the 60 s
   credential-proposal expiry sweep, checkpoint-retention timers).
   Individually cheap; collectively they define the idle wakeup
   floor.

## Residuals

- RSS is the main server process only; any child processes spawned
  during MCP warmup are not summed.
- The desktop (Tauri) binary figure is recorded as 'not built'
  unless a release binary already exists in-tree; this baseline
  does not build one.
`;
}

await main();
