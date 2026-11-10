// The LOCAL Worker's build and dev server (dev/worker.ts), for `bun run dev` and the live browser checks. `vite build` emits dist/client (what wrangler.jsonc's assets.directory points at) and the plugin
// runs the real Worker and its Durable Objects in `vite dev`, so :4812 serves the SPA and the API from one origin, as the space does at /r/ and /w/. Nothing deploys it: meet's guest page is built
// into the space by packages/space/vite.guest-meet.config.ts from this package's index.html and sources.
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { NORTHFIELD_DECLARATION_FILE } from '../../workspace/northfield/paths'

// The invented install's declaration, the one company.ts bundles as `@meet/declaration` here (this Worker is never deployed). The space aliases the same name for its own build (packages/space/vite.config.ts).
const declaration = NORTHFIELD_DECLARATION_FILE

export default defineConfig({
  // The package, not this folder: its index.html is the page.
  root: fileURLToPath(new URL('..', import.meta.url)),
  resolve: { alias: { '@meet/declaration': declaration } },
  plugins: [react(), cloudflare({ configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) })],
})
