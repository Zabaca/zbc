// A form as the person answering it sees it: one question per screen, with progress, back, and each answer saved as it is
// given, then a review of every answer before the document is made. Built for a phone first (large targets, one thing at a time,
// nothing that needs a hover). It knows nothing about where answers go: the filler's page saves them to the Worker
// (src/public/Filler.tsx) and the builder's preview keeps them in memory, so what the operator previews is the very screen a
// customer gets. The rules (what is shown, what is valid) are src/forms/definition.ts, the same code the Worker runs.
import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  type AnswerValue,
  type Answers,
  type FormDefinition,
  MASKED,
  type Question,
  type UploadRef,
  answerText,
  answerable,
  checkAnswer,
  isAnswered,
  isSensitive,
  missingAnswers,
  visibleQuestions,
} from '../forms/definition'

const BTN = 'inline-flex min-h-12 items-center justify-center rounded-lg px-5 text-base font-semibold disabled:opacity-50'
const GHOST = `${BTN} border border-neutral-400 bg-white text-neutral-900`
const FIELD = 'min-h-12 w-full rounded-md border border-neutral-400 bg-white px-3 text-base'

export interface RunnerProps {
  definition: FormDefinition
  /** What is already answered (resuming, or changing an answer). */
  initial: Answers
  /** Saves one answer (null clears it). Rejects with the plain reason it was refused. */
  onSave: (q: Question, value: AnswerValue | null) => Promise<void>
  /** A file for an upload question; resolves with that question's files after it. Absent: uploads are not offered. */
  onUpload?: (q: Question, file: File) => Promise<UploadRef[]>
  onRemove?: (q: Question, file: UploadRef) => Promise<UploadRef[]>
  /** The last button: makes the document. */
  onDone: () => Promise<void>
  doneLabel: string
  /** Start at the review (the answers are all given) rather than at the first question. */
  startAtReview?: boolean
  onDecline?: () => void
}

type Step = { at: 'question'; id: string } | { at: 'review' }

