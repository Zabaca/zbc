// The booking page, built into dist/client/book/_/ (guest-bundle.ts): a link's page at /book/<name> and a booking's own at /book/manage/<secret>. Run after the space's own build (package.json `build`). Its source is booking/.
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { guestBundle } from './guest-bundle'

export default defineConfig(guestBundle({ bundle: 'booking', root: 'booking', prefix: '/book', plugins: [react()], publicDir: false }))
