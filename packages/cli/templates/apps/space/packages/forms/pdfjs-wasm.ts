import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

// pdf.js decodes JPEG 2000, JBIG2 and CCITT fax images (and reads ICC colour profiles) with WASM files it fetches from its `wasmUrl`
// (src/public/PdfPages.tsx), or, where a phone will not run WASM (iOS Lockdown Mode), the JavaScript twin of each, which is imported
// from the same place (script-src 'self' allows that, so the signer's CSP needs no change). They are served from our own assets, copied from the pinned pdfjs-dist at build time (so they cannot
// drift from the version that asks for them) with their licences, and from the dev server under the same path.
//
// One plugin for both builds that draw PDFs: forms' (the signer's pages) and the space's (the Forms tab's document and placement screens, which
// import PdfPages from here). Each puts the files in its own assets/pdfjs-wasm/, which is where PdfPages looks, beside the script that asks.
const WASM_DIR = fileURLToPath(new URL('./node_modules/pdfjs-dist/wasm/', import.meta.url))
const WASM_PREFIX = 'assets/pdfjs-wasm/'
const wasmFiles = () => readdirSync(WASM_DIR).filter((f) => /^(openjpeg|jbig2|qcms)/.test(f) || /^LICENSE/.test(f))

export const pdfjsWasm = (): Plugin => ({
  name: 'pdfjs-wasm',
  generateBundle() {
    if (this.environment.name !== 'client') return
    for (const f of wasmFiles()) this.emitFile({ type: 'asset', fileName: `${WASM_PREFIX}${f}`, source: readFileSync(WASM_DIR + f) })
  },
  configureServer(server) {
    server.middlewares.use(`/${WASM_PREFIX}`, (req, res, next) => {
      const f = decodeURIComponent((req.url ?? '').slice(1))
      if (!wasmFiles().includes(f)) return next()
      res.setHeader('content-type', f.endsWith('.wasm') ? 'application/wasm' : f.endsWith('.js') ? 'text/javascript' : 'text/plain')
      res.end(readFileSync(WASM_DIR + f))
    })
  },
})
