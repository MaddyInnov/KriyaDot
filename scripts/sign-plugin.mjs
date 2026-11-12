// SPDX-License-Identifier: Apache-2.0
// Dev tool: sign a KriyaDot plugin package (.kdpkg, Ed25519) — A9.
//
// Usage:
//   node scripts/sign-plugin.mjs --gen-keys
//       Print a fresh publisher keypair. Store the private key OUTSIDE
//       the repo (secret manager / env); give the public key to users so
//       they can add it to their plugin trust store.
//
//   KRIYADOT_PLUGIN_PRIVATE_KEY=<pkcs8-der-base64> \
//   KRIYADOT_PLUGIN_PUBLIC_KEY=<spki-der-base64> \
//     node scripts/sign-plugin.mjs --dir ./my-plugin --out ./my-plugin.kdpkg
//   …or --zip ./my-plugin.zip to sign an existing unsigned package zip.
//
// Signing proves ORIGIN (these bytes came from the key holder), never
// behaviour — installs still pass governance approval, and executable
// plugins still run under the OPEN-2 kernel sandbox. Requires the
// @mvp/plugins package to be built (packages/plugins/dist).
//
// The private key is read from env or --private-key. It is NEVER
// committed to this repo and never written into the package.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

let plugins;
try {
  plugins = await import('../packages/plugins/dist/index.js');
} catch {
  console.error('Could not load packages/plugins/dist — build it first: (cd packages/plugins && npm run build)');
  process.exit(1);
}
const { createSignedPluginPackage, generatePluginPublisherKeyPair, signPluginPackageZip } = plugins;

if (args.includes('--gen-keys')) {
  const kp = generatePluginPublisherKeyPair();
  console.log('keyId  :', kp.keyId);
  console.log('public (share with users; they add it via the plugin trust store):', kp.publicKey);
  console.log('private (store in a secret manager, NOT in git):', kp.privateKey);
  process.exit(0);
}

const publicKey = process.env.KRIYADOT_PLUGIN_PUBLIC_KEY || arg('public-key');
const privateKey = process.env.KRIYADOT_PLUGIN_PRIVATE_KEY || arg('private-key');
if (!publicKey || !privateKey) {
  console.error('Missing keys: set KRIYADOT_PLUGIN_PUBLIC_KEY + KRIYADOT_PLUGIN_PRIVATE_KEY or pass --public-key/--private-key. Use --gen-keys to create a keypair.');
  process.exit(1);
}
const out = arg('out');
if (!out) {
  console.error('--out <file.kdpkg> is required');
  process.exit(1);
}

let buf;
const dir = arg('dir');
const zip = arg('zip');
if (dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`plugin directory not found: ${dir}`);
    process.exit(1);
  }
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) files.push({ name: relative(dir, abs).split(sep).join('/'), data: readFileSync(abs) });
    }
  };
  walk(dir);
  buf = createSignedPluginPackage(files, { publicKey, privateKey });
} else if (zip) {
  if (!existsSync(zip)) {
    console.error(`plugin zip not found: ${zip}`);
    process.exit(1);
  }
  buf = signPluginPackageZip(readFileSync(zip), { publicKey, privateKey });
} else {
  console.error('Pass --dir <plugin-dir> or --zip <plugin.zip>');
  process.exit(1);
}
writeFileSync(out, buf);
console.log(`signed package written: ${out} (${buf.length} bytes)`);
