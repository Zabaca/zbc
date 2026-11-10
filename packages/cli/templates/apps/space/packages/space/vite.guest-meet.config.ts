// Meet's guest page, built into dist/client/r/_/ (guest-bundle.ts): calls at /r/<name> and channel guests at /w/. Run after the space's own build (package.json `build`).
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { guestBundle } from './guest-bundle'

export default defineConfig(guestBundle({ bundle: 'meet', root: '../meet', prefix: '/r', plugins: [react()], publicDir: true }))
