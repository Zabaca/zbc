// What an email's calendar part says, drawn as a card in place of the empty bubble: what it is (an invitation, an updated invitation, a cancellation, a guest's answer, or a plain event), the title, the time on the COMPANY'S clock, the place,
// who sent it and who is invited, and, for a repeating event, that it repeats and which occurrence. The owner's card has "Open in Calendar" when the event is in the Calendar tab (and a reply that carries no title or time has taken them from there:
// conversation.ts `joinCalendar`). Nothing here answers an invitation or sends anything, and every word of it is text: a stranger's calendar part is never markup, and no link of it is drawn.
//
// The words are the workspace package's (`calendar-summary.ts`), the same ones the list's line and Claude's script use; this file only lays them out.
import type { MouseEvent } from 'react'
import { guestsWords, occurrenceWords, summaryHeading, summaryWhen } from '@space/workspace'
import type { MailCalendar } from '../history'
import { Glyph, type GlyphName } from './icons'
import { eventPath, follow } from './route'

/** The card's mark and colour by what the part is: a yes is green, a no and a cancellation red, a maybe amber, the rest the accent's. */
function toneOf(c: MailCalendar): { tone: 'ok' | 'bad' | 'warn' | 'plain'; icon: GlyphName } {
  if (c.kind === 'cancelled') return { tone: 'bad', icon: 'x' }
  if (c.kind !== 'reply') return { tone: 'plain', icon: 'calendar' }
  switch (c.answer) {
    case 'accepted':
      return { tone: 'ok', icon: 'check' }
    case 'declined':
      return { tone: 'bad', icon: 'x' }
    case 'tentative':
      return { tone: 'warn', icon: 'calendar' }
    default:
      return { tone: 'plain', icon: 'calendar' }
  }
}

/** Every sentence a card says, or null when the summary cannot be worded on this clock (it never throws): the page then draws the email as it was, with no card. */
function wordsOf(c: MailCalendar, zone: string) {
  try {
    const when = summaryWhen(c, zone)
    const counter = c.kind === 'reply' && c.answer === 'counter'
    return {
      counter,
      when,
      // A counter proposal says its time in the heading ("Ana proposed a new time: Fri, Nov 14, 2:00 PM"); every other card says it under the title.
      heading: counter && when !== '' ? `${summaryHeading(c)}: ${when}` : summaryHeading(c),
      guests: c.kind === 'reply' ? '' : guestsWords(c),
      occurrence: occurrenceWords(c, zone),
    }
  } catch {
    return null
  }
}

/** Whether the email draws a card: it has a summary and the summary can be worded. Only then is the empty bubble left out. */
export const showsCard = (c: MailCalendar | undefined, zone: string): c is MailCalendar => c !== undefined && wordsOf(c, zone) !== null

export function CalendarCard({ calendar: c, zone, go }: { calendar: MailCalendar; zone: string; go?: ((path: string) => void) | undefined }) {
  const words = wordsOf(c, zone)
  if (words === null) return null
  const { counter, when, heading, guests, occurrence } = words
  const { tone, icon } = toneOf(c)
  const cancelled = c.kind === 'cancelled'
  const reply = c.kind === 'reply'
  const who = c.organizer === null ? '' : c.fromYou ? 'you' : c.organizer.name !== '' ? c.organizer.name : c.organizer.address
  return (
    <div className={`card cal ${tone}`} data-testid="calendar-card" data-kind={c.kind} {...(c.answer !== undefined && { 'data-answer': c.answer })}>
      <span className="card-ico">
        <Glyph name={icon} size={15} />
      </span>
      <div className="card-main">
        <div className="cal-heading" data-testid="calendar-heading">
          {heading}
        </div>
        {c.title !== '' && (
          <div className="card-title" data-testid="calendar-title">
            {c.title}
          </div>
        )}
        {!counter && when !== '' && (
          <div className={`sub cal-when${cancelled ? ' struck' : ''}`} data-testid="calendar-when">
            {when}
          </div>
        )}
        {c.location !== '' && (
          <div className="sub" data-testid="calendar-place">
            Where: {c.location}
          </div>
        )}
        {c.repeats && (
          <div className="sub" data-testid="calendar-repeats">
            {occurrence !== '' ? `Part of a repeating event: ${occurrence}` : 'Repeats'}
          </div>
        )}
        {who !== '' && !reply && (
          <div className="sub" data-testid="calendar-from">
            From {who}
          </div>
        )}
        {guests !== '' && (
          <div className="sub" data-testid="calendar-guests">
            With {guests}
          </div>
        )}
        {c.note !== undefined && (
          <div className="cal-note" data-testid="calendar-note">
            {c.note}
          </div>
        )}
        {c.moreEvents > 0 && (
          <div className="sub" data-testid="calendar-more">
            and {c.moreEvents} more event{c.moreEvents === 1 ? '' : 's'}
          </div>
        )}
      </div>
      {c.eventId !== undefined && (
        <div className="card-act">
          <a
            className="btn"
            href={eventPath(c.eventId)}
            data-testid="calendar-open"
            {...(go && { onClick: (e: MouseEvent<HTMLAnchorElement>) => follow(e, eventPath(c.eventId as string), go) })}
          >
            Open in Calendar
          </a>
        </div>
      )}
    </div>
  )
}
