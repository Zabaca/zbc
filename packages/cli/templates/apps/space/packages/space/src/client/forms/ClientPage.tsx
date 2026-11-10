import { useState } from 'react'
import { useInstall } from '../install'
import { useFresh } from '../liveHub'
import { type Client, api, logoUrl } from './api'
import { ClientForm } from './ClientForm'
import { LinkClient } from './Clients'
import { Badge, Card, LinkButton, Notice, bytes, useLoad, when } from './kit'
import { href } from './route'
import { MAX_LOGO_BYTES } from '@space/forms/src/settings'

function Logo({ client, onChanged }: { client: Client; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    if (file.size > MAX_LOGO_BYTES) return setError(`That file is ${bytes(file.size)}; a logo may be at most ${MAX_LOGO_BYTES / 1024} KB, because every email loads it.`)
    setBusy(true)
    try {
      await api.uploadLogo(client.id, file)
      await onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Logo">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-20 w-40 items-center justify-center rounded-md border border-border bg-muted p-2">
          {client.has_logo ? <img src={logoUrl(client)} alt={`${client.display_name} logo`} className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-muted-foreground">No logo yet</span>}
        </div>
        <div className="grid gap-1">
          <label className="inline-flex min-h-10 cursor-pointer items-center justify-center rounded-md border border-input bg-card px-4 text-sm font-medium hover:bg-accent focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring">
            {busy ? 'Uploading…' : client.has_logo ? 'Replace the logo' : 'Upload a logo'}
            <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={pick} disabled={busy} />
          </label>
          <p className="text-xs text-muted-foreground">A PNG or a JPEG, up to {MAX_LOGO_BYTES / 1024} KB. It shows in the client's emails and at the top of its page.</p>
        </div>
      </div>
      {error ? (
        <div className="mt-3">
          <Notice kind="error">{error}</Notice>
        </div>
      ) : null}
    </Card>
  )
}

function Sample({ client }: { client: Client }) {
  const { forms } = useInstall()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function download() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(api.sampleUrl(client.id))
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `The sample could not be made (${res.status})`)
      }
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = `${client.slug}-sealed-sample.pdf`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="A sealed sample">
      <p className="mb-3 text-sm">
        A one-page letter in this client's name, colors and logo, with a mock signature, a page that says what the certificate of completion will carry, an attached event log, and the seal over all of it. Open it in Adobe Reader: the signature panel should say the document has not been modified since it was sealed, and that the signer's validity is unknown (the seal's root is {forms.runBy}'s own, not on Adobe's list).
      </p>
      <button type="button" onClick={download} disabled={busy} className="inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hi disabled:opacity-50">
        {busy ? 'Sealing…' : 'Download the sealed sample'}
      </button>
      {error ? (
        <div className="mt-3">
          <Notice kind="error">{error}</Notice>
        </div>
      ) : null}
    </Card>
  )
}

const LABEL: Record<string, string> = {
  client_number: 'the Client it belongs to',
  display_name: 'the display name',
  legal_name: 'the legal name',
  accent_color: 'the accent color',
  reply_to: 'the reply address',
  copy_addresses: 'the copy addresses',
  time_zone: 'the time zone',
  retention_years: 'how long records are kept',
  logo_key: 'the logo',
  logo_type: 'the logo',
  logo_sha256: 'the logo',
}

/** What differs between two versions of a client, in the words a screen uses (the logo's three columns read as one thing). */
function differences(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  const keys = Object.keys(after ?? {}).filter((k) => k !== 'updated_at' && JSON.stringify(after?.[k]) !== JSON.stringify(before?.[k]))
  return [...new Set(keys.map((k) => LABEL[k] ?? k))].join(', ') || 'it'
}

