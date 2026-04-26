import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import tailwind from '@tailwindcss/vite'

// Astro 6 + React 19 + Tailwind v4 (via Vite plugin).
// React components from @zbc/design-system render server-side by default —
// no JS shipped unless a `client:*` directive is added. Chrome interactivity
// is plain inline <script> in Chrome.astro, no React hydration.
export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwind()],
  },
  server: { port: 3000 },
  devToolbar: { enabled: false },
})
