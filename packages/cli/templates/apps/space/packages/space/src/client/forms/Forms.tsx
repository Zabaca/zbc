import { useState } from 'react'
import { api } from './api'
import { FormBuilder } from './FormBuilder'
import { formsApi } from './formsApi'
import { Button, Card, Field, INPUT, Notice, useLoad, when } from './kit'
import { go, href } from './route'

/** A client's forms: the list, a way to start one, and (with an id) the builder. */
export function Forms({ id }: { id?: string }) {
  return id ? <FormBuilder id={id} /> : <FormList />
}

function FormList() {
  const forms = useLoad(() => formsApi.forms(), [])
  const clients = useLoad(() => api.clients(), [])
  const [clientId, setClientId] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = clientId || clients.data?.[0]?.id || ''

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const made = await formsApi.createForm(chosen, title.trim())
      go(`/forms/${made.form.id}`)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Forms</h1>
        <p className="text-sm text-muted-foreground">Questions a client's customer answers before signing. What they answer, and the agreement text, become the document everyone signs.</p>
      </div>
      {forms.error ? <Notice kind="error">{forms.error}</Notice> : null}
      <Card title="New form">
        {clients.data && clients.data.length === 0 ? (
          <Notice kind="info">
            Add a client first: a form carries its name and logo. <a className="underline" href={href('/clients/new')}>Add a client</a>
          </Notice>
        ) : (
          <form onSubmit={create} className="grid max-w-xl gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Client" htmlFor="client">
              <select id="client" className={INPUT} value={chosen} onChange={(e) => setClientId(e.target.value)} required>
                {(clients.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Title" htmlFor="title">
              <input id="title" className={INPUT} required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New client intake" />
            </Field>
            <Button type="submit" disabled={busy || !chosen || title.trim() === ''}>
              {busy ? 'Creating…' : 'Build it'}
            </Button>
            {error ? (
              <div className="sm:col-span-3">
                <Notice kind="error">{error}</Notice>
              </div>
            ) : null}
          </form>
        )}
      </Card>
      <Card title="Every form">
        {forms.data && forms.data.length === 0 ? <p className="text-sm text-muted-foreground">No forms yet.</p> : null}
        <ul className="divide-y divide-border">
          {(forms.data ?? []).map((f) => (
            <li key={f.id} className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-w-0">
                <a className="font-medium underline" href={href(`/forms/${f.id}`)}>
                  {f.title}
                </a>
                <span className="text-muted-foreground"> · {f.client_name}</span>
                <p className="text-xs text-muted-foreground">
                  {f.published ? `Version ${f.published.version} published ${when(f.published.published_at)}: ${f.published.questions} questions, signers ${f.published.roles.join(', then ')}${f.published.sensitive ? ', asks for private information' : ''}.` : 'Not published yet, so it cannot be sent.'}
                  {f.draft ? ` A draft of version ${f.draft.version} is in progress.` : ''}
                </p>
              </div>
              {f.published ? (
                <a className="text-sm underline" href={href(`/send?client=${f.client_id}`)}>
                  Send it
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </>
  )
}
