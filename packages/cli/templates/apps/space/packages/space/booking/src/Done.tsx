// What a visitor is shown once a time is theirs: the meeting, when it is, the meeting link, and the address that moves or cancels it. Shown by the link's page (a new booking) and, for a booking found again, by the booking's own page.
import { useEffect, useState } from 'react'
import type { GuestBooked, GuestBookingLink } from '@space/workspace'
import { api, managePath } from './api'
import { dayFull, span, zoneLabel } from './time'

/** How often a booking that is still being confirmed is asked about, and for how many asks (about three minutes): then the page says where to look instead. */
export const POLL_MS = 5000
export const POLL_TIMES = 36

export function Done({ booked, link, zone, pollMs = POLL_MS }: { booked: GuestBooked; link: GuestBookingLink; zone: string; pollMs?: number }) {
  const [b, setB] = useState(booked.booking)
  const [gaveUp, setGaveUp] = useState(false)
  const pending = b.state === 'pending'
  // A booking the calendar has not confirmed yet is asked about now and then, for a few minutes, and the page changes when it is: after that it says where to look.
  useEffect(() => {
    if (b.state !== 'pending') return
    let asked = 0
    const timer = setInterval(async () => {
      asked += 1
      const got = await api.booking(booked.secret)
      if (got.ok && got.value.state !== 'pending') {
        setB(got.value)
        clearInterval(timer)
      } else if (asked >= POLL_TIMES) {
        setGaveUp(true)
        clearInterval(timer)
      }
    }, pollMs)
    return () => clearInterval(timer)
  }, [b.state, booked.secret, pollMs])
  const href = managePath(booked.secret)
  return (
    <div className="card single">
      <section className="main wide" aria-label="Your booking">
        <p className="company">{link.company}</p>
        <h1 data-testid="booked-title">{pending ? 'Your time is held' : 'You are booked'}</h1>
        <p className={`say ${pending ? 'warn' : 'good'}`} role="status">
          {pending
            ? gaveUp
              ? 'The calendar still has not confirmed this. The invitation will arrive by email if it is made; the address below shows where it stands.'
              : 'The calendar has not confirmed this yet. This page checks for a few minutes and will say when it is booked; the invitation arrives by email.'
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
