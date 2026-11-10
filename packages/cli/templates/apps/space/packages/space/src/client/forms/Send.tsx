import { useEffect, useState } from 'react'
import { read } from '../api'
import { inboxPath, meetPath } from '../route'
import type { SigningFrom } from '../../conversation'
import { type RecipientInput, api } from './api'
import { type PickerValue, SEND_SOURCES } from './sendSources'
import { Button, Card, Field, INPUT, Notice, useLoad } from './kit'
import { SendWarning } from './SendWarning'
import { go, href } from './route'

const blank = (n: number): RecipientInput => ({ role: n === 1 ? 'Client' : n === 2 ? 'CPA' : `Signer ${n}`, name: '', email: '' })

/**
 * What Send knows of the conversation it was opened from (`?from=<the conversation's key>`): who it is with, to fill the signers, and the conversation the
 * document will carry. Null when it was opened from Forms. A conversation that could not be read is an error to say, never a silent send with no link.
 */
async function fromConversation(key: string | null): Promise<SigningFrom | null> {
  if (key === null || key === '') return null
  const got = await read<SigningFrom>(`/api/conversation/signers?key=${encodeURIComponent(key)}`)
  if (got.ok) return got.value
  if (got.problem === 'signin') throw new Error('Your sign-in has ended. Reload the page to sign in again.')
  throw new Error(got.message ?? 'The conversation could not be read just now, so its people are not filled in.')
}

