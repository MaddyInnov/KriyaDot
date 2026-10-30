// SPDX-License-Identifier: Apache-2.0
/**
 * Pack script for the `driving-kriyadot` skill (#162): a dependency-free
 * smoke check that a KriyaDot server is reachable before an external
 * agent starts driving it.
 *
 *   node scripts/smoke-check.mjs [baseUrl]
 *
 * baseUrl defaults to http://localhost:4000. Exits 0 when GET /api/health
 * answers { ok: true }, 1 otherwise. The health route is auth-exempt;
 * this script never reads or prints the loopback token.
 */
const base = (process.argv[2] ?? 'http://localhost:4000').replace(/\/$/, '');
try {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5_000) });
  const body = await res.json().catch(() => null);
  if (res.ok && body && body.ok === true) {
    console.log(`kriyadot reachable at ${base} (version ${body.version ?? 'unknown'})`);
    process.exit(0);
  }
  console.error(`kriyadot at ${base} answered HTTP ${res.status} without ok:true`);
  process.exit(1);
} catch (err) {
  console.error(`kriyadot not reachable at ${base}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
