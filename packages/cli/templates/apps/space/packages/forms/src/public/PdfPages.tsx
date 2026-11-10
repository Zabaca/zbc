// The document's pages, drawn with pdf.js (Apache-2.0, pinned) into canvases in the browser, with room on each page for
// the fields placed over it. A page is drawn when it comes near the screen, so a long document costs only what is looked at.
// The legacy build, because it runs on the older phones a signer may have; the worker is this site's own file.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { type ReactNode, useEffect, useRef, useState } from 'react'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Where pdf.js finds the WASM decoders for JPEG 2000, JBIG2 and CCITT fax images: this site's own copies (pdfjs-wasm.ts), never
 * another site's. In a build that is the folder this script was itself loaded from, so it follows the script to whichever address
 * serves it: /assets/ for the signer, and the space's own /assets/ for the Forms tab's screens, which import this file (packages/space).
 * Anywhere else (the dev server runs this from /src/, a test from a file) it is /assets/, which the dev server serves.
 */
export const PDFJS_WASM_URL = import.meta.url.includes('/assets/') ? `${import.meta.url.slice(0, import.meta.url.lastIndexOf('/') + 1)}pdfjs-wasm/` : '/assets/pdfjs-wasm/'

export type PageSize = { w: number; h: number }

type Doc = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>

function Page({ doc, index, count, overlay }: { doc: Doc; index: number; count: number; overlay: (page: number, size: PageSize | null) => ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const page = useRef<Awaited<ReturnType<Doc['getPage']>> | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [near, setNear] = useState(false)
  const drawn = useRef(false)

  useEffect(() => {
    let live = true
    void doc.getPage(index + 1).then((p) => {
      if (!live) return
      page.current = p
      const v = p.getViewport({ scale: 1 })
      setSize({ w: v.width, h: v.height })
    })
    return () => {
      live = false
    }
  }, [doc, index])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const watch = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '800px 0px' })
    watch.observe(el)
    return () => watch.disconnect()
  }, [])

  useEffect(() => {
    if (!near || !size || drawn.current || !page.current || !canvas.current || !wrap.current) return
    drawn.current = true
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const scale = Math.min(2.5, (wrap.current.clientWidth * ratio) / size.w)
    const viewport = page.current.getViewport({ scale })
    const c = canvas.current
    c.width = Math.floor(viewport.width)
    c.height = Math.floor(viewport.height)
    void page.current.render({ canvas: c, canvasContext: c.getContext('2d')!, viewport }).promise.catch(() => {
      drawn.current = false
    })
  }, [near, size])

  return (
    <section aria-label={`Page ${index + 1} of ${count}`} className="mx-auto w-full max-w-[760px]">
      <div ref={wrap} className="relative w-full overflow-hidden rounded-sm bg-white shadow-md ring-1 ring-black/10" style={{ aspectRatio: size ? `${size.w} / ${size.h}` : '612 / 792', containerType: 'inline-size' }} data-page={index}>
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-hidden="true" />
        {overlay(index, size)}
      </div>
    </section>
  )
}

/** Every page of the document at `url`, each with whatever `overlay(pageIndex)` draws over it. */
export function PdfPages({ url, overlay, onError }: { url: string; overlay: (page: number, size: PageSize | null) => ReactNode; onError: (message: string) => void }) {
  const [doc, setDoc] = useState<Doc | null>(null)
  useEffect(() => {
    let live = true
    let task: ReturnType<typeof pdfjs.getDocument> | null = null
    ;(async () => {
      try {
        const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `The document could not be loaded (${res.status})`)
        task = pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()), enableXfa: false, wasmUrl: PDFJS_WASM_URL })
        const loaded = await task.promise
        if (live) setDoc(loaded)
      } catch (e) {
        if (live) onError((e as Error).message)
      }
    })()
    return () => {
      live = false
      void task?.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])
  if (!doc) return <p className="py-10 text-center text-sm text-neutral-600">Loading the document…</p>
  return (
    <div className="grid gap-4">
      {Array.from({ length: doc.numPages }, (_, i) => (
        <Page key={i} doc={doc} index={i} count={doc.numPages} overlay={overlay} />
      ))}
    </div>
  )
}
