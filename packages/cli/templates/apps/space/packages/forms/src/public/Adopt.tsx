// Adopting a signature or initials: drawn on a pad (signature_pad, MIT, pinned), typed and shown in a script font (Dancing
// Script, OFL, bundled, so nothing loads from another site), or uploaded as a picture. Whatever the method, what leaves the
// page is a PNG: the typed one is drawn here in the script font, so the document shows exactly what the signer saw.
//
// The typed field starts BLANK: the signer types their own name, and nothing is filled in for them (an IRS consent must not
// carry a pre-filled signature, Rev. Proc. 2013-14 sec. 6.02). When the envelope is "typed name only", the dialog offers
// nothing else: no pad, no picture.
import '@fontsource/dancing-script/latin-700.css'
import SignaturePad from 'signature_pad'
import { useEffect, useRef, useState } from 'react'
import type { AdoptionKind, AdoptionMethod } from '../vocab'

export type Adoption = { kind: AdoptionKind; method: AdoptionMethod; image: string; typed_text?: string; typed_font?: string }

const FONT = 'Dancing Script'
const MAX_SIDE = 900

/** The smallest canvas holding every non-transparent pixel, so a signature fills its box and not the pad around it. */
function trim(src: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = src.getContext('2d')!
  const { width, height } = src
  const data = ctx.getImageData(0, 0, width, height).data
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return src
  const pad = 6
  const out = document.createElement('canvas')
  out.width = Math.min(MAX_SIDE, x1 - x0 + 1 + pad * 2)
  out.height = Math.round((out.width / (x1 - x0 + 1 + pad * 2)) * (y1 - y0 + 1 + pad * 2))
  out.getContext('2d')!.drawImage(src, x0 - pad, y0 - pad, x1 - x0 + 1 + pad * 2, y1 - y0 + 1 + pad * 2, 0, 0, out.width, out.height)
  return out
}

const png = (c: HTMLCanvasElement) => c.toDataURL('image/png').split(',')[1]!

async function typedImage(text: string): Promise<string> {
  await document.fonts.load(`700 80px "${FONT}"`)
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')!
  ctx.font = `700 80px "${FONT}"`
  c.width = Math.ceil(ctx.measureText(text).width) + 40
  c.height = 130
  ctx.font = `700 80px "${FONT}"`
  ctx.fillStyle = '#101c40'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 20, 68)
  return png(trim(c))
}

function fromFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.width * scale))
      c.height = Math.max(1, Math.round(img.height * scale))
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url)
      resolve(png(c))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('That picture could not be read. Use a PNG or a JPEG.'))
    }
    img.src = url
  })
}

type Tab = 'draw' | 'type' | 'upload'

export function AdoptDialog({ kind, typedOnly, onAdopt, onClose }: { kind: AdoptionKind; typedOnly: boolean; onAdopt: (a: Adoption) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const pad = useRef<SignaturePad | null>(null)
  const [tab, setTab] = useState<Tab>(typedOnly ? 'type' : 'draw')
  const [typed, setTyped] = useState('')
  const [picked, setPicked] = useState<{ image: string; url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const label = kind === 'signature' ? 'signature' : 'initials'

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  useEffect(() => {
    if (tab !== 'draw' || !canvas.current) return
    const c = canvas.current
    const ratio = Math.max(window.devicePixelRatio || 1, 1)
    c.width = c.offsetWidth * ratio
    c.height = c.offsetHeight * ratio
    c.getContext('2d')!.scale(ratio, ratio)
    const p = new SignaturePad(c, { penColor: '#101c40', minWidth: 0.8, maxWidth: 2.6 })
    pad.current = p
    return () => p.off()
  }, [tab])

  async function apply() {
    setError(null)
    setBusy(true)
    try {
      if (tab === 'draw') {
        if (!pad.current || pad.current.isEmpty()) throw new Error(`Draw your ${label} first, with your finger or a mouse.`)
        await onAdopt({ kind, method: 'drawn', image: png(trim(canvas.current!)) })
      } else if (tab === 'type') {
        if (typed.trim() === '') throw new Error(`Type your ${kind === 'signature' ? 'name' : 'initials'} first.`)
        await onAdopt({ kind, method: 'typed', image: await typedImage(typed.trim()), typed_text: typed.trim(), typed_font: FONT })
      } else {
        if (!picked) throw new Error('Choose a picture first.')
        await onAdopt({ kind, method: 'uploaded', image: picked.image })
      }
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const tabs: [Tab, string][] = typedOnly ? [['type', 'Type']] : [['draw', 'Draw'], ['type', 'Type'], ['upload', 'Upload']]
  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="adopt-title" className="m-auto w-[min(32rem,calc(100vw-1.5rem))] rounded-xl p-0 shadow-2xl backdrop:bg-black/50">
      <div className="grid gap-3 p-4">
        <h2 id="adopt-title" className="text-lg font-semibold">
          Add your {label}
        </h2>
        {typedOnly ? <p className="text-sm">For this document, type your own name. Drawing and pictures are not accepted.</p> : null}
        <div role="tablist" aria-label="How to add it" className="flex gap-1">
          {tabs.map(([t, text]) => (
            <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={`min-h-11 flex-1 rounded-md border px-3 text-sm font-medium ${tab === t ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300 bg-white'}`}>
              {text}
            </button>
          ))}
        </div>
        {tab === 'draw' ? (
          <div className="grid gap-2">
            <canvas ref={canvas} aria-label={`Draw your ${label} here`} className="h-40 w-full touch-none rounded-md border border-neutral-400 bg-white" />
            <button type="button" className="min-h-10 justify-self-start rounded-md border border-neutral-300 px-3 text-sm" onClick={() => pad.current?.clear()}>
              Clear
            </button>
          </div>
        ) : null}
        {tab === 'type' ? (
          <div className="grid gap-2">
            <label className="grid gap-1 text-sm font-medium">
              Your {kind === 'signature' ? 'full name' : 'initials'}
              <input className="min-h-11 rounded-md border border-neutral-400 px-3 text-base" value={typed} maxLength={80} onChange={(e) => setTyped(e.target.value)} autoComplete="name" />
            </label>
            <p className="flex min-h-24 items-center overflow-hidden rounded-md border border-neutral-300 bg-white px-4 text-5xl text-[#101c40]" style={{ fontFamily: `"${FONT}", cursive`, fontWeight: 700 }} aria-hidden="true">
              {typed || ' '}
            </p>
          </div>
        ) : null}
        {tab === 'upload' ? (
          <div className="grid gap-2">
            <label className="grid gap-1 text-sm font-medium">
              A picture of your {label} (PNG or JPEG)
              <input
                type="file"
                accept="image/png,image/jpeg"
                className="text-sm"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  setError(null)
                  try {
                    const image = await fromFile(file)
                    setPicked({ image, url: `data:image/png;base64,${image}` })
                  } catch (err) {
                    setPicked(null)
                    setError((err as Error).message)
                  }
                }}
              />
            </label>
            {picked ? <img src={picked.url} alt={`Your ${label}`} className="max-h-32 justify-self-start rounded-md border border-neutral-300 bg-white p-1" /> : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}
        <p className="text-xs text-neutral-600">It will be used wherever you sign or initial in this document.</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="min-h-11 rounded-md border border-neutral-300 px-4 text-sm font-medium" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button type="button" disabled={busy} className="min-h-11 rounded-md bg-neutral-900 px-4 text-sm font-medium text-white disabled:opacity-50" onClick={() => void apply()}>
            {busy ? 'Saving…' : `Use this ${label}`}
          </button>
        </div>
      </div>
    </dialog>
  )
}
