// What a visitor is shown once a time is theirs: the meeting, when it is, the meeting link, and the address that moves or cancels it. Shown by the link's page (a new booking) and, for a booking found again, by the booking's own page.
import type { GuestBooked, GuestBookingLink } from '@space/workspace'
import { managePath } from './api'
import { dayFull, span, zoneLabel } from './time'

export function Done({ booked, link, zone }: { booked: GuestBooked; link: GuestBookingLink; zone: string }) {
  const b = booked.booking
  const pending = b.state === 'pending'
  const href = managePath(booked.secret)
  return (
    <div className="card single">
      <section className="main wide" aria-label="Your booking">
        <p className="company">{link.company}</p>
        <h1 data-testid="booked-title">{pending ? 'Your time is held' : 'You are booked'}</h1>
        <p className={`say ${pending ? 'warn' : 'good'}`} role="status">
          {pending
            ? 'The calendar has not confirmed this yet. Look for the invitation in your email in the next few minutes; this page will say when it is confirmed.'
            : `A calendar invitation with the meeting link has been sent to ${b.email}.`}
        </p>
        <dl className="facts">
          <div>
            <dt>What</dt>
            <dd>{b.title}</dd>
          </div>
          <div>
            <dt>When</dt>
            <dd>
              {dayFull(b.start, zone)}
              <br />
              {span(b.start, b.end, zone)} <span className="muted">({zoneLabel(b.start, zone)})</span>
            </dd>
          </div>
          <div>
            <dt>Who</dt>
            <dd>{b.name}</dd>
          </div>
          {b.meetLink !== null && !pending && (
            <div>
              <dt>Where</dt>
              <dd>
                <a href={b.meetLink} target="_blank" rel="noopener noreferrer">
                  Google Meet
                </a>
              </dd>
            </div>
          )}
        </dl>
        <p className="manage">
          To move or cancel this meeting, use <a href={href}>this address</a>
          . It is in the invitation too, and only you have it: keep it to yourself.
        </p>
      </section>
    </div>
  )
}
