// The calendar mail of the `SPACE_FIXTURES=calendar-mail` stand-ins: one invented person, Ana Vidal, whose conversation holds an email with a calendar part of every kind the page draws as a card (an invitation, an update,
// a cancellation, a guest's answer yes, no and maybe with and without a note, a counter proposal, a bare answer that carries no title or time and takes them from the owner's Calendar tab, a plain event, a repeating event and one
// occurrence of it, an all-day event, a time that could not be resolved, a part of several events, an invitation the owner sent) and not one of them has any words of its own: the empty bubble is what the card replaces. The days are laid on
// the company's clock around `now`, as the calendar stand-in's are, so the screens read the same at any hour. Every person and company is invented.

import { type CalendarSummary, momentAt, wallAt } from '@space/workspace'
import type { StandInContact, StandInThread } from './stand-ins'

const MIN = 60_000
const ANA = { name: 'Ana Vidal', address: 'ana@vidalcreative.example' }
const TESSA = { name: 'Tessa Marlow', address: 'tessa@northfield.example' }
const ANA_FROM = 'Ana Vidal <ana@vidalcreative.example>'

const person = (name: string, address: string) => ({ name, address })
const summary = (over: Partial<CalendarSummary>): CalendarSummary => ({
  kind: 'invitation',
  title: '',
  allDay: false,
  start: null,
  end: null,
  startDate: null,
  endDate: null,
  written: null,
  location: '',
  organizer: null,
  guests: [],
  guestsMore: 0,
  repeats: false,
  occurrence: null,
  uid: '',
  moreEvents: 0,
  ...over,
})

