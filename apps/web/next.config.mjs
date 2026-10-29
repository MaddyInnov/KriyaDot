/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export → out/ dir. The API serves this directory (dev) or an
  // embedded gzip asset map (single-binary distribution). No server-side
  // features: all data fetching is client-side against the API.
  output: 'export',
  // Subpath serving (deployment polish): mirror the API's
  // KRIYADOT_BASE_PATH by building with NEXT_PUBLIC_BASE_PATH set to the
  // same value (e.g. /kriyadot). Unset → served at the root, as before.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
};

export default nextConfig;