function Changes({ id }: { id: string }) {
  const { data } = useLoad(() => api.audit(id), [id])
  if (!data || data.length === 0) return null
  return (
    <Card title="Changes">
      <ul className="divide-y divide-border text-sm">
        {data.map((a) => (
          <li key={a.id} className="flex flex-wrap gap-x-3 py-2">
            <span className="text-muted-foreground">{when(a.at)}</span>
            <span>
              {a.actor}{' '}
              {a.action === 'create'
                ? 'added this client'
                : a.action === 'link'
                  ? 'linked this client to a Client'
                  : a.action === 'client-names'
                    ? `put right the names (${differences(a.before, a.after)}) to follow the Client`
                    : `changed ${differences(a.before, a.after)}`}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function RecentEnvelopes({ id }: { id: string }) {
  const { data, reload } = useLoad(() => api.envelopes({ client: id }), [id])
  useFresh(['documents'], () => void reload())
  if (!data || data.length === 0) return null
  return (
    <Card title="Envelopes" aside={<a className="text-sm underline" href={href(`/envelopes?client=${id}`)}>All</a>}>
      <ul className="divide-y divide-border text-sm">
        {data.slice(0, 5).map((e) => (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <a className="min-w-0 truncate underline" href={href(`/envelopes/${e.id}`)}>{e.title}</a>
            <Badge status={e.status} />
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** A client made before the Clients part existed: it signs as it did, and is linked by hand to a Client picked from those without signing settings, or a Client is made from its names. */
function NotLinked({ client, onDone }: { client: Client; onDone: () => Promise<void> }) {
  const open = useLoad(() => api.clientsNotSetUp(), [client.id])
  return (
    <section className="rounded-lg border border-warn/40 bg-warn-bg p-4" data-testid="not-linked">
      <h2 className="text-base font-semibold">Not linked to a Client</h2>
      <p className="text-sm">This client was made before Clients were one list, so it has no Client in Settings. It signs exactly as it did. Link it to its Client to change its name there and have it in Send’s list under the Client’s name.</p>
      {open.data && !open.data.available ? <Notice kind="warn">The list of Clients could not be read just now, so it cannot be linked. Try again in a moment.</Notice> : null}
      <LinkClient row={client} options={open.data?.clients ?? []} onDone={() => void onDone()} />
    </section>
  )
}

export function ClientPage({ id }: { id: string }) {
  const { data: client, error, reload } = useLoad(() => api.client(id), [id])
  useFresh(['clients'], () => void reload())
  if (error) return <Notice kind="error">{error}</Notice>
  if (!client) return <p className="text-sm text-muted-foreground">Loading…</p>
  return (
    <>
      <div>
        <a href={href('/')} className="text-sm text-muted-foreground underline">
          Clients
        </a>
        <h1 className="text-xl font-semibold">{client.display_name}</h1>
        <p className="text-xs text-muted-foreground">
          {client.slug} · added {when(client.created_at)}
        </p>
      </div>
      {client.client_number === null ? <NotLinked client={client} onDone={reload} /> : null}
      {client.client_archived === true ? (
        <Notice kind="info">
          This Client is archived in Settings, so Send does not offer it. Documents already out for signature go on. <a className="underline" href={`/settings/clients/${client.client_number}`}>Open it in Settings</a>
        </Notice>
      ) : null}
      <Card title="Signing settings">
        <ClientForm
          client={client}
          submitLabel="Save changes"
          onSubmit={async (input) => {
            await api.updateClient(client.id, input)
            await reload()
          }}
        />
      </Card>
      <Logo client={client} onChanged={reload} />
      <Card title="Send">
        <p className="mb-3 text-sm">Send the built-in sample in {client.display_name}'s name to yourself and a second address, in order, to see the links, the consent, the signing and the finished document.</p>
        <LinkButton href={href(`/send?client=${client.id}`)} kind="primary">
          Send the sample
        </LinkButton>
      </Card>
      <RecentEnvelopes id={client.id} />
      <Sample client={client} />
      <Changes key={`${client.updated_at}`} id={client.id} />
    </>
  )
}