/** Name the people and the schedule; the next screen shows the email before anything is sent. */
export function Send({ client: preset, from }: { client: string | null; from: string | null }) {
  const clients = useLoad(() => api.clients(), [])
  const [clientId, setClientId] = useState(preset ?? '')
  const [source, setSource] = useState(SEND_SOURCES[0]!.type)
  const [pick, setPick] = useState<PickerValue>({})
  const [sensitive, setSensitive] = useState(false)
  const [typedOnly, setTypedOnly] = useState(false)
  const [people, setPeople] = useState<RecipientInput[]>([blank(1), blank(2)])
  const [order, setOrder] = useState<'sequential' | 'parallel'>('sequential')
  const [note, setNote] = useState('')
  const [days, setDays] = useState(30)
  const [every, setEvery] = useState(3)
  const [max, setMax] = useState(3)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Opened from a conversation: its person is the first signer, and what is sent carries the conversation.
  const conversation = useLoad(() => fromConversation(from), [from])
  const origin = conversation.data ?? null
  useEffect(() => {
    const person = origin?.people[0]
    // Only while the signer boxes are still empty: the conversation may be read after someone has begun to type, and what they typed is theirs.
    if (person) setPeople((now) => (now.every((p) => p.name === '' && p.email === '') ? [{ ...blank(1), name: person.name, email: person.addresses[0] ?? '' }] : now))
  }, [origin])
  const [unlinked, setUnlinked] = useState<string | null>(null)
  // Opened from a conversation that has not been read (yet, or at all): nothing is made, because a document made now would carry no link and show in no conversation.
  const waitingForConversation = from !== null && from !== '' && origin === null
  const Picker = SEND_SOURCES.find((s) => s.type === source)?.Picker
  // Send offers the Clients that have signing set up (and, until they are linked, the clients made before Clients were one list, which sign exactly as they did). An archived Client is not offered; its documents already out go on.
  // A Client linked to a row whose archive status Forms could not give (the Clients list could not be read, or the person is not the owner) is not offered either: it might be archived.
  const unknown = (clients.data ?? []).filter((c) => c.client_number !== null && c.client_archived === null)
  const offered = (clients.data ?? []).filter((c) => c.client_number === null || c.client_archived === false)
  const chosen = offered.some((c) => c.id === clientId) ? clientId : (offered[0]?.id ?? '')
  const client = offered.find((c) => c.id === chosen)
  const set = (i: number, patch: Partial<RecipientInput>) => setPeople(people.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (waitingForConversation) return
    setBusy(true)
    setError(null)
    try {
      const made = await api.createEnvelope({ ...(origin?.conversation && { conversation: origin.conversation }), client_id: chosen, source: { ...pick.source, type: source }, sensitive: sensitive || pick.sensitive === true, typed_only: typedOnly, recipients: people.map((p) => ({ ...p, kind: p.kind ?? 'signer' })), order, note: note.trim() || undefined, expires_in_days: days, reminder_every_days: every, reminder_max: max })
      // A forms that predates conversations ignores the link and says nothing; its envelope shows none. The draft exists, so say what it will not do and let it be opened.
      if (origin?.conversation && made.envelope.conversation_app == null) {
        setUnlinked(made.envelope.id)
        setBusy(false)
        return
      }
      go(`/envelopes/${made.envelope.id}`)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
      <div>
        <a href={href('/envelopes')} className="text-sm text-muted-foreground underline">
          Envelopes
        </a>
        <h1 className="text-xl font-semibold">Send</h1>
      </div>
      {from !== null && from !== '' && conversation.loading && !conversation.data ? <p className="text-sm text-muted-foreground">Reading the conversation…</p> : null}
      {conversation.error ? <Notice kind="error">{conversation.error}</Notice> : null}
      {origin ? (
        <div data-testid="send-from">
          <Notice kind="info">
            From your conversation with {origin.name}. The document shows there as a card, and the signed copy comes back to it.{' '}
            <a className="underline" href={origin.channel ? meetPath(origin.key) : inboxPath(origin.key)}>
              Back to the conversation
            </a>
            {origin.channel ? ' A channel does not say who is in it, so name who signs.' : null}
          </Notice>
        </div>
      ) : null}
      {unlinked ? (
        <div data-testid="send-unlinked">
          <Notice kind="warn">
            The draft is made, but Forms has not been updated to link it to a conversation yet, so it will not show as a card there. You can still send it.{' '}
            <a className="underline" href={href(`/envelopes/${unlinked}`)}>
              Open the draft
            </a>
          </Notice>
        </div>
      ) : null}
      {unknown.length > 0 ? (
        <Notice kind="warn">
          Forms could not tell whether {unknown.map((c) => c.display_name).join(', ')} {unknown.length === 1 ? 'is' : 'are'} archived, so {unknown.length === 1 ? 'it is' : 'they are'} not offered below. Reload in a moment; the Clients list is read by the owner only.
        </Notice>
      ) : null}
      {clients.data && offered.length === 0 && unknown.length === 0 ? (
        <Notice kind="info">
          No Client is set up for signing yet: what you send carries its name and logo. <a className="underline" href={href('/clients')}>Set up signing for a Client</a>
        </Notice>
      ) : null}
      <form onSubmit={submit} className="grid max-w-2xl gap-4">
        <Card title="What and for whom">
          <div className="grid gap-3">
            <Field label="Client" htmlFor="client">
              <select id="client" className={INPUT} value={chosen} onChange={(e) => setClientId(e.target.value)} required>
                {offered.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name}
                    {c.client_number === null ? ' (not linked to a Client)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">What to send</legend>
              {SEND_SOURCES.map((s) => (
                <label key={s.type} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="source"
                    className="mt-1"
                    checked={source === s.type}
                    onChange={() => {
                      setSource(s.type)
                      setPick({})
                    }}
                  />
                  <span>
                    <span className="font-medium">{s.label}</span>
                    <span className="block text-xs text-muted-foreground">{s.hint}</span>
                  </span>
                </label>
              ))}
              {Picker ? <Picker key={source} clientId={chosen} onChange={setPick} /> : null}
            </fieldset>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
              <span>
                <span className="font-medium">This holds private information</span>
                <span className="block text-xs text-muted-foreground">A Social Security or bank number, say. The finished document then goes to everyone by a private link that works for 90 days and records each download, not as an attachment.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={typedOnly} onChange={(e) => setTypedOnly(e.target.checked)} />
              <span>
                <span className="font-medium">The signer types their own name, and nothing else</span>
                <span className="block text-xs text-muted-foreground">For a consent the IRS wants signed that way (an IRS 7216 consent, say). The signature field starts blank and they type their name into it; drawing and uploading a picture are not offered.</span>
              </span>
            </label>
          </div>
        </Card>

        <Card title="Who signs">
          <div className="grid gap-4">
            {people.map((p, i) => (
              <fieldset key={i} className="grid gap-2 sm:grid-cols-3">
                <legend className="mb-1 text-sm font-medium">Signer {i + 1}</legend>
                <Field label="Name" htmlFor={`name-${i}`}>
                  <input id={`name-${i}`} className={INPUT} required maxLength={80} value={p.name} onChange={(e) => set(i, { name: e.target.value })} autoComplete="off" />
                </Field>
                <Field label="Email" htmlFor={`email-${i}`}>
                  <input id={`email-${i}`} className={INPUT} type="email" required value={p.email} onChange={(e) => set(i, { email: e.target.value })} autoComplete="off" list={i === 0 && (origin?.people[0]?.addresses.length ?? 0) > 1 ? 'conversation-addresses' : undefined} />
                  {i === 0 && (origin?.people[0]?.addresses.length ?? 0) > 1 ? (
                    <datalist id="conversation-addresses">
                      {origin?.people[0]?.addresses.map((a) => (
                        <option key={a} value={a} />
                      ))}
                    </datalist>
                  ) : null}
                </Field>
                <Field label="Role" htmlFor={`role-${i}`} hint={i === 0 ? 'Shown to them, for example Client' : undefined}>
                  <input id={`role-${i}`} className={INPUT} required maxLength={40} value={p.role} onChange={(e) => set(i, { role: e.target.value })} />
                </Field>
                {people.length > 1 ? (
                  <div className="sm:col-span-3">
                    <Button kind="quiet" type="button" onClick={() => setPeople(people.filter((_, j) => j !== i))}>
                      Remove signer {i + 1}
                    </Button>
                  </div>
                ) : null}
              </fieldset>
            ))}
            {people.length < 4 ? (
              <div>
                <Button kind="quiet" type="button" onClick={() => setPeople([...people, blank(people.length + 1)])}>
                  Add a signer
                </Button>
              </div>
            ) : null}
            {client && client.copy_addresses.length > 0 ? <p className="text-xs text-muted-foreground">{client.display_name}'s copy {client.copy_addresses.length === 1 ? 'address' : 'addresses'} ({client.copy_addresses.join(', ')}) will get the finished document too.</p> : null}
            <fieldset className="grid gap-1">
              <legend className="text-sm font-medium">Signing order</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="order" checked={order === 'sequential'} onChange={() => setOrder('sequential')} /> One after another (each is emailed when it is their turn)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="order" checked={order === 'parallel'} onChange={() => setOrder('parallel')} /> All at once
              </label>
            </fieldset>
          </div>
        </Card>

        <Card title="The message and the schedule">
          <div className="grid gap-3">
            <Field label="A note for the email (optional)" htmlFor="note" hint="It appears in the email as written.">
              <textarea id="note" className={`${INPUT} min-h-20 py-2`} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Expires after (days)" htmlFor="days">
                <input id="days" className={INPUT} type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} />
              </Field>
              <Field label="Remind every (days)" htmlFor="every">
                <input id="every" className={INPUT} type="number" min={1} max={30} value={every} onChange={(e) => setEvery(Number(e.target.value))} />
              </Field>
              <Field label="At most (reminders)" htmlFor="max" hint="0 for none. Sent only 9 to 5 in the client's time zone.">
                <input id="max" className={INPUT} type="number" min={0} max={10} value={max} onChange={(e) => setMax(Number(e.target.value))} />
              </Field>
            </div>
          </div>
        </Card>

        <SendWarning />
        {error ? <Notice kind="error">{error}</Notice> : null}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || !chosen || waitingForConversation || unlinked !== null || (Picker !== undefined && pick.ready !== true)}>
            {busy ? 'Making the draft…' : 'Review the email'}
          </Button>
          <p className="text-xs text-muted-foreground">Nothing is sent yet: the next screen shows the email as it will arrive.</p>
        </div>
      </form>
    </>
  )
}
