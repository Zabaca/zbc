// Book a meeting with a time from a conversation: a title, a day and a time. Meet makes the call now, so its link works from then on; for an email the invitation is put in
// the email being written, and goes only when the person presses Send. The time is read on the COMPANY's clock (the zone named under the box), wherever the browser is.
//
// THIS FORM IS DRAWN BESIDE THE REPLY BOX'S FORM, NEVER INSIDE IT (Conversation.tsx, `Composer`). Enter in one of its boxes submits the form it is in; inside the reply's form that would be
// Send, and the email being written would go (or the chat would be posted, or files attached to the reply would go) with no invitation and no press of Send. Here Enter books.
import { useState } from 'react'
import type { Invitable, ScheduleForm } from './callActions'
import { toLocal } from './invite'

/** The box starts tomorrow at 10:00 on the company's clock. */
export function defaultWhen(now: number, zone: string): string {
  const tomorrow = toLocal(now + 24 * 3_600_000, zone)
  return `${tomorrow.slice(0, 10)}T10:00`
}

export function ScheduleFormView(p: {
  /** Who the conversation is with, for a title to start from. */
  with: string
  zone: string
  now: number
  /** Who the email goes to, and so who is invited. Empty where meet invites the people in the conversation itself (a direct message or a channel). */
  invitable: readonly Invitable[]
  emailed: boolean
  busy: boolean
  onBook(form: ScheduleForm): void
  onCancel(): void
}) {
  const [title, setTitle] = useState(`Call with ${p.with.split(/\s+/)[0] || p.with}`)
  const [when, setWhen] = useState(() => defaultWhen(p.now, p.zone))
  return (
    <form
      className="schedule"
      data-testid="schedule"
      aria-label="Book a meeting"
      onSubmit={(e) => {
        e.preventDefault()
        if (!p.busy) p.onBook({ title, when })
      }}
    >
      <h3>Book a meeting</h3>
      <label className="field">
        <span className="sub">Title</span>
        <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} data-testid="schedule-title" />
      </label>
      <label className="field">
        <span className="sub">Day and time</span>
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} data-testid="schedule-when" />
        <span className="sub">On {p.zone.replace('_', ' ')} time, the company's clock.</span>
      </label>
      {p.invitable.length > 0 ? (
        <p data-testid="schedule-with">
          <span className="sub">Invited, and who the email goes to: </span>
          <b>{p.invitable.map((i) => i.name).join(', ')}</b>
        </p>
      ) : (
        <p className="sub">Everyone in this conversation is invited.</p>
      )}
      <p className="sub">
        {p.emailed
          ? 'The invitation, with the call link, goes into the email you are writing. It is sent only when you press Send there; to change who it goes to, change the reply.'
          : 'The meeting shows as a card here and on Today for the people in it, with the call link.'}
      </p>
      <div className="schedule-bar">
        <button type="submit" className="btn primary" disabled={p.busy} data-testid="schedule-book">
          {p.busy ? 'Booking' : 'Book it'}
        </button>
        <button type="button" className="btn" onClick={p.onCancel} disabled={p.busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}
