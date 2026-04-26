import { defineConfig } from 'astro/config'
import { fileURLToPath } from 'node:url'
import react from '@astrojs/react'
import tailwind from '@tailwindcss/vite'

const dsRoot = fileURLToPath(new URL('../src', import.meta.url))

// Astro 6 + React 19 + Tailwind v4 (via Vite plugin).
// React components from @ds/* render server-side by default — no JS shipped
// unless a `client:*` directive is added. Chrome interactivity is plain
// inline <script> in Chrome.astro, no React hydration.
export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwind()],
    resolve: {
      alias: { '@ds': dsRoot },
    },
  },
  server: { port: 3000 },
  devToolbar: { enabled: false },
})
