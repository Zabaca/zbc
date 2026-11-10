// A client's own PDFs: upload one, see what is in it, place fields on it (the page viewer, DocumentPage.tsx), send it from the
// Envelopes screen's Send. An uploaded document is kept until it is deleted here.
import { useRef, useState } from 'react'
import type { DocumentSummary } from '@space/forms/src/documents/shared'
import { MAX_FIELD_SIGNERS } from '@space/forms/src/documents/shared'
import { Button, Card, Field, INPUT, LinkButton, Notice, bytes, useLoad, when } from './kit'
import { UploadRefused, documents } from './documents/api'
import { api } from './api'
import { go, href } from './route'

const signersWords = (s: DocumentSummary) => (s.fields_placed === 0 ? 'no fields yet' : `${s.fields_placed} field${s.fields_placed === 1 ? '' : 's'} for ${s.signers.length === 1 ? 'one signer' : `${s.signers.length} signers`}`)

type Question = { message: string; confirm: ('restrictions' | 'signatures')[]; password: boolean }

function Upload({ clientId, limits, onDone }: { clientId: string; limits: { maxBytes: number; maxPages: number } | null; onDone: (id: string) => void }) {
  const file = useRef<HTMLInputElement>(null)
  const [chosen, setChosen] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [asked, setAsked] = useState<Question | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    setChosen(f)
    setName(f ? f.name.replace(/\.pdf$/i, '') : '')
    setAsked(null)
    setConfirmed(false)
    setError(null)
    setPassword('')
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      const doc = await documents.upload({ clientId, file: chosen, name, password: password || undefined, confirm: confirmed && asked ? asked.confirm : undefined })
      if (file.current) file.current.value = ''
      setChosen(null)
      setAsked(null)
      setConfirmed(false)
      setPassword('')
      onDone(doc.id)
    } catch (err) {
      if (err instanceof UploadRefused && err.code === 'confirm') {
        setAsked({ message: err.message, confirm: err.confirm, password: false })
        setConfirmed(false)
      } else if (err instanceof UploadRefused && (err.code === 'password-needed' || err.code === 'wrong-password')) {
        setAsked({ message: err.message, confirm: [], password: true })
        setPassword('')
      } else setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const tooBig = chosen !== null && limits !== null && chosen.size > limits.maxBytes
  return (
    <Card title="Upload a PDF">
      <form onSubmit={submit} className="grid max-w-xl gap-3">
        <Field label="The PDF" htmlFor="pdf" hint={`${limits ? `Up to ${limits.maxBytes / 1048576} MB and ${limits.maxPages} pages. ` : ''}It is kept, encrypted, until you delete it here: deleting an envelope sent from it leaves the file in place.`}>
          <input ref={file} id="pdf" type="file" accept="application/pdf,.pdf" className={`${INPUT} py-2`} onChange={pick} />
        </Field>
        {tooBig ? <Notice kind="error">That file is {bytes(chosen.size)}; the most that can be signed here is {limits!.maxBytes / 1048576} MB. Ask the client for a smaller copy.</Notice> : null}
        {chosen ? (
          <Field label="Name" htmlFor="doc-name" hint="What the signer's email calls it.">
            <input id="doc-name" className={INPUT} value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} />
          </Field>
        ) : null}
        {asked?.password ? (
          <Field label="The file's password" htmlFor="pdf-password" hint="Used once to open it, and not kept.">
            <input id="pdf-password" className={INPUT} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
        ) : null}
        {asked ? <Notice kind={asked.password ? 'info' : 'warn'}>{asked.message}</Notice> : null}
        {asked && asked.confirm.length > 0 ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span className="font-medium">I confirm{asked.confirm.length === 2 ? ' both' : ''}</span>
          </label>
        ) : null}
        {error ? <Notice kind="error">{error}</Notice> : null}
        <div>
          <Button type="submit" disabled={busy || !chosen || tooBig || (asked !== null && asked.confirm.length > 0 && !confirmed)}>
            {busy ? 'Checking the file…' : 'Upload'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function Row({ doc, onChanged }: { doc: DocumentSummary; onChanged: () => Promise<void> }) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(doc.name)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function act(f: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await f()
      await onChanged()
      setRenaming(false)
      setAsking(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="grid gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        {renaming ? (
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => (e.preventDefault(), void act(() => documents.rename(doc.id, name)))}>
            <label className="sr-only" htmlFor={`rename-${doc.id}`}>
              Name
            </label>
            <input id={`rename-${doc.id}`} className={`${INPUT} max-w-64`} value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} />
            <Button type="submit" disabled={busy}>
              Save
            </Button>
            <Button type="button" kind="quiet" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <a href={href(`/documents/${doc.id}`)} className="min-w-0 text-sm font-semibold underline-offset-2 hover:underline">
            {doc.name}
          </a>
        )}
        <span className="text-xs text-muted-foreground">
          {doc.page_count} page{doc.page_count === 1 ? '' : 's'} · {bytes(doc.size)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {signersWords(doc)} · uploaded {when(doc.created_at)} · {doc.envelopes === 0 ? 'not sent yet' : `${doc.envelopes} sending${doc.envelopes === 1 ? '' : 's'}`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <LinkButton href={href(`/documents/${doc.id}`)} kind={doc.fields_placed === 0 ? 'primary' : 'quiet'}>
          {doc.fields_placed === 0 ? 'Place fields' : 'Edit fields'}
        </LinkButton>
        {doc.fields_placed > 0 ? <LinkButton href={href(`/send?client=${doc.client_id}`)}>Send it</LinkButton> : null}
        <Button kind="quiet" type="button" onClick={() => (setName(doc.name), setRenaming(true))} disabled={renaming}>
          Rename
        </Button>
        {asking ? (
          <>
            <Button type="button" onClick={() => void act(() => documents.remove(doc.id))} disabled={busy}>
              Yes, delete it
            </Button>
            <Button kind="quiet" type="button" onClick={() => setAsking(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button kind="quiet" type="button" onClick={() => setAsking(true)}>
            Delete
          </Button>
        )}
      </div>
      {asking ? <p className="text-xs text-muted-foreground">This deletes the file and the copy of it as received, for good. It cannot be deleted while a sending made from it still exists.</p> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </li>
  )
}

export function Documents() {
  const clients = useLoad(() => api.clients(), [])
  const [picked, setPicked] = useState('')
  const clientId = picked || clients.data?.[0]?.id || ''
  const list = useLoad(() => (clientId ? documents.list(clientId) : Promise.resolve(null)), [clientId])
  return (
    <>
      <h1 className="text-xl font-semibold">Documents</h1>
      {clients.data && clients.data.length === 0 ? <Notice kind="info">Add a client first: a document belongs to a client, and what is sent carries its name and logo. <a className="underline" href={href('/clients/new')}>Add a client</a></Notice> : null}
      {clients.data && clients.data.length > 0 ? (
        <>
          <label className="grid max-w-xs gap-1 text-sm font-medium">
            Client
            <select className={INPUT} value={clientId} onChange={(e) => setPicked(e.target.value)}>
              {clients.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}
                </option>
              ))}
            </select>
          </label>
          <Upload clientId={clientId} limits={list.data?.limits ?? null} onDone={(id) => go(`/documents/${id}`)} />
          {list.error ? <Notice kind="error">{list.error}</Notice> : null}
          {list.data && list.data.documents.length === 0 ? <Notice kind="info">No documents for this client yet. Upload the client's own PDF, then place a signature, initials, date, text or checkbox for each person who signs (up to {MAX_FIELD_SIGNERS}).</Notice> : null}
          {list.data && list.data.documents.length > 0 ? (
            <ul className="grid gap-2" aria-label="Documents">
              {list.data.documents.map((d) => (
                <Row key={d.id} doc={d} onChanged={list.reload} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </>
  )
}
