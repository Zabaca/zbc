// Where a document's fields go: the page viewer with a signature, initials, date, text or checkbox placed on any page for each
// signer, moved and resized with a finger or the arrow keys, plus the PDF's own fields offered in place. A box is stored as
// fractions of the page AS SHOWN (src/fields.ts), which is what the box on screen is a fraction of, so what is placed here is
// where the signer sees it and where the engine stamps it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentDetail, OwnField } from '@space/forms/src/documents/shared'
import { MAX_FIELD_SIGNERS } from '@space/forms/src/documents/shared'
import { FIELD_CATALOG, FIELD_TYPES, type FieldType, MAX_FIELDS, type PreparedField, defaultBox } from '@space/forms/src/fields'
import type { FractionBox } from '@space/forms/src/pdf/geometry'
import { Button, Card, Field, INPUT, Notice, useLoad } from '../kit'
import { href } from '../route'
import { documents } from './api'
import { PageViewer } from './PageViewer'

/** A placed field with a key of its own while it is being edited (the server keeps no ids for fields). */
type Placed = PreparedField & { key: string }

export const SIGNER_COLORS = ['#2563eb', '#15803d', '#b45309', '#7e22ce'] as const
const colorOf = (recipient: number) => SIGNER_COLORS[(recipient - 1) % SIGNER_COLORS.length]!

/** No field is narrower or shorter than this, in points. */
const MIN_POINTS = 8
const NUDGE = 0.0025

const round = (n: number) => Math.round(n * 100000) / 100000
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
let counter = 0
const keyed = (f: PreparedField): Placed => ({ ...f, key: `f${++counter}` })
const plain = (f: Placed): PreparedField => ({ recipient: f.recipient, type: f.type, page: f.page, box: { x: round(f.box.x), y: round(f.box.y), width: round(f.box.width), height: round(f.box.height) }, required: f.required, label: f.label ?? null, pdfFieldName: f.pdfFieldName ?? null })
const snapshot = (fields: Placed[]) => JSON.stringify(fields.map(plain))
const signersIn = (fields: { recipient: number }[]) => Math.max(1, ...fields.map((f) => f.recipient))

const LABEL_HINT: Record<FieldType, string> = {
  signature: 'Shown to the signer on the box.',
  initials: 'Shown to the signer on the box.',
  date: 'Shown to the signer on the box. The date fills itself in when they finish.',
  text: 'What the signer is asked to type, for example Printed name.',
  checkbox: 'What the signer agrees to, for example I have read the notice.',
}

/** A name a person can read, from a PDF field's own: its last part with no index, when that is words. */
function readable(name: string): string | null {
  const last = name.split('.').pop()!.replace(/\[\d+\]$/, '')
  return /^[A-Za-z][A-Za-z ]{2,}$/.test(last) ? last : null
}