function Choice({ q, value, onChange }: { q: Question; value: unknown; onChange: (v: unknown) => void }) {
  if (q.type === 'dropdown')
    return (
      <select className={FIELD} aria-label={q.label} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose one</option>
        {q.options!.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    )
  const multi = q.type === 'multi'
  const picked = new Set(multi ? ((value as string[] | undefined) ?? []) : typeof value === 'string' ? [value] : [])
  return (
    <fieldset className="grid gap-2">
      <legend className="sr-only">{q.label}</legend>
      {q.options!.map((o) => (
        <label key={o} className="flex min-h-12 items-center gap-3 rounded-lg border border-neutral-300 bg-white px-3 text-base">
          <input
            type={multi ? 'checkbox' : 'radio'}
            name={q.id}
            className="h-5 w-5"
            checked={picked.has(o)}
            onChange={() => onChange(multi ? (picked.has(o) ? [...picked].filter((x) => x !== o) : [...picked, o]) : o)}
          />
          {o}
        </label>
      ))}
    </fieldset>
  )
}

function YesNo({ q, value, onChange }: { q: Question; value: unknown; onChange: (v: unknown) => void }) {
  return (
    <fieldset className="grid grid-cols-2 gap-3">
      <legend className="sr-only">{q.label}</legend>
      {[true, false].map((v) => (
        <label key={String(v)} className={`flex min-h-14 items-center justify-center gap-2 rounded-lg border-2 bg-white text-lg font-semibold ${value === v ? 'border-[var(--accent)]' : 'border-neutral-300'}`}>
          <input type="radio" name={q.id} className="sr-only" checked={value === v} onChange={() => onChange(v)} />
          {v ? 'Yes' : 'No'}
        </label>
      ))}
    </fieldset>
  )
}

function Files({ q, files, setFiles, onUpload, onRemove, fail }: { q: Question; files: UploadRef[]; setFiles: (f: UploadRef[]) => void; onUpload?: RunnerProps['onUpload']; onRemove?: RunnerProps['onRemove']; fail: (m: string | null) => void }) {
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const kinds = (q.fileKinds ?? ['pdf', 'jpeg', 'png', 'heic']).map((k) => k.toUpperCase()).join(', ')
  const most = q.max ?? 10
  return (
    <div className="grid gap-3">
      <p className="text-sm text-neutral-600">
        {kinds} files, up to 10 MB each{most === 1 ? ', one file' : `, up to ${most} files`}.
      </p>
      {files.length > 0 ? (
        <ul className="grid gap-2">
          {files.map((f) => (
            <li key={f.id} className="flex min-h-12 items-center justify-between gap-3 rounded-lg border border-neutral-300 bg-white px-3 text-sm">
              <span className="min-w-0 break-words">{f.name}</span>
              <button
                type="button"
                className="min-h-11 shrink-0 px-2 font-medium underline"
                aria-label={`Remove ${f.name}`}
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  fail(null)
                  try {
                    setFiles((await onRemove?.(q, f)) ?? files.filter((x) => x.id !== f.id))
                  } catch (e) {
                    fail((e as Error).message)
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {files.length < most ? (
        <>
          <input
            ref={input}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-label={`Choose a file for ${q.label}`}
            accept={(q.fileKinds ?? ['pdf', 'jpeg', 'png', 'heic']).map((k) => ({ pdf: 'application/pdf', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic,.heic' })[k]).join(',')}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file || !onUpload) return
              setBusy(true)
              fail(null)
              try {
                setFiles(await onUpload(q, file))
              } catch (err) {
                fail((err as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          />
          <button type="button" className={GHOST} disabled={busy || !onUpload} onClick={() => input.current?.click()}>
            {busy ? 'Uploading…' : files.length === 0 ? 'Choose a file' : 'Add another file'}
          </button>
        </>
      ) : null}
    </div>
  )
}

function QuestionScreen({ q, initial, onUpload, onRemove, onNext, onBack, nextLabel, canGoBack, progress }: { q: Question; initial: AnswerValue | undefined; onUpload?: RunnerProps['onUpload']; onRemove?: RunnerProps['onRemove']; onNext: (value: AnswerValue | null) => Promise<void>; onBack: () => void; nextLabel: string; canGoBack: boolean; progress: string }) {
  const [value, setValue] = useState<unknown>(q.type === 'number' && typeof initial === 'number' ? String(initial) : q.type === 'agreement' ? initial === true : initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [q.id])
  const files = (Array.isArray(value) ? value : []) as UploadRef[]

  async function next() {
    setError(null)
    let out: AnswerValue | null = null
    if (q.type === 'statement') {
      // Nothing to answer.
    } else if (q.type === 'file') {
      if (q.required && files.length === 0) return setError('Upload a file to continue.')
    } else if (q.type === 'agreement') {
      if (value !== true) return setError('Check the box to agree and continue.')
      out = true
    } else if (!isAnswered(q, value as AnswerValue | undefined)) {
      if (q.required) return setError('This question needs an answer.')
    } else {
      const checked = checkAnswer(q, value)
      if (!checked.ok) return setError(checked.reason)
      out = checked.value
    }
    setBusy(true)
    try {
      if (q.type !== 'statement' && q.type !== 'file') await onNext(out)
      else await onNext(null)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
      return
    }
    setBusy(false)
  }

  const text = (props: { type?: string; inputMode?: 'numeric' | 'decimal' | 'tel' | 'email' | 'text'; autoComplete?: string; maxLength?: number }) => (
    <input className={FIELD} aria-label={q.label} placeholder={q.placeholder} value={typeof value === 'string' ? value : ''} onChange={(e) => setValue(e.target.value)} {...props} />
  )
  let input: ReactNode
  switch (q.type) {
    case 'short':
      input = text({ type: 'text', maxLength: q.max ?? 200 })
      break
    case 'email':
      input = text({ type: 'email', inputMode: 'email', autoComplete: 'email' })
      break
    case 'phone':
      input = text({ type: 'tel', inputMode: 'tel', autoComplete: 'tel' })
      break
    case 'number':
      input = text({ type: 'text', inputMode: 'decimal' })
      break
    case 'tin':
      input = text({ type: 'text', inputMode: 'numeric', autoComplete: 'off', maxLength: 11 })
      break
    case 'long':
      input = <textarea className={`${FIELD} min-h-36 py-2`} aria-label={q.label} placeholder={q.placeholder} value={typeof value === 'string' ? value : ''} maxLength={q.max ?? 5000} onChange={(e) => setValue(e.target.value)} />
      break
    case 'date':
      input = <input className={FIELD} type="date" aria-label={q.label} value={typeof value === 'string' ? value : ''} onChange={(e) => setValue(e.target.value)} />
      break
    case 'choice':
    case 'multi':
    case 'dropdown':
      input = <Choice q={q} value={value} onChange={setValue} />
      break
    case 'yesno':
      input = <YesNo q={q} value={value} onChange={setValue} />
      break
    case 'file':
      input = <Files q={q} files={files} setFiles={setValue} onUpload={onUpload} onRemove={onRemove} fail={setError} />
      break
    case 'agreement':
      input = (
        <div className="grid gap-3">
          <div className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-neutral-300 bg-white p-3 text-sm leading-relaxed" tabIndex={0} role="region" aria-label={q.label || 'Agreement'}>
            {q.text}
          </div>
          <label className="flex min-h-12 items-center gap-3 rounded-lg border border-neutral-300 bg-white px-3 text-base font-medium">
            <input type="checkbox" className="h-5 w-5" checked={value === true} onChange={(e) => setValue(e.target.checked)} />I agree
          </label>
        </div>
      )
      break
    case 'statement':
      input = <p className="whitespace-pre-wrap rounded-lg bg-white p-4 text-base leading-relaxed shadow-sm">{q.text}</p>
      break
  }
  const showLabel = q.type !== 'statement'
  return (
    <section className="grid gap-4" aria-labelledby="q-label">
      <p className="text-sm text-neutral-600" aria-live="polite">
        {progress}
      </p>
      <h1 id="q-label" ref={heading} tabIndex={-1} className="text-2xl font-semibold leading-tight outline-none">
        {showLabel ? q.label || (q.type === 'agreement' ? 'Agreement' : '') : 'Please read'}
        {showLabel && !q.required && q.type !== 'agreement' ? <span className="ml-2 text-sm font-normal text-neutral-600">(optional)</span> : null}
      </h1>
      {q.help ? <p className="whitespace-pre-wrap text-sm text-neutral-700">{q.help}</p> : null}
      {isSensitive(q) ? <p className="text-sm text-neutral-700">This is private. It is stored encrypted and shown only to the business when it is needed.</p> : null}
      {input}
      {error ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canGoBack ? (
          <button type="button" className={GHOST} onClick={onBack} disabled={busy}>
            Back
          </button>
        ) : null}
        <button type="button" className={`${BTN} text-white`} style={{ backgroundColor: 'var(--accent)' }} disabled={busy} onClick={() => void next()}>
          {busy ? 'Saving…' : nextLabel}
        </button>
      </div>
    </section>
  )
}

export function FormRunner(p: RunnerProps) {
  const [answers, setAnswers] = useState<Answers>(p.initial)
  const start = (): Step => {
    const shown = visibleQuestions(p.definition, p.initial)
    if (p.startAtReview && missingAnswers(p.definition, p.initial).length === 0) return { at: 'review' }
    // A new start begins at the first question. Resuming lands on the first question still waiting for an answer, or the
    // review when there is none.
    if (Object.keys(p.initial).length === 0) return shown[0] ? { at: 'question', id: shown[0].id } : { at: 'review' }
    const open = shown.find((q) => q.type !== 'statement' && q.required && !isAnswered(q, p.initial[q.id]))
    return open ? { at: 'question', id: open.id } : { at: 'review' }
  }
  const [step, setStep] = useState<Step>(start)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const visible = visibleQuestions(p.definition, answers)
  const at = step.at === 'question' ? visible.findIndex((q) => q.id === step.id) : visible.length
  // The question on screen stopped being shown (an earlier answer changed it): move on to the next one that is.
  useEffect(() => {
    if (step.at === 'question' && at === -1) setStep(visible[0] ? { at: 'question', id: visible[0].id } : { at: 'review' })
  }, [step, at, visible])

  const advance = (from: number, list: Question[]) => setStep(list[from + 1] ? { at: 'question', id: list[from + 1]!.id } : { at: 'review' })

  if (step.at === 'question' && at >= 0) {
    const q = visible[at]!
    const save = async (value: AnswerValue | null) => {
      // Stepping through an answer that did not change saves nothing (a change to a made document withdraws it).
      const same = JSON.stringify(value ?? null) === JSON.stringify(answers[q.id] ?? null)
      if (q.type !== 'statement' && q.type !== 'file' && !same) await p.onSave(q, value)
      const next = { ...answers }
      if (value === null) {
        if (q.type !== 'file') delete next[q.id]
      } else next[q.id] = value
      setAnswers(next)
      const after = visibleQuestions(p.definition, next)
      const index = after.findIndex((x) => x.id === q.id)
      advance(index, after)
    }
    return (
      <QuestionScreen
        key={q.id}
        q={q}
        initial={answers[q.id]}
        onUpload={
          p.onUpload &&
          (async (qq, file) => {
            const files = await p.onUpload!(qq, file)
            setAnswers((a) => ({ ...a, [qq.id]: files }))
            return files
          })
        }
        onRemove={
          p.onRemove &&
          (async (qq, file) => {
            const files = await p.onRemove!(qq, file)
            setAnswers((a) => {
              const n = { ...a }
              if (files.length === 0) delete n[qq.id]
              else n[qq.id] = files
              return n
            })
            return files
          })
        }
        onNext={save}
        onBack={() => (at > 0 ? setStep({ at: 'question', id: visible[at - 1]!.id }) : undefined)}
        canGoBack={at > 0}
        nextLabel={at === visible.length - 1 ? 'Review' : 'Next'}
        progress={`${at + 1} of ${visible.length}`}
      />
    )
  }

  const missing = missingAnswers(p.definition, answers)
  return (
    <section className="grid gap-4" aria-labelledby="review-h">
      <h1 id="review-h" className="text-2xl font-semibold leading-tight">
        Check your answers
      </h1>
      <p className="text-sm text-neutral-700">Your document is made from these answers and the agreement text. You can change any of them now, and again after you see the document.</p>
      <dl className="grid gap-px overflow-hidden rounded-xl border border-neutral-300 bg-neutral-300">
        {visible.filter(answerable).map((q) => {
          const v = answers[q.id]
          const given = isAnswered(q, v)
          return (
            <div key={q.id} className="grid gap-1 bg-white p-3 sm:grid-cols-[1fr_auto] sm:items-start sm:gap-4">
              <div className="min-w-0">
                <dt className="text-sm text-neutral-600">{q.label || 'Agreement'}</dt>
                <dd className="break-words text-base font-medium">{!given ? <span className="font-normal text-neutral-500">{q.required ? 'Not answered yet' : 'No answer'}</span> : isSensitive(q) ? MASKED : q.type === 'agreement' ? 'I agree' : answerText(q, v)}</dd>
              </div>
              <button type="button" className="min-h-11 justify-self-start px-1 text-sm font-medium underline" aria-label={`Change: ${q.label || 'Agreement'}`} onClick={() => setStep({ at: 'question', id: q.id })}>
                {given ? 'Change' : 'Answer'}
              </button>
            </div>
          )
        })}
      </dl>
      {missing.length > 0 ? (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
          {missing.length === 1 ? 'One question still needs an answer.' : `${missing.length} questions still need an answer.`}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {visible.length > 0 ? (
          <button type="button" className={GHOST} onClick={() => setStep({ at: 'question', id: visible[visible.length - 1]!.id })}>
            Back
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy || missing.length > 0}
          className={`${BTN} text-white`}
          style={{ backgroundColor: 'var(--accent)' }}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              await p.onDone()
            } catch (e) {
              setError((e as Error).message)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Making your document…' : p.doneLabel}
        </button>
        {p.onDecline ? (
          <button type="button" className="min-h-12 px-3 text-sm font-medium underline" onClick={p.onDecline}>
            Decline
          </button>
        ) : null}
      </div>
    </section>
  )
}
