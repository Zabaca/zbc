// Forms' signer page, built into dist/client/s/_/ (guest-bundle.ts): /s/<token>. Run after the space's own build (package.json `build`).
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { pdfjsWasm } from '../forms/pdfjs-wasm'
import { guestBundle } from './guest-bundle'

export default defineConfig(guestBundle({ bundle: 'forms', root: '../forms', prefix: '/s', plugins: [react(), tailwindcss(), pdfjsWasm()], publicDir: false }))
