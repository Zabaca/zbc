import { useState } from 'react'
import { type Client, type ClientInput, logoUrl } from './api'
import { Button, Field, INPUT, Notice } from './kit'
import { useInstall } from '../install'

const ZONES = ['America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago', 'America/New_York', 'America/Anchorage', 'Pacific/Honolulu']

export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

/** What a signer's email says and what the top of a client's page looks like, from the fields as typed. */
export function Preview({ name, accent, replyTo, logo }: { name: string; accent: string; replyTo: string; logo?: string | null }) {
  const { forms } = useInstall()
  const shown = name.trim() || 'Client name'
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card" aria-label="How a signer sees this client">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-border px-4 py-3 text-sm">
        <dt className="text-muted-foreground">From</dt>
        <dd className="break-words">
          {shown}
          {forms.ownCompanyOnly ? '' : ` via ${forms.service}`} &lt;{forms.sender}&gt;
        </dd>
        <dt className="text-muted-foreground">Reply-To</dt>
        <dd className="break-words">{replyTo.trim() || 'the client’s address'}</dd>
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="break-words">
          {shown} sent you Engagement letter to sign
        </dd>
      </dl>
      <div className="flex items-center gap-3 px-4 py-4 text-white" style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#1f4e79' }}>
        {logo ? <img src={logo} alt="" className="max-h-10 max-w-32 object-contain" /> : null}
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold leading-tight">{shown}</p>
          {forms.ownCompanyOnly ? null : <p className="text-xs opacity-90">via {forms.service}</p>}
        </div>
      </div>
    </div>
  )
}

/**
 * A Client's signing settings. THE NAMES ARE THE CLIENT'S, not this form's: they are shown here, read only, and changed on the Client's page in Settings (Forms keeps a copy that the Clients part writes). Setting signing up for a Client that
 * has no legal name asks for one, because a signed document names it; `onSubmit` is given what was typed, and the screen that holds the form saves it on the Client first.
 */
export function ClientForm({
  client,
  create,
  submitLabel,
  onSubmit,
}: {
  /** An existing row of signing settings. */
  client?: Client
  /** Setting signing up for a Client: its names, and its number (the screen creates the row with it). */
  create?: { name: string; legalName: string | null; number: number }
  submitLabel: string
  onSubmit: (input: ClientInput, legalName: string | null) => Promise<void>
}) {
  const shownName = client?.display_name ?? create?.name ?? ''
  const shownLegal = client?.legal_name ?? create?.legalName ?? null
  const number = client?.client_number ?? create?.number ?? null
  const needsLegal = create !== undefined && create.legalName === null
  const { forms } = useInstall()
  const [legal, setLegal] = useState('')
  const [slug, setSlug] = useState(client?.slug ?? slugOf(shownName))
  const [replyTo, setReplyTo] = useState(client?.reply_to ?? '')
  const [accent, setAccent] = useState(client?.accent_color ?? '#1f4e79')
  const [copies, setCopies] = useState((client?.copy_addresses ?? []).join('\n'))
  const [zone, setZone] = useState(client?.time_zone ?? 'America/Los_Angeles')
  const [years, setYears] = useState(String(client?.retention_years ?? 7))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const input: ClientInput = {
        reply_to: replyTo,
        accent_color: accent,
        copy_addresses: copies.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
        time_zone: zone,
        retention_years: Number(years),
      }
      if (!client) input.slug = slug
      await onSubmit(input, needsLegal ? legal.trim() : null)
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
      <form onSubmit={submit} className="grid gap-4">
        <div className="grid gap-1" data-testid="client-names">
          <p className="text-sm font-medium">Name</p>
          <p className="text-sm" data-testid="client-name">{shownName}</p>
          {shownLegal !== null ? <p className="text-sm text-muted-foreground" data-testid="client-legal-name">{shownLegal}</p> : null}
          <p className="text-xs text-muted-foreground">
            What a signer sees as the sender, the page header and the document.{' '}
            {number !== null ? (
              <a className="underline" href={`/settings/clients/${number}`} data-testid="names-in-settings">
                Change the name and legal name on the Client’s page in Settings.
              </a>
            ) : (
              'This client is not linked to a Client yet, so its name is changed after it is linked.'
            )}
          </p>
        </div>
        {needsLegal ? (
          <Field label="Legal name" htmlFor="legal" hint={`${shownName} has no legal name yet. A signed document names it, so it is asked for here and saved on the Client.`}>
            <input id="legal" className={INPUT} value={legal} onChange={(e) => setLegal(e.target.value)} required maxLength={120} autoComplete="off" data-testid="field-legal" />
          </Field>
        ) : null}
        {!client ? (
          <Field label="Short name" htmlFor="slug" hint="Lowercase letters, digits and hyphens. It cannot be changed afterwards.">
            <input
              id="slug"
              className={INPUT}
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              required
              pattern="[a-z0-9][a-z0-9\-]{1,39}"
              autoComplete="off"
            />
          </Field>
        ) : null}
        <Field label="Replies go to" htmlFor="reply" hint={`A signer who replies to a signing email reaches this address${forms.ownCompanyOnly ? '' : `, not ${forms.runBy}`}.`}>
          <input id="reply" type="email" className={INPUT} value={replyTo} onChange={(e) => setReplyTo(e.target.value)} required autoComplete="off" />
        </Field>
        <Field label="Copies of every finished document go to" htmlFor="copies" hint="One address per line. They receive each finished document like any recipient.">
          <textarea id="copies" className={`${INPUT} min-h-20 py-2`} value={copies} onChange={(e) => setCopies(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Accent color" htmlFor="accent">
            <div className="flex gap-2">
              <input aria-label="Pick a color" type="color" className="h-10 w-12 shrink-0 rounded-md border border-input bg-card p-1" value={/^#[0-9a-f]{6}$/i.test(accent) ? accent : '#1f4e79'} onChange={(e) => setAccent(e.target.value)} />
              <input id="accent" className={INPUT} value={accent} onChange={(e) => setAccent(e.target.value)} pattern="#[0-9a-fA-F]{6}" autoComplete="off" />
            </div>
          </Field>
          <Field label="Time zone" htmlFor="zone" hint="Reminders go out between 9 and 5 here.">
            <input id="zone" className={INPUT} list="zones" value={zone} onChange={(e) => setZone(e.target.value)} required autoComplete="off" />
            <datalist id="zones">
              {ZONES.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </Field>
          <Field label="Keep finished records (years)" htmlFor="years" hint="Seven unless the client's own rules say otherwise.">
            <input id="years" type="number" min={1} max={50} step={1} className={INPUT} value={years} onChange={(e) => setYears(e.target.value)} required />
          </Field>
        </div>
        {error ? <Notice kind="error">{error}</Notice> : null}
        {saved ? <Notice kind="ok">Saved.</Notice> : null}
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : submitLabel}
          </Button>
        </div>
      </form>
      <aside className="grid content-start gap-2">
        <h2 className="text-sm font-semibold">What a signer sees</h2>
        <Preview name={shownName} accent={accent} replyTo={replyTo} logo={client?.has_logo ? logoUrl(client) : null} />
        <p className="text-xs text-muted-foreground">The email's sender, reply address and subject, and the top of the client's page. A real send shows this before it goes.</p>
      </aside>
    </div>
  )
}
