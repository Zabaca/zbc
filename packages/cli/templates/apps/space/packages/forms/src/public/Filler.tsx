// The filler's side of the signer's page. The first signer of a form envelope answers its questions here before there is a
// document to sign: Signer.tsx hands this component the `preparing` state, and the `sign` state too, so a filler who has seen their
// document can still change an answer (which makes it again) until they have signed. Everyone else's link passes straight through.
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import type { AnswerValue, Answers, FormDefinition, Question, UploadRef } from '../forms/definition'
import { SIGNER_API } from '../paths'
import { ApiError, type View } from './api'
import { FormRunner } from './FormRunner'

type FormInfo = { filler: false } | { filler: true; canEdit: boolean; definition: FormDefinition; answers: Answers; limits: { fileBytes: number; filesPerEnvelope: number } }

/** The filler's calls under the same private link as the rest of the page: the token is the only credential, and no cookie is set. */
function fillerApi(token: string) {
  const base = `${SIGNER_API}/s/${token}`
  async function call<T>(method: string, path: string, body?: unknown, raw?: { file: File }): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: raw ? { 'x-file-name': encodeURIComponent(raw.file.name) } : body === undefined ? undefined : { 'content-type': 'application/json' },
        body: raw ? raw.file : body === undefined ? undefined : JSON.stringify(body),
        referrerPolicy: 'no-referrer',
        credentials: 'omit',
      })
    } catch {
      throw new ApiError('The connection was lost. Check your signal and try again.', 0)
    }
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      // Not JSON.
    }
    if (!res.ok) throw new ApiError((parsed as { error?: string } | null)?.error ?? `Something went wrong (${res.status})`, res.status)
    return parsed as T
  }
  return {
    form: () => call<FormInfo>('GET', '/form'),
    save: (q: Question, value: AnswerValue | null) => call<{ ok: true }>('PUT', `/answers/${q.id}`, { value }),
    upload: async (q: Question, file: File) => (await call<{ files: UploadRef[] }>('POST', `/uploads/${q.id}`, undefined, { file })).files,
    remove: (id: string) => call<{ ok: true }>('DELETE', `/uploads/${id}`),
    prepare: () => call<{ pages: number; sensitive: boolean }>('POST', '/prepare', {}),
  }
}

function Page({ children }: { children: ReactNode }) {
  return <main className="mx-auto grid max-w-[760px] gap-4 px-4 py-6">{children}</main>
}

export function FormFiller({ token, view, onChanged, onDecline, sign }: { token: string; view: View; onChanged: () => Promise<void>; onDecline: () => void; sign?: ReactNode }) {
  const api = useMemo(() => fillerApi(token), [token])
  const [info, setInfo] = useState<FormInfo | null>(null)
  const [editing, setEditing] = useState(false)
  const [run, setRun] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setInfo(await api.form())
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [api])
  // Only a form's link has questions: a document's signer is never asked.
  useEffect(() => {
    if (view.kind === 'form') void load()
  }, [load, view.kind])

  // Files are the only thing that needs the whole list back after a change, so each one's call resolves with its question's files.
  const remove = useCallback(
    async (q: Question, file: UploadRef) => {
      await api.remove(file.id)
      const now = await api.form()
      return now.filler ? ((now.answers[q.id] as UploadRef[] | undefined) ?? []) : []
    },
    [api],
  )

  const preparing = view.state === 'preparing'
  if (!preparing && !editing) {
    // The document exists. A filler who has not signed may change an answer; anyone else just signs.
    return (
      <>
        {info?.filler && info.canEdit ? (
          <div className="mx-auto flex max-w-[760px] flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 text-sm">
            <span>Your answers are in the document below. Something wrong?</span>
            <button
              type="button"
              className="min-h-11 font-semibold underline"
              onClick={async () => {
                await load()
                setRun((n) => n + 1)
                setEditing(true)
              }}
            >
              Change an answer
            </button>
          </div>
        ) : null}
        {sign}
      </>
    )
  }

  if (error && !info) {
    return (
      <Page>
        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p role="alert">{error}</p>
        <button type="button" className="min-h-12 rounded-lg border border-neutral-400 bg-white px-5 font-semibold" onClick={() => void load()}>
          Try again
        </button>
      </Page>
    )
  }
  if (!info) {
    return (
      <Page>
        <p aria-live="polite">One moment…</p>
      </Page>
    )
  }
  if (!info.filler) {
    return (
      <Page>
        <h1 className="text-2xl font-semibold">Your document is not ready yet</h1>
        <p>It is being prepared. Reload this page in a moment.</p>
        <p className="text-sm text-neutral-700">
          Questions? Contact {view.brand.name} at <a className="underline" href={`mailto:${view.brand.replyTo}`}>{view.brand.replyTo}</a>.
        </p>
      </Page>
    )
  }
  return (
    <Page>
      {!info.canEdit ? <p role="alert">The answers can no longer be changed.</p> : null}
      <FormRunner
        // Each time the filler starts changing answers, the run starts afresh from what is saved.
        key={run}
        definition={info.definition}
        initial={info.answers}
        startAtReview={editing}
        onSave={async (q, value) => void (await api.save(q, value))}
        onUpload={(q, file) => api.upload(q, file)}
        onRemove={remove}
        onDecline={onDecline}
        doneLabel={editing ? 'Make my document again' : 'See my document'}
        onDone={async () => {
          await api.prepare()
          setEditing(false)
          await load()
          await onChanged()
        }}
      />
    </Page>
  )
}
