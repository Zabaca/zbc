import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { NORTHFIELD_DECLARATION_FILE } from '../../workspace/northfield/paths'
import { pdfjsWasm } from '../pdfjs-wasm'

// The LOCAL Worker's build and dev server (dev/worker.ts), for `bun run dev` and the end-to-end suites. Nothing deploys it: forms runs inside the space's Worker, whose guest bundle is built by
// packages/space/vite.guest-forms.config.ts from this package's index.html and sources.
//
// The company this build serves is the declaration it bundles (src/workspace.ts). The invented install by default (this Worker is never deployed); FORMS_DECLARATION names another company's file, for the end-to-end
// run under a second company.
const declaration = process.env.FORMS_DECLARATION ? resolve(process.env.FORMS_DECLARATION) : NORTHFIELD_DECLARATION_FILE

export default defineConfig({
  // The package, not this folder: its index.html is the page, and `.wrangler/state` (the local D1 and R2) sits beside its package.json.
  root: fileURLToPath(new URL('..', import.meta.url)),
  resolve: { alias: { '@forms/declaration': declaration } },
  plugins: [react(), tailwindcss(), pdfjsWasm(), cloudflare({ configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)) })],
})
