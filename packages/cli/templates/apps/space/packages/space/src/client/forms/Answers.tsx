// What a customer answered, for the operator: every question with its answer, a private answer hidden until it is revealed
// (which is an event on the envelope's timeline, so who looked is on the record), and the files the customer uploaded.
import { useState } from 'react'
import { MASKED } from '@space/forms/src/forms/definition'
import { type AnswersView, formsApi } from './formsApi'
import { Button, Card, Notice, bytes, useLoad } from './kit'
import { href } from './route'

/** A revealed private answer as a person would say it: a stored yes or no, a list or a number is not shown as JSON. */
function readable(type: string, raw: string): string {
  if (type === 'yesno') return raw === 'true' ? 'Yes' : raw === 'false' ? 'No' : raw
  if (type === 'multi') {
    try {
      const list: unknown = JSON.parse(raw)
      if (Array.isArray(list)) return list.join(', ')
    } catch {
      // Not JSON: show it as stored.
    }
  }
  return raw
}

export function Answers({ id }: { id: string }) {
  const data = useLoad(() => formsApi.answers(id), [id])
  const [shown, setShown] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const back = (
    <a href={href(`/envelopes/${id}`)} className="text-sm text-muted-foreground underline">
      The envelope
    </a>
  )
  if (data.error) return <Notice kind="error">{data.error}</Notice>
  if (!data.data) return <p className="text-sm text-muted-foreground">Loading…</p>
  const v: AnswersView = data.data
  if (!v.form)
    return (
      <>
        {back}
        <Notice kind="info">This envelope is not a form, so there are no answers to read.</Notice>
      </>
    )

  async function reveal(questionId: string) {
    setBusy(questionId)
    setError(null)
    try {
      const r = await formsApi.reveal(id, questionId)
      setShown((s) => ({ ...s, [questionId]: r.value }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div>
        {back}
        <h1 className="text-xl font-semibold">Answers</h1>
        <p className="text-xs text-muted-foreground">
          {v.title} · from version {v.version.number} of the form (fingerprint {v.version.hash.slice(0, 12)}…)
        </p>
      </div>
      {!v.documentReady ? <Notice kind="info">There is no document to sign right now: the customer has not made it yet, or is changing an answer. The answers below are the latest saved.</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Card title="Answers">
        <dl className="divide-y divide-border">
          {v.items.map((i) => (
            <div key={i.id} className="grid gap-1 py-2 text-sm sm:grid-cols-[16rem_1fr] sm:gap-3">
              <dt className="text-muted-foreground">{i.label}</dt>
              <dd className="min-w-0 break-words">
                {!i.answered ? (
                  <span className="text-muted-foreground">Not answered</span>
                ) : i.type === 'file' ? (
                  <span>{v.uploads.filter((u) => u.question_id === i.id).length} file(s), below</span>
                ) : i.sensitive ? (
                  shown[i.id] !== undefined ? (
                    <span>
                      <span className="font-mono">{readable(i.type, shown[i.id]!)}</span> <span className="text-xs text-muted-foreground">Showing it was recorded on the envelope's timeline.</span>
                    </span>
                  ) : (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono" aria-label="Hidden">
                        {MASKED}
                      </span>
                      <Button kind="quiet" type="button" disabled={busy === i.id} aria-label={`Reveal: ${i.label}`} onClick={() => void reveal(i.id)}>
                        {busy === i.id ? 'Revealing…' : 'Reveal'}
                      </Button>
                    </span>
                  )
                ) : (
                  i.value
                )}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">Private answers stay hidden until revealed. Each reveal is written to the timeline with who did it and when.</p>
      </Card>
      {v.uploads.length > 0 ? (
        <Card title="Uploaded files">
          <ul className="divide-y divide-border text-sm">
            {v.uploads.map((u) => (
              <li key={u.id} className="grid gap-0.5 py-2 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-3">
                <span className="min-w-0 break-words">
                  <span className="font-medium">{u.name}</span> · {bytes(u.size)} · {u.content_type}
                  <span className="block break-all text-xs text-muted-foreground">SHA-256 {u.sha256}</span>
                </span>
                <a className="text-sm underline" href={formsApi.uploadUrl(id, u.id)} download>
                  Download (recorded)
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  )
}
