// What a signer sees at /s/<token>: the business's own page (its name, logo and color, a small "via <service name>"), the
// consent first, then the document with a guided walk through their fields, then Finish. Every state a link can be in has
// a screen that says what it is and who to ask. Built for a phone first: large targets, one thing at a time, nothing that
// needs a hover, every control labelled for a screen reader.
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CONSENT_BUTTON, SAMPLE_LINK } from '../consent'
import { FIELD_CATALOG } from '../fields'
import type { AdoptionKind } from '../vocab'
import { type Adoption, AdoptDialog } from './Adopt'
import { FormFiller } from './Filler'
import { PdfPages } from './PdfPages'
import { type ServiceWords, viaSuffix } from '../service'
import { ApiError, type Brand, type Certificate, type SignerField, type UploadedFile, type View, fetchService, signerApi } from './api'

const BTN = 'inline-flex min-h-12 items-center justify-center rounded-lg px-5 text-base font-semibold disabled:opacity-50'
const GHOST = `${BTN} border border-neutral-400 bg-white text-neutral-900`

const longDate = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(`${iso}T12:00:00Z`))

function Shell({ brand, service, children }: { brand: Brand | null; service: ServiceWords | null; children: ReactNode }) {
  const accent = brand?.accent ?? '#1f4e79'
  return (
    <div className="min-h-dvh bg-neutral-100 text-neutral-900" style={{ ['--accent' as string]: accent }}>
      <header className="text-white" style={{ backgroundColor: accent }}>
        <div className="mx-auto flex max-w-[760px] items-center gap-3 px-4 py-3">
          {brand?.logo ? <img src={brand.logo} alt="" className="max-h-10 max-w-40 rounded bg-white/95 object-contain p-1" /> : null}
          <div className="leading-tight">
            <p className="text-lg font-bold">{brand?.name ?? service?.name ?? ''}</p>
            {brand && service && viaSuffix(service) ? <p className="text-xs opacity-90">{viaSuffix(service)}</p> : null}
          </div>
        </div>
      </header>
      {children}
    </div>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto grid max-w-[760px] gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold leading-tight">{title}</h1>
      {children}
    </main>
  )
}

function Contact({ brand }: { brand: Brand }) {
  return (
    <p className="text-sm text-neutral-700">
      Questions? Contact {brand.name} at <a className="underline" href={`mailto:${brand.replyTo}`}>{brand.replyTo}</a>.
    </p>
  )
}

function useDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return ref
}

