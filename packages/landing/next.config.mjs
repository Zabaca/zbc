/** @type {import('next').NextConfig} */
export default {
  // Static HTML export → out/. The two former SSR /api routes now live in a
  // tiny Cloudflare Worker (worker/index.ts) that fronts these static assets.
  output: 'export',
  // Pre-bundle the workspace package so Next can statically analyze it.
  transpilePackages: ['@zbc/design-system'],
}