export function calendarMailFixtures(now: number, zone: string): { contacts: StandInContact[]; threads: StandInThread[] } {
  const w = wallAt(now, zone)
  /** A moment on the company's clock: `d` days from today at `h`:`m`. */
  const at = (d: number, h: number, m = 0): number => momentAt(w.y, w.m, w.d + d, h, m, zone)
  const date = (d: number): string => new Date(Date.UTC(w.y, w.m - 1, w.d + d)).toISOString().slice(0, 10)
  const timed = (d: number, h: number, minutes: number, m = 0) => ({ start: at(d, h, m), end: at(d, h, m) + minutes * MIN })
  const ago = (minutes: number) => now - minutes * MIN

  const guests = ['Ben Cole', 'Cal Ortiz', 'Dee Lund', 'Eli Park', 'Fay Mori', 'Gus Hale', 'Hana Reyes', 'Ivo Brandt', 'Jo Marsh', 'Kai Lindgren'].map((n) => person(n, `${n.toLowerCase().replace(' ', '.')}@vidalcreative.example`))
  const roadmap = { title: 'Roadmap review', location: 'Room 4, Vidal Creative' }

  let n = 0
  /** One email with no words, and its calendar part: a thread of its own, the oldest first. */
  const mail = (subject: string, calendar: CalendarSummary, minutesAgo: number, from = ANA_FROM): StandInThread => {
    n += 1
    return {
      id: `t-cal-${n}`,
      subject,
      at: ago(minutesAgo),
      snippet: '',
      unread: n > 11,
      on: ['c-ana'],
      messages: [{ id: `m-cal-${n}`, at: ago(minutesAgo), direction: 'in', from, text: '', calendar }],
    }
  }

  const threads: StandInThread[] = [
    mail('Invitation: Roadmap review', summary({ kind: 'invitation', ...roadmap, ...timed(5, 10, 30), organizer: ANA, guests: [TESSA, ...guests.slice(0, 9)], guestsMore: 4, uid: 'roadmap-review@example.test' }), 60 * 40),
    mail('Updated invitation: Roadmap review', summary({ kind: 'update', ...roadmap, ...timed(5, 11, 30), organizer: ANA, guests: [TESSA, ...guests.slice(0, 2)], uid: 'roadmap-review@example.test' }), 60 * 38),
    mail('Accepted: Roadmap review', summary({ kind: 'reply', answer: 'accepted', by: ANA, ...roadmap, ...timed(5, 11, 30), organizer: TESSA, uid: 'roadmap-review@example.test' }), 60 * 36),
    mail('Declined: Fernway budget review', summary({ kind: 'reply', answer: 'declined', by: ANA, title: 'Fernway budget review', ...timed(6, 14, 60), organizer: TESSA, note: 'I am out of the office that week, sorry. Could we do the week after?', uid: 'fernway-budget@example.test' }), 60 * 30),
    mail('Maybe: Harbor Dental walkthrough', summary({ kind: 'reply', answer: 'tentative', by: ANA, title: 'Harbor Dental walkthrough', ...timed(2, 10, 90), organizer: TESSA, uid: 'harbor-walkthrough@example.test' }), 60 * 28),
    mail('New time proposed: Planning check-in', summary({ kind: 'reply', answer: 'counter', by: ANA, title: 'Planning check-in', ...timed(7, 14, 30), organizer: TESSA, note: 'Friday after lunch works better for the whole team.', uid: 'planning-checkin@example.test' }), 60 * 24),
    // A bare answer: no title and no time in the part, and the event is in the owner's Calendar tab (the calendar stand-in's "Advisory intro: Maria Lopez"), which lends both and the way to open it.
    mail('Accepted: Advisory intro', summary({ kind: 'reply', answer: 'accepted', by: ANA, uid: 'advisory-intro-maria@example.test' }), 60 * 20),
    mail('Canceled event: Lunch with the Fernway crew', summary({ kind: 'cancelled', title: 'Lunch with the Fernway crew', ...timed(3, 12, 60), organizer: ANA, uid: 'fernway-lunch@example.test' }), 60 * 16),
    mail('Bike fitting confirmed', summary({ kind: 'event', title: 'Bike fitting at Ridgeway Cycles', location: '14 Mill Street, Alder Bend', ...timed(4, 9, 45), uid: 'bike-fitting@example.test' }), 60 * 12),
    mail('Invitation: Weekly planning', summary({ kind: 'invitation', title: 'Weekly planning', ...timed(1, 9, 45), organizer: ANA, guests: [TESSA, guests[0] as { name: string; address: string }], repeats: true, uid: 'weekly-planning@example.test' }), 60 * 10),
    mail('Updated invitation: Weekly planning (one occurrence)', summary({ kind: 'update', title: 'Weekly planning', ...timed(8, 10, 45), organizer: ANA, guests: [TESSA], repeats: true, occurrence: { at: at(8, 9), date: null }, uid: 'weekly-planning@example.test' }), 60 * 8),
    mail('Invitation: Team offsite', summary({ kind: 'invitation', title: 'Team offsite', allDay: true, startDate: date(9), endDate: date(11), location: 'Santa Barbara', organizer: ANA, guests: [TESSA], uid: 'team-offsite@example.test' }), 60 * 6),
    mail('Invitation: Coffee', summary({ kind: 'invitation', title: 'Coffee with Ana', written: { start: `${date(2)}T08:30`, end: `${date(2)}T09:00`, zone: null }, organizer: ANA, guests: [TESSA], uid: 'coffee@example.test' }), 60 * 4),
    mail('Calendar of the offsite', summary({ kind: 'event', title: 'Offsite: day one', allDay: true, startDate: date(9), endDate: date(9), moreEvents: 2, uid: 'offsite-days@example.test' }), 60 * 3),
    mail('Invitation: Brand review (from Tessa)', summary({ kind: 'invitation', title: 'Brand review', location: 'Northfield Works, Studio B', ...timed(10, 15, 45), organizer: TESSA, guests: [ANA, guests[1] as { name: string; address: string }], uid: 'brand-review@example.test' }), 60 * 2),
  ]
  const contacts: StandInContact[] = [{ id: 'c-ana', name: 'Ana Vidal', addresses: ['ana@vidalcreative.example'], business: 'Vidal Creative', role: 'Creative director' }]
  return { contacts, threads }
}