function FieldBox({ f, size, selected, onSelect, onChange, onRemove }: { f: Placed; size: { width: number; height: number }; selected: boolean; onSelect: () => void; onChange: (box: FractionBox) => void; onRemove: () => void }) {
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; box: FractionBox; w: number; h: number } | null>(null)
  const locked = Boolean(f.pdfFieldName)
  const color = colorOf(f.recipient)
  const kind = FIELD_CATALOG[f.type]
  const minW = Math.min(1, MIN_POINTS / size.width)
  const minH = Math.min(1, MIN_POINTS / size.height)

  function start(e: React.PointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    e.stopPropagation()
    onSelect()
    if (locked) return
    const page = (e.currentTarget.closest('[data-page]') as HTMLElement).getBoundingClientRect()
    drag.current = { mode, x: e.clientX, y: e.clientY, box: f.box, w: page.width, h: page.height }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function move(e: React.PointerEvent<HTMLElement>) {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / d.w
    const dy = (e.clientY - d.y) / d.h
    if (d.mode === 'move') onChange({ ...d.box, x: clamp(d.box.x + dx, 0, 1 - d.box.width), y: clamp(d.box.y + dy, 0, 1 - d.box.height) })
    else onChange({ ...d.box, width: clamp(d.box.width + dx, minW, 1 - d.box.x), height: clamp(d.box.height + dy, minH, 1 - d.box.y) })
  }
  const end = () => {
    drag.current = null
  }

  function key(e: React.KeyboardEvent) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      return onRemove()
    }
    const step = e.shiftKey ? NUDGE * 4 : NUDGE
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (!d || locked) return
    e.preventDefault()
    const b = f.box
    if (e.altKey) onChange({ ...b, width: clamp(b.width + d[0]!, minW, 1 - b.x), height: clamp(b.height + d[1]!, minH, 1 - b.y) })
    else onChange({ ...b, x: clamp(b.x + d[0]!, 0, 1 - b.width), y: clamp(b.y + d[1]!, 0, 1 - b.height) })
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${f.label || kind.label}, ${kind.label.toLowerCase()} for signer ${f.recipient}${locked ? ", the file's own field" : ''}${selected ? ', selected' : ''}`}
      aria-pressed={selected}
      data-field={f.key}
      data-type={f.type}
      data-recipient={f.recipient}
      onPointerDown={(e) => start(e, 'move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={(e) => e.stopPropagation()}
      onFocus={onSelect}
      onKeyDown={key}
      className="absolute flex items-center overflow-hidden rounded-[2px] outline-offset-2"
      style={{
        left: `${f.box.x * 100}%`,
        top: `${f.box.y * 100}%`,
        width: `${f.box.width * 100}%`,
        height: `${f.box.height * 100}%`,
        border: `${selected ? 2 : 1}px ${locked ? 'dashed' : 'solid'} ${color}`,
        background: `color-mix(in srgb, ${color} ${selected ? 26 : 14}%, transparent)`,
        boxShadow: selected ? `0 0 0 2px white, 0 0 0 4px ${color}` : undefined,
        cursor: locked ? 'pointer' : 'move',
        touchAction: 'none',
        zIndex: selected ? 3 : 2,
      }}
    >
      <span className="pointer-events-none truncate px-1 font-medium" style={{ color, fontSize: 'clamp(7px, 1.7cqw, 12px)' }}>
        {f.type === 'checkbox' ? '' : `${f.label || kind.label}${f.required ? '' : ' (optional)'}`}
      </span>
      {selected && !locked ? (
        <span
          data-handle="resize"
          aria-hidden="true"
          onPointerDown={(e) => start(e, 'resize')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          className="absolute -bottom-1 -right-1 size-4 cursor-nwse-resize rounded-sm border-2 bg-white"
          style={{ borderColor: color, touchAction: 'none' }}
        />
      ) : null}
    </div>
  )
}

function Notes({ doc }: { doc: DocumentDetail }) {
  const i = doc.inspection
  const lines: string[] = []
  if (i.scannedPages.length > 0) lines.push(`${i.scannedPages.length === i.pages.length ? 'Every page is' : `Page${i.scannedPages.length === 1 ? '' : 's'} ${i.scannedPages.map((p) => p + 1).join(', ')} ${i.scannedPages.length === 1 ? 'is' : 'are'}`} a scan (a picture of text), so it has no fields of its own; place yours over it.`)
  if (i.turnedPages.length > 0) lines.push(`Page${i.turnedPages.length === 1 ? '' : 's'} ${i.turnedPages.map((p) => p + 1).join(', ')} ${i.turnedPages.length === 1 ? 'is' : 'are'} stored turned; they are shown here the way a reader shows them, and fields are placed on what you see.`)
  if (i.mixedSizes) lines.push('The pages are not all one size.')
  if (i.signatures > 0) lines.push(`The file carried ${i.signatures} earlier signature${i.signatures === 1 ? '' : 's'}. Once it is signed here a PDF reader shows ${i.signatures === 1 ? 'it' : 'them'} as changed.`)
  if (i.encrypted && !i.restrictionsOnly) lines.push('The file had a password. It was used once to open the file and is not kept; our working copy has none.')
  if (i.confirmed.restrictions) lines.push('The file restricted changes; the restrictions were removed from our working copy when it was uploaded, on your confirmation.')
  if (i.xfa === 'with-fields') lines.push('The file had a dynamic (XFA) layer as well as its ordinary fields; the dynamic layer was dropped and the ordinary fields kept.')
  if (i.recovered) lines.push('The file was damaged and has been repaired; check every page below.')
  if (lines.length === 0) return null
  return (
    <Card title="About this file">
      <ul className="grid gap-2 text-sm">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </Card>
  )
}

export default function Placement({ id }: { id: string }) {
  const doc = useLoad(() => documents.get(id), [id])
  if (doc.error) return <Notice kind="error">{doc.error}</Notice>
  if (!doc.data) return <p className="text-sm text-muted-foreground">Loading…</p>
  return <Editor key={doc.data.id} doc={doc.data} />
}

function Editor({ doc: initial }: { doc: DocumentDetail }) {
  const [doc, setDoc] = useState(initial)
  const [fields, setFields] = useState<Placed[]>(() => initial.fields.map(keyed))
  const [saved, setSaved] = useState(() => snapshot(initial.fields.map(keyed)))
  const [signer, setSigner] = useState(1)
  const [signerCount, setSignerCount] = useState(() => signersIn(initial.fields))
  const [tool, setTool] = useState<FieldType | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const dirty = useMemo(() => snapshot(fields) !== saved, [fields, saved])
  const chosen = fields.find((f) => f.key === selected) ?? null
  const used = useMemo(() => new Set(fields.map((f) => f.pdfFieldName).filter(Boolean) as string[]), [fields])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    addEventListener('beforeunload', warn)
    return () => removeEventListener('beforeunload', warn)
  }, [dirty])

  const pages = doc.inspection.pages
  const add = useCallback(
    (f: PreparedField) => {
      if (fields.length >= MAX_FIELDS) return setError(`A document has at most ${MAX_FIELDS} fields.`)
      const k = keyed(f)
      setFields((all) => [...all, k])
      setSelected(k.key)
      setError(null)
    },
    [fields.length],
  )
  const patch = (key: string, p: Partial<PreparedField>) => setFields((all) => all.map((f) => (f.key === key ? { ...f, ...p } : f)))
  const remove = (key: string) => {
    setFields((all) => all.filter((f) => f.key !== key))
    setSelected((s) => (s === key ? null : s))
  }

  function place(pageIndex: number, at: { x: number; y: number }) {
    if (!tool) return setSelected(null)
    const p = pages[pageIndex]!
    add({ recipient: signer, type: tool, page: pageIndex, box: defaultBox(tool, p, at), required: true, label: null, pdfFieldName: null })
    setTool(null)
  }

  function giveOwnField(s: OwnField) {
    add({ recipient: signer, type: s.kind === 'text' ? 'text' : s.kind === 'checkbox' ? 'checkbox' : 'signature', page: s.page, box: s.box, required: true, label: readable(s.name), pdfFieldName: s.name })
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const next = await documents.place(doc.id, fields.map(plain))
      setDoc(next)
      setSaved(snapshot(fields))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const signerButtons = Array.from({ length: signerCount }, (_, i) => i + 1)
  const countOf = (n: number) => fields.filter((f) => f.recipient === n).length
  const highest = Math.max(0, ...fields.map((f) => f.recipient))
  // Signers are numbered in the order Send names them, so a number below the last one used with nothing on it cannot be sent.
  const gaps = signerButtons.filter((n) => n < highest && countOf(n) === 0)

  return (
    <>
      <div>
        <a href={href('/documents')} className="text-sm text-muted-foreground underline">
          Documents
        </a>
        <h1 className="text-xl font-semibold">{doc.name}</h1>
        <p className="text-xs text-muted-foreground">
          {pages.length} page{pages.length === 1 ? '' : 's'}. Choose who signs and what to add, then tap where it goes on the page. Drag a box to move it, drag its corner to resize it, or use the arrow keys (with Option or Alt to resize).
        </p>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="grid gap-3">
          <div className="sticky top-0 z-10 grid gap-2 rounded-lg border border-border bg-card p-2 shadow-sm" style={{ top: 'env(safe-area-inset-top, 0px)' }} role="toolbar" aria-label="Add a field">
            {/* One line each that scrolls sideways, so on a phone the toolbar that stays on screen is two rows, not five. */}
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="group" aria-label="Who signs">
                {signerButtons.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={signer === n}
                    onClick={() => setSigner(n)}
                    className="inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-sm font-medium"
                    style={{ borderColor: colorOf(n), background: signer === n ? colorOf(n) : 'transparent', color: signer === n ? 'white' : colorOf(n) }}
                  >
                    Signer {n} <span className="text-xs opacity-80">({countOf(n)})</span>
                  </button>
                ))}
                {signerCount < MAX_FIELD_SIGNERS ? (
                  <button type="button" className="inline-flex min-h-9 shrink-0 items-center whitespace-nowrap rounded-md border border-input px-3 text-sm" onClick={() => (setSignerCount(signerCount + 1), setSigner(signerCount + 1))}>
                    Add a signer
                  </button>
                ) : null}
              </div>
              <Button type="button" className="min-h-9 shrink-0" onClick={save} disabled={saving || !dirty}>
                {saving ? 'Saving…' : dirty ? 'Save fields' : 'Saved'}
              </Button>
            </div>
            <div className="flex items-center gap-1 overflow-x-auto" role="group" aria-label="What to add">
              {FIELD_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  aria-pressed={tool === t}
                  onClick={() => setTool(tool === t ? null : t)}
                  className="inline-flex min-h-9 shrink-0 items-center whitespace-nowrap rounded-md border border-input px-3 text-sm font-medium"
                  style={tool === t ? { background: colorOf(signer), color: 'white', borderColor: colorOf(signer) } : undefined}
                >
                  {FIELD_CATALOG[t].label}
                </button>
              ))}
            </div>
            {tool ? (
              <p className="text-xs" role="status">
                Tap the page where the {FIELD_CATALOG[tool].label.toLowerCase()} for signer {signer} goes.
              </p>
            ) : null}
          </div>
          {loadError ? <Notice kind="error">{loadError}</Notice> : null}
          <PageViewer
            url={documents.pdfUrl(doc.id)}
            pages={pages}
            onError={setLoadError}
            onBackground={place}
            overlay={(pageIndex) => {
              const p = pages[pageIndex]!
              return (
                <>
                  {doc.own_fields
                    .filter((s) => s.page === pageIndex && !used.has(s.name))
                    .map((s) => (
                      <button
                        key={s.name}
                        type="button"
                        data-own-field={s.name}
                        aria-label={`Use the file's own ${s.kind} field ${readable(s.name) ?? ''} for signer ${signer}`.replace(/\s+/g, ' ')}
                        onClick={(e) => (e.stopPropagation(), giveOwnField(s))}
                        // With a field chosen, a tap is for placing it, wherever it lands; the file's own fields wait.
                        className="absolute rounded-[2px] border border-dashed border-neutral-500 bg-neutral-400/10 hover:bg-neutral-400/30"
                        style={{ left: `${s.box.x * 100}%`, top: `${s.box.y * 100}%`, width: `${s.box.width * 100}%`, height: `${s.box.height * 100}%`, zIndex: 1, pointerEvents: tool ? 'none' : 'auto' }}
                      />
                    ))}
                  {fields
                    .filter((f) => f.page === pageIndex)
                    .map((f) => (
                      <FieldBox key={f.key} f={f} size={p} selected={f.key === selected} onSelect={() => setSelected(f.key)} onChange={(box) => patch(f.key, { box })} onRemove={() => remove(f.key)} />
                    ))}
                </>
              )
            }}
          />
        </div>

        <div className="grid gap-3 lg:sticky lg:top-3">
          {error ? <Notice kind="error">{error}</Notice> : null}
          {!dirty && fields.length > 0 && gaps.length === 0 ? (
            <Notice kind="ok">
              Saved. {doc.fields_placed} field{doc.fields_placed === 1 ? '' : 's'} for {doc.signers.length === 1 ? 'one signer' : `${doc.signers.length} signers`}. <a className="underline" href={href(`/send?client=${doc.client_id}`)}>Send it</a>, naming {doc.signers.length === 1 ? 'one signer' : `${doc.signers.length} signers`}.
            </Notice>
          ) : null}
          {gaps.length > 0 ? <Notice kind="warn">Signer {gaps.join(' and ')} {gaps.length === 1 ? 'has' : 'have'} no fields. Signers are numbered in the order you name them when you send, so every number up to the last needs at least one field.</Notice> : null}
          <Card title="Selected field">
            {chosen ? (
              <div className="grid gap-3">
                <Field label="Type" htmlFor="sel-type">
                  <select
                    id="sel-type"
                    className={INPUT}
                    value={chosen.type}
                    disabled={Boolean(chosen.pdfFieldName) && (doc.own_fields.find((s) => s.name === chosen.pdfFieldName)?.types.length ?? 0) < 2}
                    onChange={(e) => {
                      const type = e.target.value as FieldType
                      const p = pages[chosen.page]!
                      // A field of the file's own keeps its box; one placed here takes the new type's size from where it is.
                      patch(chosen.key, { type, ...(chosen.pdfFieldName ? {} : { box: defaultBox(type, p, { x: chosen.box.x + chosen.box.width / 2, y: chosen.box.y + chosen.box.height / 2 }) }) })
                    }}
                  >
                    {(chosen.pdfFieldName ? (doc.own_fields.find((s) => s.name === chosen.pdfFieldName)?.types ?? [chosen.type]) : [...FIELD_TYPES]).map((t) => (
                      <option key={t} value={t}>
                        {FIELD_CATALOG[t].label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Signer" htmlFor="sel-signer">
                  <select id="sel-signer" className={INPUT} value={chosen.recipient} onChange={(e) => patch(chosen.key, { recipient: Number(e.target.value) })}>
                    {signerButtons.map((n) => (
                      <option key={n} value={n}>
                        Signer {n}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Label" htmlFor="sel-label" hint={LABEL_HINT[chosen.type]}>
                  <input id="sel-label" className={INPUT} maxLength={80} value={chosen.label ?? ''} placeholder={FIELD_CATALOG[chosen.type].label} onChange={(e) => patch(chosen.key, { label: e.target.value || null })} />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={chosen.required} onChange={(e) => patch(chosen.key, { required: e.target.checked })} /> The signer must fill this in
                </label>
                {chosen.pdfFieldName ? (
                  <p className="text-xs text-muted-foreground">
                    This is the PDF's own field. It stays where the file puts it, and the signer's answer is written into it.
                    {(doc.own_fields.find((s) => s.name === chosen.pdfFieldName)?.widgets ?? 1) > 1 ? ` The file shows it in ${doc.own_fields.find((s) => s.name === chosen.pdfFieldName)!.widgets} places; the signer is shown the first and the answer is written into every one.` : ''}
                  </p>
                ) : null}
                <div>
                  <Button kind="quiet" type="button" onClick={() => remove(chosen.key)}>
                    Remove this field
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Select a field on a page to change who it is for, what it says or whether it is required.</p>
            )}
          </Card>
          {doc.own_fields.length > 0 || doc.left_as_is.length > 0 ? (
            <Card title="Fields already in the file">
              {doc.own_fields.length > 0 ? (
                <>
                  <p className="mb-2 text-sm">
                    Dashed boxes on the pages are fields the PDF already has. Tap one to give it to signer {signer}; the signer's answer is written into it. {doc.own_fields.length - [...used].length} left unused.
                  </p>
                  <ul className="mb-3 grid max-h-48 gap-1 overflow-y-auto text-xs">
                    {doc.own_fields.map((s) => {
                      const mine = fields.find((f) => f.pdfFieldName === s.name)
                      return (
                        <li key={s.name} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate" title={s.name}>
                            Page {s.page + 1}: {s.kind} {readable(s.name) ?? s.name.split('.').pop()}
                          </span>
                          {mine ? (
                            <button type="button" className="shrink-0 underline" onClick={() => remove(mine.key)}>
                              Signer {mine.recipient}, undo
                            </button>
                          ) : (
                            <button type="button" className="shrink-0 underline" onClick={() => giveOwnField(s)}>
                              Use for signer {signer}
                            </button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </>
              ) : null}
              {doc.left_as_is.length > 0 ? (
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium">{doc.left_as_is.length} left as the file has them</summary>
                  <ul className="mt-2 grid gap-1">
                    {doc.left_as_is.map((u) => (
                      <li key={u.name} title={u.name}>
                        {u.name.split('.').pop()}: {u.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </Card>
          ) : null}
          <Notes doc={doc} />
        </div>
      </div>
    </>
  )
}
