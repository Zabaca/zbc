// A booking's own page (`/book/manage/<secret>`): what was booked, when, and the two things its visitor may do, move it to another free time or cancel it. The secret in the address is the only credential: whoever has it is the visitor.
import { useCallback, useEffect, useState } from 'react'
import type { GuestBookingView } from '@space/workspace'
import { api } from './api'
import { Notice } from './LinkPage'
import { Picker } from './Picker'
import { dayFull, ownZone, span, zoneLabel } from './time'
import { whereJoin, whereNote } from './where'

type Load = { kind: 'loading' } | { kind: 'missing' } | { kind: 'failed'; message: string } | { kind: 'ready'; view: GuestBookingView }
type Mode = { kind: 'view' } | { kind: 'move'; starts: number[]; picked: number | null } | { kind: 'cancel' }

const STATE_WORDS: Record<GuestBookingView['state'], { title: string; text: string; tone: 'good' | 'warn' | 'bad' }> = {
  booked: { title: 'You are booked', text: 'This meeting is on the calendar, and the invitation has been sent.', tone: 'good' },
  pending: { title: 'Your time is held', text: 'The calendar has not confirmed this yet. Look for the invitation in your email; reload this page in a few minutes.', tone: 'warn' },
  cancelled: { title: 'This booking was cancelled', text: 'Nothing is booked any more. The calendar has told you by email.', tone: 'bad' },
  removed: { title: 'This meeting was removed', text: 'The person you were meeting removed it from their calendar. You can book another time if the link is still open.', tone: 'bad' },
  past: { title: 'This meeting has been', text: 'It cannot be moved or cancelled now.', tone: 'warn' },
}

export function ManagePage({ secret }: { secret: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [mode, setMode] = useState<Mode>({ kind: 'view' })
  const [zone, setZone] = useState<string | null>(null)
  const [say, setSay] = useState<{ text: string; tone: 'good' | 'bad' } | null>(null)
  const [busy, setBusy] = useState(false)

  const read = useCallback(async () => {
    const got = await api.booking(secret)
    if (!got.ok) {
      setLoad(got.status === 404 ? { kind: 'missing' } : { kind: 'failed', message: got.message })
      return
    }
    document.title = `${got.value.title} with ${got.value.company}`
    setLoad({ kind: 'ready', view: got.value })
    setZone((held) => held ?? ownZone(got.value.zone))
  }, [secret])

  useEffect(() => {
    void read()
  }, [read])

  if (load.kind === 'loading') return <p className="status" role="status">Loading</p>
  if (load.kind === 'missing') return <Notice title="We could not find this booking" text="Check the address in your invitation. It may have been cut short when it was copied." />
  if (load.kind === 'failed') return <Notice title="This page could not be loaded" text={load.message} again={() => void read()} />
  const { view } = load
  const here = zone ?? ownZone(view.zone)
  const words = STATE_WORDS[view.state]

  async function startMove() {
    setBusy(true)
    setSay(null)
    const got = await api.bookingSlots(secret)
    setBusy(false)
    if (!got.ok) {
      setSay({ text: got.message, tone: 'bad' })
      await read()
      return
    }
    setMode({ kind: 'move', starts: got.value.starts.filter((t) => t !== view.start), picked: null })
  }

  async function move(start: number) {
    setBusy(true)
    setSay(null)
    const got = await api.move(secret, start)
    setBusy(false)
    if (got.ok) {
      setLoad({ kind: 'ready', view: got.value })
      setMode({ kind: 'view' })
      setSay({ text: 'It is moved, and the calendar has sent you the new time.', tone: 'good' })
      return
    }
    setSay({ text: got.message, tone: 'bad' })
    // A time that has gone is shown the others.
    if (got.status === 409) await startMove()
  }

  async function cancel() {
    setBusy(true)
    setSay(null)
    const got = await api.cancel(secret)
    setBusy(false)
    if (got.ok) {
      setLoad({ kind: 'ready', view: got.value })
      setMode({ kind: 'view' })
      setSay({ text: 'It is cancelled, and the calendar has told you by email.', tone: 'good' })
      return
    }
    setMode({ kind: 'view' })
    setSay({ text: got.message, tone: 'bad' })
    await read()
  }

  return (
    <div className="card single">
      <section className="main wide" aria-label="Your booking">
        <p className="company">{view.company}</p>
        <h1 data-testid="manage-title">{words.title}</h1>
        <p className={`say ${words.tone}`} role="status">
          {words.text}
        </p>
        {say !== null && (
          <p className={`say ${say.tone}`} role="alert" data-testid="manage-say">
            {say.text}
          </p>
        )}
        <dl className="facts">
          <div>
            <dt>What</dt>
            <dd>
              {view.title} <span className="muted">({view.minutes} minutes)</span>
            </dd>
          </div>
          <div>
            <dt>When</dt>
            <dd>
              {dayFull(view.start, here)}
              <br />
              {span(view.start, view.end, here)} <span className="muted">({zoneLabel(view.start, here)})</span>
            </dd>
          </div>
          <div>
            <dt>Who</dt>
            <dd>{view.name}</dd>
          </div>
          {view.meetLink !== null && view.state === 'booked' && (
            <div>
              <dt>Where</dt>
              <dd>
                <a href={view.meetLink} target="_blank" rel="noopener noreferrer">
                  {whereJoin(view.where)}
                </a>
                {whereNote(view.where) !== null && (
                  <>
                    <br />
                    <span className="muted">{whereNote(view.where)}</span>
                  </>
                )}
              </dd>
            </div>
          )}
        </dl>

        {mode.kind === 'view' && (
          <div className="actions left">
            {view.canMove && (
              <button type="button" className="btn primary" disabled={busy} onClick={() => void startMove()}>
                Move to another time
              </button>
            )}
            {view.canCancel && (
              <button type="button" className="btn danger" disabled={busy} onClick={() => setMode({ kind: 'cancel' })}>
                Cancel this booking
              </button>
            )}
            {(view.state === 'cancelled' || view.state === 'removed') && view.linkOpen && view.slug !== null && (
              <a className="btn primary" href={`/book/${view.slug}`}>
                Book another time
              </a>
            )}
          </div>
        )}

        {mode.kind === 'cancel' && (
          <div className="confirm" role="group" aria-label="Cancel this booking">
            <p>Cancel this meeting? The calendar will tell everyone involved.</p>
            <div className="actions left">
              <button type="button" className="btn danger" disabled={busy} onClick={() => void cancel()}>
                {busy ? 'Cancelling' : 'Yes, cancel it'}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setMode({ kind: 'view' })}>
                Keep it
              </button>
            </div>
          </div>
        )}

        {mode.kind === 'move' && (
          <div className="move" role="group" aria-label="Move this booking">
            <h2 className="step">Pick another time</h2>
            <Picker
              starts={mode.starts}
              zone={here}
              zones={[here, view.zone]}
              onZone={setZone}
              picked={mode.picked}
              onPick={(t) => setMode({ ...mode, picked: t })}
              none="There is no other free time in the coming weeks."
            />
            <div className="actions left">
              <button type="button" className="btn primary" disabled={busy || mode.picked === null} onClick={() => mode.picked !== null && void move(mode.picked)}>
                {busy ? 'Moving' : mode.picked === null ? 'Pick a time' : `Move to ${span(mode.picked, mode.picked + view.minutes * 60_000, here)}`}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setMode({ kind: 'view' })}>
                Never mind
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
