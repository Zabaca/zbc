// Forms' Clients section: the SAME list of Clients as Settings, joined with each one's signing settings. A Client with signing set up shows its logo, colour and reply address;
// one without shows Set up signing. A Client's name and legal name are the Client's own and are changed on its page in Settings. A Forms client made before the Clients part existed is listed apart as "not linked to a Client", with Link
// (to a Client picked here) and Make a Client (from its names): nothing is matched by name, and until it is linked it signs exactly as it did.
import { useState } from 'react'
import type { Client as SpaceClient } from '@space/workspace'
import { useFresh } from '../liveHub'
import { settingsItemPath } from '../route'
import { postView } from '../views'
import { type Client, type UnsetClient, api, logoUrl } from './api'
import { Button, LinkButton, Notice, useLoad } from './kit'
import { href } from './route'

/** Where a new Client is made: Settings, which then comes back here to set up signing (`then=signing`, read by Settings' New Client). */
export const ADD_A_CLIENT = `${settingsItemPath('clients', 'new')}?then=signing`

/** The way into Set up signing for a Client. */
export const setUpPath = (number: number): string => `/clients/new?client=${number}`

function Avatar({ c }: { c: Client }) {
  return (
    <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md text-lg font-semibold text-white" style={{ backgroundColor: c.accent_color }} aria-hidden="true">
      {c.has_logo ? <img src={logoUrl(c)} alt="" className="size-full object-contain" /> : c.display_name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** One Client with signing set up: its logo, colour and where replies go, opening its signing settings. */
function SetUp({ c }: { c: Client }) {
  return (
    <li data-testid="forms-client" data-number={c.client_number ?? ''}>
      <a href={href(`/clients/${c.id}`)} className="flex min-h-16 items-center gap-3 rounded-lg border border-border bg-card p-3 hover:bg-accent">
        <Avatar c={c} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{c.display_name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            replies to {c.reply_to} · kept {c.retention_years} years
          </span>
        </span>
      </a>
    </li>
  )
}

/** One active Client with no signing settings: its names (the Client's own) and Set up signing. */
function NotSetUp({ c }: { c: UnsetClient }) {
  return (
    <li data-testid="forms-client-not-set-up" data-number={c.number}>
      <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-card p-3">
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{c.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{c.legalName ?? 'No legal name yet'} · signing is not set up</span>
        </span>
        <LinkButton href={href(setUpPath(c.number))} kind="primary">
          Set up signing
        </LinkButton>
      </div>
    </li>
  )
}

/** Link a Forms client that has no Client to one picked from those without signing settings, or make a Client from its names and link that. */
export function LinkClient({ row, options, onDone }: { row: Client; options: UnsetClient[]; onDone: () => void }) {
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = options.find((o) => String(o.number) === pick)

  async function link() {
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      await api.linkClient(row.id, chosen.number)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function make() {
    setBusy(true)
    setError(null)
    // Two writes, the Client in the space's store and the link in Forms': if the second fails the Client exists and the sentence says so.
    const made = await postView<SpaceClient>('clients/make', { name: row.display_name, legalName: row.legal_name })
    if (!made.ok) {
      setError(made.say.text)
      setBusy(false)
      return
    }
    try {
      await api.linkClient(row.id, made.value.number)
      onDone()
    } catch (e) {
      setError(`${made.value.name} was made as a Client (number ${made.value.number}) but this client could not be linked to it: ${(e as Error).message} Link it from the list below.`)
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 grid gap-2" data-testid="link-client">
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-48 flex-1 gap-1 text-sm">
          <span className="font-medium">Link to a Client</span>
          <select className="min-h-10 w-full rounded-md border border-input bg-card px-3 text-sm" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy || options.length === 0} data-testid="link-pick">
            <option value="">{options.length === 0 ? 'Every Client has signing set up' : 'Choose a Client'}</option>
            {options.map((o) => (
              <option key={o.number} value={o.number}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" disabled={busy || !chosen} onClick={() => void link()} data-testid="link-button">
          Link
        </Button>
        <Button type="button" kind="quiet" disabled={busy} onClick={() => void make()} data-testid="make-client-button">
          Make a Client
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {chosen ? `Signers will see “${chosen.name}” from now on. ` : ''}
        Make a Client adds “{row.display_name}” to the Clients in Settings and links this to it. Nothing about the documents already sent changes.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
    </div>
  )
}

function Unlinked({ rows, options, onDone }: { rows: Client[]; options: UnsetClient[]; onDone: () => void }) {
  return (
    <section aria-label="Not linked to a Client" className="grid grid-cols-1 gap-2" data-testid="forms-unlinked">
      <h2 className="text-base font-semibold">Not linked to a Client</h2>
      <p className="text-sm text-muted-foreground">These were made before Clients were one list. They keep signing exactly as they did. Link each to its Client, or make one from its names.</p>
      <ul className="grid grid-cols-1 gap-2" aria-label="Not linked to a Client">
        {rows.map((c) => (
          <li key={c.id} className="rounded-lg border border-border bg-card p-3" data-testid="forms-client-unlinked" data-id={c.id}>
            <a href={href(`/clients/${c.id}`)} className="flex min-h-12 items-center gap-3 hover:underline">
              <Avatar c={c} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{c.display_name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {c.legal_name} · replies to {c.reply_to}
                </span>
              </span>
            </a>
            <LinkClient row={c} options={options} onDone={onDone} />
          </li>
        ))}
      </ul>
    </section>
  )
}

export function Clients() {
  const rows = useLoad(() => api.clients(), [])
  const open = useLoad(() => api.clientsNotSetUp(), [])
  const reload = () => {
    void rows.reload()
    void open.reload()
  }
  // The Clients part tells the page when a Client is made, renamed, archived or sent in.
  useFresh(['clients'], reload)
  const error = rows.error ?? open.error
  const linked = (rows.data ?? []).filter((c) => c.client_number !== null && c.client_archived !== true)
  const unlinked = (rows.data ?? []).filter((c) => c.client_number === null)
  const notSetUp = open.data?.clients ?? []
  const nothing = rows.data !== null && open.data !== null && linked.length === 0 && unlinked.length === 0 && notSetUp.length === 0
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Clients</h1>
        <LinkButton href={ADD_A_CLIENT} kind="primary">
          Add a client
        </LinkButton>
      </div>
      <p className="text-sm text-muted-foreground">
        The same Clients as Settings. A Client’s name and legal name are changed on its page there; what a signer sees (logo, colour, where replies go) is set up here.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {(rows.loading && !rows.data) || (open.loading && !open.data) ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {open.data && !open.data.available ? <Notice kind="warn">The list of Clients could not be read just now, so only the clients that already have signing settings are shown.</Notice> : null}
      {nothing ? (
        <Notice kind="info">
          No Clients yet. A Client is a business whose name and logo a document carries. Add one, then set up signing for it and download its sealed sample from its page to see what a finished document looks like.
        </Notice>
      ) : null}
      {linked.length > 0 ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Clients" data-testid="forms-clients">
          {linked.map((c) => (
            <SetUp key={c.id} c={c} />
          ))}
        </ul>
      ) : null}
      {notSetUp.length > 0 ? (
        <section aria-label="Clients without signing" className="grid grid-cols-1 gap-2" data-testid="forms-clients-not-set-up">
          <h2 className="text-base font-semibold">Without signing</h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Clients without signing">
            {notSetUp.map((c) => (
              <NotSetUp key={c.number} c={c} />
            ))}
          </ul>
        </section>
      ) : null}
      {unlinked.length > 0 ? <Unlinked rows={unlinked} options={notSetUp} onDone={reload} /> : null}
    </>
  )
}
