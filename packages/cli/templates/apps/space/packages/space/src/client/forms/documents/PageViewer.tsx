// The operator's page viewer: every page of a document drawn with pdf.js (pinned, the legacy build the signer's page uses), each in
// a box that has the page's SHOWN shape as the upload recorded it (the engine's own reading of the rotation and crop box, not
// pdf.js's), so a fraction of the box is a fraction of the shown page and a field placed on it is stamped in the same place.
// pdf.js draws its page into the box; it turns the page by /Rotate and clips to the crop box itself, and the e2e test checks that
// its shape and the engine's agree on the rotated and crop-offset fixtures.
//
// Not src/public/PdfPages.tsx: that one fetches without credentials (a signer's link needs none), and the admin's documents sit
// behind Access, which needs its cookie.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { PDFJS_WASM_URL } from '@space/forms/src/public/PdfPages'
import { type ReactNode, useEffect, useRef, useState } from 'react'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

type Doc = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>

export interface ShownPage {
  index: number
  width: number
  height: number
}

function Page({ doc, page, count, onBackground, children }: { doc: Doc; page: ShownPage; count: number; onBackground: (fraction: { x: number; y: number }) => void; children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)
  const drawn = useRef(false)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const watch = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '800px 0px' })
    watch.observe(el)
    return () => watch.disconnect()
  }, [])

  useEffect(() => {
    if (!near || drawn.current || !canvas.current || !wrap.current) return
    drawn.current = true
    let live = true
    void doc.getPage(page.index + 1).then((p) => {
      if (!live || !canvas.current || !wrap.current) return
      const v1 = p.getViewport({ scale: 1 })
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = p.getViewport({ scale: Math.min(2.5, (wrap.current.clientWidth * ratio) / v1.width) })
      const c = canvas.current
      c.width = Math.floor(viewport.width)
      c.height = Math.floor(viewport.height)
      c.dataset.pdfjsShape = String(v1.width / v1.height)
      void p.render({ canvas: c, canvasContext: c.getContext('2d')!, viewport }).promise.then(
        () => {
          c.dataset.drawn = 'true'
        },
        () => {
          drawn.current = false
        },
      )
    })
    return () => {
      live = false
    }
  }, [near, doc, page.index])

  return (
    <section aria-label={`Page ${page.index + 1} of ${count}`} className="mx-auto w-full max-w-[760px]">
      <p className="mb-1 text-xs text-muted-foreground">
        Page {page.index + 1} of {count}
      </p>
      <div
        ref={wrap}
        data-page={page.index}
        data-shape={page.width / page.height}
        className="relative w-full select-none overflow-hidden rounded-sm bg-white shadow-md ring-1 ring-black/10"
        style={{ aspectRatio: `${page.width} / ${page.height}`, containerType: 'inline-size', touchAction: 'pan-y' }}
        onClick={(e) => {
          // A tap on the page itself (not on a field) is a place to put the chosen field; a scroll is not a tap.
          if (e.target !== e.currentTarget && e.target !== canvas.current) return
          const r = e.currentTarget.getBoundingClientRect()
          onBackground({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height })
        }}
      >
        <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />
        {children}
      </div>
    </section>
  )
}

/** Every page of the PDF at `url`, each with what `overlay(pageIndex)` draws on it; a press on a page's own surface reports where. */
export function PageViewer({ url, pages, overlay, onBackground, onError }: { url: string; pages: ShownPage[]; overlay: (page: number) => ReactNode; onBackground: (page: number, at: { x: number; y: number }) => void; onError: (message: string) => void }) {
  const [doc, setDoc] = useState<Doc | null>(null)
  useEffect(() => {
    let live = true
    let task: ReturnType<typeof pdfjs.getDocument> | null = null
    ;(async () => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' })
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
  if (!doc) return <p className="py-10 text-center text-sm text-muted-foreground">Loading the document…</p>
  return (
    <div className="grid gap-6">
      {pages.map((p) => (
        <Page key={p.index} doc={doc} page={p} count={pages.length} onBackground={(at) => onBackground(p.index, at)}>
          {overlay(p.index)}
        </Page>
      ))}
    </div>
  )
}
