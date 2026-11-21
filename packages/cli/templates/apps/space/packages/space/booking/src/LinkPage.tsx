// A booking link's page (`/book/<name>`): the link's name, its length and what it is for, the free times in the visitor's own zone, and, once one is picked, the short form. What is shown of the owner is nothing but that a time is free.
// Everything a visitor or the owner typed is drawn as text (React text only), never as markup.
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { GuestBooked, GuestBookingLink } from '@space/workspace'
import { api, managePath } from './api'
import { Done } from './Done'
import { Picker } from './Picker'
import { dayFull, ownZone, span, zoneLabel } from './time'

type Load = { kind: 'loading' } | { kind: 'missing' } | { kind: 'failed'; message: string } | { kind: 'ready'; link: GuestBookingLink; starts: number[] }

export function LinkPage({ slug }: { slug: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [zone, setZone] = useState<string | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [done, setDone] = useState<GuestBooked | null>(null)

  const read = useCallback(async () => {
    const link = await api.link(slug)
    if (!link.ok) {
      setLoad(link.status === 404 ? { kind: 'missing' } : { kind: 'failed', message: link.message })
      return
    }
    document.title = `${link.value.name} with ${link.value.company}`
    if (!link.value.open) {
      setLoad({ kind: 'ready', link: link.value, starts: [] })
      return
    }
    const slots = await api.slots(slug)
    if (!slots.ok) {
      // A link that closed between the two calls is a closed link, and says so.
      setLoad(slots.status === 409 ? { kind: 'ready', link: { ...link.value, open: false }, starts: [] } : { kind: 'failed', message: slots.message })
      return
    }
    setLoad({ kind: 'ready', link: link.value, starts: slots.value.starts })
    setZone((held) => held ?? ownZone(link.value.zone))
  }, [slug])

  useEffect(() => {
    void read()
  }, [read])

  if (done !== null && load.kind === 'ready') return <Done booked={done} link={load.link} zone={zone ?? load.link.zone} />
  if (load.kind === 'loading') return <p className="status" role="status">Loading</p>
  if (load.kind === 'missing') return <Notice title="There is no such link" text="Check the address you were sent, or ask the person who sent it." />
  if (load.kind === 'failed') return <Notice title="This page could not be loaded" text={load.message} again={() => void read()} />
  const { link, starts } = load
  const here = zone ?? ownZone(link.zone)

  return (
    <div className="card">
      <section className="about" aria-label="About this meeting">
        <p className="company">{link.company}</p>
        <h1>{link.name}</h1>
        <p className="meta">
          <span>{link.minutes} minutes</span>
          <span>Google Meet</span>
        </p>
        {link.description !== '' && <p className="description">{link.description}</p>}
      </section>
      <section className="main" aria-label="Pick a time">
        {!link.open ? (
          <Notice title="This link cannot be booked right now" text="Please try again later, or ask the person who sent it." quiet />
        ) : picked === null ? (
          <>
            {note !== null && (
              <p className="say bad" role="alert">
                {note}
              </p>
            )}
            <h2 className="step">Pick a time</h2>
            <Picker starts={starts} zone={here} zones={[here, link.zone]} onZone={setZone} picked={picked} onPick={setPicked} none="There is no free time in the coming weeks. Please try again later, or ask the person who sent this link." />
          </>
        ) : (
          <Form
            slug={slug}
            link={link}
            start={picked}
            zone={here}
            back={() => setPicked(null)}
            booked={setDone}
            taken={async (message) => {
              setNote(message)
              setPicked(null)
              await read()
            }}
          />
        )}
      </section>
    </div>
  )
}

function Form({ slug, link, start, zone, back, booked, taken }: { slug: string; link: GuestBookingLink; start: number; zone: string; back(): void; booked(b: GuestBooked): void; taken(message: string): Promise<void> }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [text, setText] = useState('')
  const [website, setWebsite] = useState('')
  const [busy, setBusy] = useState(false)
  const [say, setSay] = useState<string | null>(null)
  const end = start + link.minutes * 60_000

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setSay(null)
    const got = await api.book(slug, { start, name, email, note: text, website })
    if (got.ok) {
      booked(got.value)
      return
    }
    setBusy(false)
    // A time that has gone sends the visitor back to the others, with the sentence; anything else stays on the form with what they typed.
    if (got.status === 409) await taken(got.message)
    else setSay(got.message)
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="form" aria-label="Your details">
      <h2 className="step">Your details</h2>
      <p className="chosen">
        <strong>{dayFull(start, zone)}</strong>
        <br />
        {span(start, end, zone)} <span className="muted">({zoneLabel(start, zone)})</span>
      </p>
      <label className="field">
        <span>Your name</span>
        <input name="name" type="text" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Your email</span>
        <input name="email" type="email" autoComplete="email" required maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} aria-describedby="why-email" />
        <small id="why-email">The invitation, with the meeting link, is sent here.</small>
      </label>
      <label className="field">
        <span>
          Anything to add <em>(optional)</em>
        </span>
        <textarea name="note" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {/* A field a person never sees: a script that fills every field fills this one, and is refused. */}
      <div className="hp" aria-hidden="true">
        <label>
          Website
          <input name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </label>
      </div>
      {say !== null && (
        <p className="say bad" role="alert">
          {say}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={back} disabled={busy}>
          Back
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Booking' : 'Book this time'}
        </button>
      </div>
    </form>
  )
}

export function Notice({ title, text, again, quiet = false }: { title: string; text: string; again?: () => void; quiet?: boolean }) {
  return (
    <div className={quiet ? 'notice quiet' : 'card notice'} role="status">
      <h1 className="notice-title">{title}</h1>
      <p>{text}</p>
      {again && (
        <button type="button" className="btn" onClick={again}>
          Try again
        </button>
      )}
    </div>
  )
}

export { managePath }
