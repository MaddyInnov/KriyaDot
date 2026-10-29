// SPDX-License-Identifier: Apache-2.0
// Regenerates lib/locales.source-hash.json — the checked-in hash of the
// canonical English (`en`) source strings in lib/locales.ts.
//
// Usage (from apps/web):
//   node scripts/gen-locales-hash.mjs           # rewrite the manifest
//   node scripts/gen-locales-hash.mjs --check   # exit 1 if the manifest is stale
//
// Canonical form (must match lib/i18n.test.ts exactly): flatten `en` into
// dot-path keys, sort the keys, JSON.stringify the [key, value] pairs, and
// take the SHA-256 hex digest of that UTF-8 string. No timestamps or other
// volatile fields are recorded, so regeneration is deterministic: if the
// English source did not change, the manifest does not change either.
//
// No new dependencies: `en` is loaded via Node's built-in TypeScript type
// stripping (Node >= 22.18 / 23+); on older Node 22 the repo's already
// installed `typescript` devDependency is used as a transpile fallback.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(webRoot, 'lib', 'locales.ts');
const manifestPath = join(webRoot, 'lib', 'locales.source-hash.json');

async function loadEn() {
  try {
    return (await import(sourcePath)).en;
  } catch {
    // Fallback for Node versions without type stripping: transpile the
    // (erasable-syntax only) module with the workspace typescript package.
    const require = createRequire(join(webRoot, 'package.json'));
    const ts = require(require.resolve('typescript', { paths: [webRoot, join(webRoot, '..', '..')] }));
    const source = readFileSync(sourcePath, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: 'locales.ts',
    });
    const mod = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
    return mod.en;
  }
}

/** Flatten a string table into sorted [dotPath, value] pairs. */
export function canonicalPairs(en) {
  const pairs = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object') walk(v, path);
      else pairs.push([path, v]);
    }
  };
  walk(en, '');
  return pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function sourceHashOf(en) {
  const canonical = JSON.stringify(canonicalPairs(en));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

const en = await loadEn();
const pairs = canonicalPairs(en);
const manifest = {
  note: 'Checked-in hash of the canonical English source strings (audit §1.15). Regenerate after any edit to `en` in lib/locales.ts; lib/i18n.test.ts fails while this manifest is stale.',
  regenerate: 'node scripts/gen-locales-hash.mjs (run from apps/web)',
  check: 'node scripts/gen-locales-hash.mjs --check (run from apps/web)',
  algorithm: 'sha256',
  canonical:
    'Flatten `en` from lib/locales.ts into dot-path keys, sort keys lexicographically, JSON.stringify the [key, value] pairs, SHA-256 hex of the UTF-8 bytes.',
  sourceFile: 'apps/web/lib/locales.ts',
  locale: 'en',
  keyCount: pairs.length,
  sourceHash: sourceHashOf(en),
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = null;
  try {
    current = readFileSync(manifestPath, 'utf8');
  } catch {
    current = null;
  }
  if (current !== serialized) {
    console.error(
      `locales.source-hash.json is stale (expected sha256 ${manifest.sourceHash}).\n` +
        'Regenerate it with: node scripts/gen-locales-hash.mjs (from apps/web)',
    );
    process.exit(1);
  }
  console.log(`locales source hash OK: ${manifest.sourceHash} (${manifest.keyCount} keys)`);
} else {
  writeFileSync(manifestPath, serialized);
  console.log(`Wrote lib/locales.source-hash.json: sha256 ${manifest.sourceHash} (${manifest.keyCount} keys)`);
}