function DeclineDialog({ open, onCancel, onDecline }: { open: boolean; onCancel: () => void; onDecline: (reason: string) => Promise<void> }) {
  const ref = useDialog(open)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <dialog ref={ref} onClose={onCancel} aria-labelledby="decline-title" className="m-auto w-[min(30rem,calc(100vw-1.5rem))] rounded-xl p-0 shadow-2xl backdrop:bg-black/50">
      <form
        method="dialog"
        className="grid gap-3 p-4"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          await onDecline(reason).finally(() => setBusy(false))
        }}
      >
        <h2 id="decline-title" className="text-lg font-semibold">
          Decline to sign?
        </h2>
        <p className="text-sm">This ends it for everyone. The business, and anyone who already signed, will be told that you declined, and will see the reason if you give one.</p>
        <label className="grid gap-1 text-sm font-medium">
          Your reason (optional)
          <textarea className="min-h-20 rounded-md border border-neutral-400 px-3 py-2 text-base" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={GHOST} onClick={onCancel}>
            Go back
          </button>
          <button type="submit" disabled={busy} className={`${BTN} bg-red-700 text-white`}>
            {busy ? 'Declining…' : 'Decline to sign'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

/** A paragraph of the consent text; where the text names the sample PDF, that is a link the signer opens. */
function ConsentParagraph({ text, sampleUrl, onSample }: { text: string; sampleUrl: string; onSample: () => void }) {
  const at = text.indexOf(SAMPLE_LINK)
  if (at < 0) return <p className="text-sm leading-relaxed">{text}</p>
  return (
    <p className="text-sm leading-relaxed">
      {text.slice(0, at)}
      <a className="font-semibold underline" href={sampleUrl} target="_blank" rel="noopener" onClick={onSample}>
        {SAMPLE_LINK.slice(1, -1)}
      </a>
      {text.slice(at + SAMPLE_LINK.length)}
    </p>
  )
}

function Consent({ view, api, onView, onDecline }: { view: View; api: ReturnType<typeof signerApi>; onView: (v: View) => void; onDecline: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The button waits for the sample: the signer has to try the very thing they are about to say they can do.
  const [sampleOpened, setSampleOpened] = useState(false)
  return (
    <Panel title={`${view.brand.name} sent you ${view.title} to sign`}>
      {view.note ? (
        <blockquote className="whitespace-pre-wrap rounded-lg border-l-4 bg-white p-3 text-sm" style={{ borderColor: 'var(--accent)' }}>
          {view.note}
        </blockquote>
      ) : null}
      <section aria-labelledby="consent-h" className="grid gap-3 rounded-xl bg-white p-4 shadow-sm">
        <h2 id="consent-h" className="text-lg font-semibold">
          Before you start: signing electronically
        </h2>
        {view.consent!.paragraphs.map((p, i) => (
          <ConsentParagraph key={i} text={p} sampleUrl={api.sampleUrl} onSample={() => setSampleOpened(true)} />
        ))}
        <p className="text-sm">
          <a className="underline" href={api.termsUrl} download>
            Save these terms (PDF)
          </a>
        </p>
        {error ? (
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !sampleOpened}
            className={`${BTN} text-white`}
            style={{ backgroundColor: 'var(--accent)' }}
            onClick={async () => {
              setBusy(true)
              try {
                onView(await api.consent())
              } catch (e) {
                setError((e as Error).message)
                setBusy(false)
              }
            }}
          >
            {CONSENT_BUTTON}
          </button>
          <button type="button" className={GHOST} onClick={onDecline}>
            Decline
          </button>
        </div>
        {sampleOpened ? null : <p className="text-xs text-neutral-600">Open the sample PDF above first. The button then works.</p>}
      </section>
      {view.expiresOn ? <p className="text-xs text-neutral-600">This link works until {view.expiresOn}.</p> : null}
      <Contact brand={view.brand} />
    </Panel>
  )
}

function CertificateView({ api }: { api: ReturnType<typeof signerApi> }) {
  const [cert, setCert] = useState<Certificate | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (cert)
    return (
      <section className="grid gap-2 rounded-xl bg-white p-4 text-sm shadow-sm" aria-label="Certificate of completion">
        <h2 className="text-lg font-semibold">{cert.title}</h2>
        <p className="text-xs text-neutral-600">{cert.viewNote}</p>
        <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[12rem_1fr]">
          {cert.summary.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-neutral-600">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
        {cert.recipients.map((r) => (
          <div key={r.id} className="border-t pt-2">
            <h3 className="font-semibold">{r.heading}</h3>
            <dl className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[12rem_1fr]">
              {r.rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-neutral-600">{k}</dt>
                  <dd className="break-words">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        {cert.consents.map((c) => (
          <div key={c.heading} className="border-t pt-2">
            <h3 className="font-semibold">{c.heading}</h3>
            {c.note ? <p className="text-xs text-neutral-600">{c.note}</p> : null}
            {c.paragraphs.map((p, i) => (
              <p key={i} className="mt-1 break-words text-xs">
                {p}
              </p>
            ))}
          </div>
        ))}
        <p className="break-words text-xs text-neutral-600">{cert.sealParagraph}</p>
      </section>
    )
  return (
    <div className="grid gap-2">
      <button type="button" className={GHOST} onClick={() => api.certificate().then(setCert, (e: Error) => setError(e.message))}>
        See the certificate of completion
      </button>
      {error ? <p role="alert" className="text-sm text-red-800">{error}</p> : null}
    </div>
  )
}

const sizeText = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** The files the customer uploaded, for the business's own copy addresses; nothing is drawn for anyone else or when there are none. */
function UploadedFiles({ api }: { api: ReturnType<typeof signerApi> }) {
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.uploads().then(
      (r) => live && setFiles(r.files),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [api])
  if (error) return <p role="alert" className="text-sm text-red-800">The customer's files could not be listed: {error}</p>
  if (files.length === 0) return null
  return (
    <section className="grid gap-2" aria-label="Files the customer uploaded">
      <h2 className="text-lg font-semibold">Files the customer uploaded</h2>
      <ul className="grid gap-2">
        {files.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-300 bg-white p-3">
            <span className="break-all text-sm">
              {f.name} <span className="text-neutral-600">({sizeText(f.size)})</span>
            </span>
            <a className={`${GHOST} no-underline`} href={api.uploadUrl(f.id)}>
              Download {f.name}
            </a>
          </li>
        ))}
      </ul>
      <p className="text-xs text-neutral-600">They may be private, such as an ID. Each download is recorded.</p>
    </section>
  )
}

function Done({ view, api }: { view: View; api: ReturnType<typeof signerApi> }) {
  const dl = view.download
  return (
    <Panel title="All done">
      <p>Everyone has signed {view.title}. The finished document was emailed to everyone named on it.</p>
      {dl?.available ? (
        <div className="grid gap-2">
          <a className={`${BTN} text-white no-underline`} style={{ backgroundColor: 'var(--accent)' }} href={api.downloadUrl}>
            Download the finished document
          </a>
          <p className="text-xs text-neutral-600">{dl.sensitive ? 'It holds private information, so it is not attached to the email. ' : ''}This link works until {dl.until}; each download is recorded.</p>
        </div>
      ) : (
        <p className="text-sm">The download link has run out. Ask {view.brand.name} for another copy.</p>
      )}
      {dl?.available ? <UploadedFiles api={api} /> : null}
      {view.certificate ? <CertificateView api={api} /> : null}
      <Contact brand={view.brand} />
    </Panel>
  )
}

/** One field on its page: the signer's own to fill, drawn over the document where the business placed it. */
function Box({ f, size, view, api, current, version, onTap }: { f: SignerField; size: { w: number; h: number } | null; view: View; api: ReturnType<typeof signerApi>; current: boolean; version: Record<string, string>; onTap: (f: SignerField) => void }) {
  const kind = FIELD_CATALOG[f.type]
  const fontSize = size ? `${(f.box.height * size.h) / size.w * 100 * 0.62}cqw` : '2cqw'
  const label = f.label || kind.label
  const state = f.type === 'date' ? 'filled in for you' : f.done ? 'done' : f.required ? 'required, not done yet' : 'optional, not done yet'
  const text = f.type === 'date' ? (view.isoToday ? longDate(view.isoToday) : view.today) : typeof f.value === 'string' ? f.value : ''
  return (
    <button
      type="button"
      data-field={f.id}
      aria-label={`${label}, ${state}`}
      disabled={f.type === 'date'}
      onClick={() => onTap(f)}
      className={`absolute flex items-center justify-center overflow-hidden rounded-[3px] border-2 text-left leading-none ${f.done || f.type === 'date' ? 'border-emerald-600/70 bg-emerald-50/50' : 'border-dashed bg-yellow-100/70'} ${current ? 'ring-4 ring-offset-1' : ''}`}
      style={{ left: `${f.box.x * 100}%`, top: `${f.box.y * 100}%`, width: `${f.box.width * 100}%`, height: `${f.box.height * 100}%`, borderColor: f.done || f.type === 'date' ? undefined : 'var(--accent)', ['--tw-ring-color' as string]: 'var(--accent)' }}
    >
      {(f.type === 'signature' || f.type === 'initials') && f.done ? (
        <img src={api.ownPicture(f.type, version[f.type] ?? '0')} alt="" className="h-full w-full object-contain" />
      ) : f.type === 'checkbox' && f.done ? (
        <span aria-hidden="true" style={{ fontSize }}>✓</span>
      ) : text ? (
        <span className="w-full truncate px-[2%] font-medium" style={{ fontSize }}>{text}</span>
      ) : (
        <span aria-hidden="true" className="w-full truncate px-[2%] text-center font-semibold" style={{ fontSize: size ? `${Math.min(((f.box.height * size.h) / size.w) * 100 * 0.45, 2.2)}cqw` : '1.6cqw', color: 'var(--accent)' }}>
          {f.type === 'checkbox' ? '' : f.label || kind.hint}
        </span>
      )}
    </button>
  )
}

function SignScreen({ view, api, onChanged, onDecline }: { view: View; api: ReturnType<typeof signerApi>; onChanged: () => Promise<void>; onDecline: () => void }) {
  const [fields, setFields] = useState<SignerField[]>(view.fields ?? [])
  const [adopted, setAdopted] = useState(view.adopted ?? { signature: false, initials: false })
  const [version, setVersion] = useState<Record<string, string>>({ signature: String(Date.now()), initials: String(Date.now()) })
  const [adoptFor, setAdoptFor] = useState<SignerField | null>(null)
  const [textFor, setTextFor] = useState<SignerField | null>(null)
  const [text, setText] = useState('')
  const [current, setCurrent] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textDialog = useDialog(textFor !== null)
  const finishDialog = useDialog(confirm)

  const ordered = useMemo(() => [...fields].sort((a, b) => a.page - b.page || a.box.y - b.box.y || a.box.x - b.box.x), [fields])
  const required = ordered.filter((f) => f.required && f.type !== 'date')
  const doneCount = required.filter((f) => f.done).length
  const next = required.find((f) => !f.done)
  const patch = (id: string, p: Partial<SignerField>) => setFields((fs) => fs.map((f) => (f.id === id ? { ...f, ...p } : f)))

  const guard = useCallback(async (run: () => Promise<void>) => {
    setError(null)
    try {
      await run()
    } catch (e) {
      setError((e as Error).message)
      if (e instanceof ApiError && e.status === 410) void onChanged()
    }
  }, [onChanged])

  const apply = (f: SignerField) => guard(async () => {
    await api.save(f.id, 'adopted')
    patch(f.id, { done: true, value: 'adopted' })
  })

  function tap(f: SignerField) {
    setCurrent(f.id)
    if (f.type === 'signature' || f.type === 'initials') {
      if (adopted[f.type] && !f.done) void apply(f)
      else setAdoptFor(f)
    } else if (f.type === 'text') {
      setText(typeof f.value === 'string' ? f.value : '')
      setTextFor(f)
    } else if (f.type === 'checkbox') {
      void guard(async () => {
        const value = f.value !== true
        await api.save(f.id, value)
        patch(f.id, { value, done: value })
      })
    }
  }

  function go() {
    const target = next ?? required[0]
    if (!target) return
    setCurrent(target.id)
    const el = document.querySelector<HTMLElement>(`[data-field="${target.id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el?.focus({ preventScroll: true })
  }

  async function adoptNow(a: Adoption) {
    const f = adoptFor!
    await api.adopt(a)
    setAdopted((x) => ({ ...x, [a.kind]: true }))
    setVersion((v) => ({ ...v, [a.kind]: String(Date.now()) }))
    setAdoptFor(null)
    await api.save(f.id, 'adopted')
    patch(f.id, { done: true, value: 'adopted' })
  }

  async function finish() {
    setBusy(true)
    await guard(async () => {
      await api.finish()
      setConfirm(false)
      await onChanged()
    })
    setBusy(false)
  }

  const mine = new Map<number, SignerField[]>()
  for (const f of fields) mine.set(f.page, [...(mine.get(f.page) ?? []), f])
  const others = new Map<number, NonNullable<View['others']>>()
  for (const o of view.others ?? []) others.set(o.page, [...(others.get(o.page) ?? []), o])
  const ready = required.length === doneCount

  return (
    <div className="pb-28">
      <div className="mx-auto max-w-[760px] px-4 pt-4">
        <h1 className="text-xl font-semibold leading-tight">{view.title}</h1>
        <p className="text-sm text-neutral-700">
          {view.recipient.name}, you are signing as {view.recipient.role}. {view.others?.length ? 'What the people before you signed is shown on the pages.' : ''}
        </p>
        {error ? (
          <p role="alert" className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}
      </div>
      <div className="mx-auto mt-4 max-w-[800px] px-2">
        <PdfPages
          url={api.documentUrl}
          onError={setError}
          overlay={(page, size) => (
            <>
              {(others.get(page) ?? []).map((o) => (
                <div key={o.id} className="pointer-events-none absolute flex items-center justify-center overflow-hidden" style={{ left: `${o.box.x * 100}%`, top: `${o.box.y * 100}%`, width: `${o.box.width * 100}%`, height: `${o.box.height * 100}%` }}>
                  {o.picture ? (
                    <img src={o.picture} alt="Signed by an earlier signer" className="h-full w-full object-contain" />
                  ) : o.type === 'checkbox' ? (
                    <span style={{ fontSize: size ? `${(o.box.height * size.h) / size.w * 100 * 0.62}cqw` : '2cqw' }}>{o.value === true ? '✓' : ''}</span>
                  ) : (
                    <span className="w-full truncate px-[2%] font-medium" style={{ fontSize: size ? `${(o.box.height * size.h) / size.w * 100 * 0.62}cqw` : '2cqw' }}>
                      {o.type === 'date' && typeof o.value === 'string' ? longDate(o.value) : String(o.value ?? '')}
                    </span>
                  )}
                </div>
              ))}
              {(mine.get(page) ?? []).map((f) => (
                <Box key={f.id} f={f} size={size} view={view} api={api} current={current === f.id} version={version} onTap={tap} />
              ))}
            </>
          )}
        />
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-neutral-300 bg-white/95 backdrop-blur" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div className="mx-auto flex max-w-[760px] items-center gap-2 px-3 py-2">
          <button type="button" className="min-h-12 rounded-lg px-3 text-sm font-medium underline" onClick={onDecline}>
            Decline
          </button>
          <p className="ml-auto text-sm font-medium" aria-live="polite">
            {required.length === 0 ? '' : ready ? 'All done' : `${doneCount} of ${required.length}`}
          </p>
          {ready ? (
            <button type="button" className={`${BTN} text-white`} style={{ backgroundColor: 'var(--accent)' }} onClick={() => setConfirm(true)}>
              Finish
            </button>
          ) : (
            <button type="button" className={`${BTN} text-white`} style={{ backgroundColor: 'var(--accent)' }} onClick={go}>
              {doneCount === 0 && !current ? 'Start' : 'Next'}
            </button>
          )}
        </div>
      </div>

      {adoptFor ? <AdoptDialog kind={adoptFor.type as AdoptionKind} typedOnly={view.typedOnly === true} onAdopt={adoptNow} onClose={() => setAdoptFor(null)} /> : null}

      <dialog ref={textDialog} onClose={() => setTextFor(null)} aria-labelledby="text-title" className="m-auto w-[min(26rem,calc(100vw-1.5rem))] rounded-xl p-0 shadow-2xl backdrop:bg-black/50">
        <form
          method="dialog"
          className="grid gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault()
            const f = textFor!
            void guard(async () => {
              const value = text.trim()
              if (value === '') throw new Error('Type something, or cancel.')
              await api.save(f.id, value)
              patch(f.id, { value, done: true })
              setTextFor(null)
            })
          }}
        >
          <h2 id="text-title" className="text-lg font-semibold">
            {textFor?.label || 'Type here'}
          </h2>
          <input className="min-h-12 rounded-md border border-neutral-400 px-3 text-base" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} autoFocus aria-label={textFor?.label || 'Your answer'} />
          <div className="flex justify-end gap-2">
            <button type="button" className={GHOST} onClick={() => setTextFor(null)}>
              Cancel
            </button>
            <button type="submit" className={`${BTN} text-white`} style={{ backgroundColor: 'var(--accent)' }}>
              Save
            </button>
          </div>
        </form>
      </dialog>

      <dialog ref={finishDialog} onClose={() => setConfirm(false)} aria-labelledby="finish-title" className="m-auto w-[min(30rem,calc(100vw-1.5rem))] rounded-xl p-0 shadow-2xl backdrop:bg-black/50">
        <div className="grid gap-3 p-4">
          <h2 id="finish-title" className="text-lg font-semibold">
            Ready to sign?
          </h2>
          <p className="text-sm">{view.intent}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={GHOST} onClick={() => setConfirm(false)}>
              Go back
            </button>
            <button type="button" disabled={busy} className={`${BTN} text-white`} style={{ backgroundColor: 'var(--accent)' }} onClick={() => void finish()}>
              {busy ? 'Signing…' : 'Finish and sign'}
            </button>
          </div>
        </div>
      </dialog>
    </div>
  )
}

export function Signer({ token }: { token: string }) {
  const api = useMemo(() => signerApi(token), [token])
  const [view, setView] = useState<View | null>(null)
  const [fatal, setFatal] = useState<{ message: string; status: number } | null>(null)
  const [declining, setDeclining] = useState(false)
  const [service, setService] = useState<ServiceWords | null>(null)
  const opened = useRef(false)

  useEffect(() => {
    void fetchService().then(setService)
  }, [])

  const load = useCallback(async () => {
    try {
      setView(await api.view())
      setFatal(null)
    } catch (e) {
      setFatal({ message: (e as Error).message, status: e instanceof ApiError ? e.status : 0 })
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  // "Opened" is recorded when this script runs, not when the link is fetched, so a mail scanner opens nobody's envelope.
  useEffect(() => {
    if (!view || opened.current || !['consent', 'sign', 'preparing'].includes(view.state)) return
    opened.current = true
    void api.open().catch(() => undefined)
  }, [view, api])

  useEffect(() => {
    if (view?.state !== 'sealing') return
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [view?.state, load])

  useEffect(() => {
    document.title = view ? `${view.title} · ${view.brand.name}` : (service?.name ?? 'Forms')
  }, [view, service])

  if (!view) {
    return fatal ? (
      <Shell brand={null} service={service}>
        <Panel title={fatal.status === 404 ? 'This link is not valid' : 'Something went wrong'}>
          <p>{fatal.message}</p>
          {fatal.status === 0 ? (
            <button type="button" className={GHOST} onClick={() => void load()}>
              Try again
            </button>
          ) : null}
        </Panel>
      </Shell>
    ) : (
      <Shell brand={null} service={service}>
        <Panel title="Opening your document">
          <p aria-live="polite">One moment…</p>
        </Panel>
      </Shell>
    )
  }

  const brand = view.brand
  const decline = (
    <DeclineDialog
      open={declining}
      onCancel={() => setDeclining(false)}
      onDecline={async (reason) => {
        await api.decline(reason).catch(() => undefined)
        setDeclining(false)
        await load()
      }}
    />
  )
  let body: ReactNode
  switch (view.state) {
    case 'consent':
      body = <Consent view={view} api={api} onView={setView} onDecline={() => setDeclining(true)} />
      break
    case 'sign':
      // A form's filler may still change an answer (src/public/Filler.tsx); everyone else just signs.
      body = <FormFiller token={token} view={view} onChanged={load} onDecline={() => setDeclining(true)} sign={<SignScreen view={view} api={api} onChanged={load} onDecline={() => setDeclining(true)} />} />
      break
    case 'preparing':
      body = <FormFiller token={token} view={view} onChanged={load} onDecline={() => setDeclining(true)} />
      break
    case 'waiting-turn':
      body = (
        <Panel title="It is not your turn yet">
          <p>{view.title} is going to the people before you first. You will get an email from {brand.name} when it is your turn to sign. There is nothing to do until then.</p>
          <Contact brand={brand} />
        </Panel>
      )
      break
    case 'waiting-others':
      body = (
        <Panel title="You will get a copy">
          <p>{view.title} is with the people who need to sign it. When everyone has, you will be emailed the finished document.</p>
          <Contact brand={brand} />
        </Panel>
      )
      break
    case 'signed':
      body = (
        <Panel title="Thank you, you have signed">
          <p>{view.title} is waiting for the others to sign. When everyone has, you will be emailed the finished document.</p>
          <Contact brand={brand} />
        </Panel>
      )
      break
    case 'sealing':
      body = (
        <Panel title="Finishing your document">
          <p aria-live="polite">Everyone has signed. The document is being sealed and will be ready in a moment. This page updates by itself.</p>
        </Panel>
      )
      break
    case 'complete':
      body = <Done view={view} api={api} />
      break
    default:
      body = (
        <Panel title={view.state === 'expired' ? 'This link has expired' : view.state === 'cancelled' ? 'This was cancelled' : 'This was declined'}>
          <p>{view.message}</p>
          <Contact brand={brand} />
        </Panel>
      )
  }
  return (
    <Shell brand={brand} service={service}>
      {body}
      {decline}
    </Shell>
  )
}
