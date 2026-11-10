// An email's calendar card in the conversation, at the space's seam: the inbox's answer carries what the calendar part said when the mail arrived (the inbox's own tests), and the space joins each card to the OWNER's Calendar tab:
// the event's card address ("Open in Calendar") and, where the part left out the title or the time (a bare "accepted"), the calendar's. A teammate's answer never asks the calendar and never carries anything of the owner's; the calendar
// not answering, or the install having no Calendar tab, leaves every card as the inbox gave it. Driven through the real router with the stand-ins behind the parts.
import { describe, expect, test } from 'bun:test'
import { type CalendarSummary, createInstall, signedIn } from '@space/workspace'
import { T0, lane, northfield } from '../../workspace/test/helpers'
import { earlier, openConversation } from '../src/conversation'
import { standInCalendar } from '../src/stand-in-calendar'
import { standInInbox, standInMeet, type StandInMessage } from '../src/stand-ins'
import { ago, contact, thread } from './world'

const ZONE = 'America/Los_Angeles'
const ANA = { name: 'Ana Vidal', address: 'ana@vidalcreative.example' }
const ANA_FROM = 'Ana Vidal <ana@vidalcreative.example>'

const summary = (over: Partial<CalendarSummary>): CalendarSummary => ({
  kind: 'reply',
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

/** The stand-in calendar's "Advisory intro: Maria Lopez" is tomorrow at 16:00 on the company's clock, and has this iCalendar id. */
const ADVISORY = 'advisory-intro-maria@example.test'

const bare = summary({ kind: 'reply', answer: 'accepted', by: ANA, uid: ADVISORY })
const titled = summary({ kind: 'reply', answer: 'declined', by: ANA, title: 'Roadmap review', start: T0 + 3_600_000, end: T0 + 7_200_000, uid: 'roadmap@example.test' })
const unknown = summary({ kind: 'reply', answer: 'tentative', by: ANA, uid: 'nobody-has-this@example.test' })

const messages: StandInMessage[] = [
  { id: 'm1', at: ago(300), direction: 'in', from: ANA_FROM, text: '', calendar: bare },
  { id: 'm2', at: ago(200), direction: 'in', from: ANA_FROM, text: '', calendar: titled },
  { id: 'm3', at: ago(100), direction: 'in', from: ANA_FROM, text: '', calendar: unknown },
  { id: 'm4', at: ago(50), direction: 'in', from: ANA_FROM, text: 'No calendar part on this one.' },
]

/** The invented company with a teammate (not an owner) beside the owner: everything else is the bundled install's, Gmail and the Calendar tab on. */
const TEAMED = createInstall({
  ...northfield().declaration,
  people: [
    { address: 'tessa@northfield.example', name: 'Tessa', role: 'owner' },
    { address: 'priya@northfield.example', name: 'Priya', role: 'member' },
  ],
})

/** The conversation with Ana as `who` is shown it, over the stand-in inbox and calendar, in the install the test names. */
async function open(who: string, o: { calendar?: 'down' | 'none'; install?: 'teamed' | 'lane' } = {}) {
  const calendar = standInCalendar(T0, ZONE, o.calendar === 'down' ? 'down' : '1')
  const inbox = standInInbox([contact('c-ana', 'Ana Vidal', 'ana@vidalcreative.example')], [thread('t-ana', ago(50), ['c-ana'], { subject: 'Calendar', messages })], { zone: ZONE })
  const meet = standInMeet({ direct: [], channels: [] }, { history: {} })
  const install = o.install === 'lane' ? lane() : o.install === 'teamed' ? TEAMED : northfield()
  const person = install.person(who)
  if (!person) throw new Error(`${who} is nobody of this install`)
  const ask = { apps: { inbox, meet, ...(o.calendar === 'none' ? {} : { calendar: calendar.methods }) }, install, signedIn: signedIn(person, 4_000_000_000), self: [who], answerWithinMs: 60 }
  const opened = await openConversation(ask, 'ana@vidalcreative.example')
  if (!opened.ok) throw new Error(opened.message)
  const answer = opened.value
  const sent = answer.sources.flatMap((s) => (s.kind === 'mail' ? s.messages : []))
  return { calendar, answer, sent, ask }
}
const cardOf = (sent: { id: string; calendar?: unknown }[], id: string) => sent.find((m) => m.id === id)?.calendar as (CalendarSummary & { eventId?: string; fromYou: boolean }) | undefined

describe('the owner’s cards are joined to their Calendar tab', () => {
  test('a card for an event in the calendar has its card address, and a bare answer is given the event’s title and time', async () => {
    const { sent, calendar } = await open('tessa@northfield.example', { install: 'teamed' })
    const lent = cardOf(sent, 'm1')
    expect(lent).toMatchObject({ kind: 'reply', answer: 'accepted', title: 'Advisory intro: Maria Lopez', allDay: false, uid: ADVISORY })
    expect(lent?.eventId).toMatch(/^tessa@northfield\.example\|tessa@northfield\.example\|ev\d+$/)
    expect(lent?.start).not.toBeNull()
    expect(lent?.end).toBe((lent?.start as number) + 30 * 60_000)
    // The calendar was asked once, with every card's id and no more than the page holds.
    expect(calendar.calls.filter((c) => c.method === 'eventsByUid')).toHaveLength(1)
    expect(calendar.calls.find((c) => c.method === 'eventsByUid')?.args).toEqual([
      [
        { uid: ADVISORY, occurrence: null },
        { uid: 'roadmap@example.test', occurrence: null },
        { uid: 'nobody-has-this@example.test', occurrence: null },
      ],
    ])
  })

  test('a card that has its own title and time keeps them, an event the calendar does not hold gets no address, and an email with no calendar part has no card', async () => {
    const { sent } = await open('tessa@northfield.example', { install: 'teamed' })
    expect(cardOf(sent, 'm2')).toMatchObject({ title: 'Roadmap review', start: T0 + 3_600_000, end: T0 + 7_200_000 })
    expect(cardOf(sent, 'm2')?.eventId).toBeUndefined()
    expect(cardOf(sent, 'm3')).toMatchObject({ title: '', start: null })
    expect(cardOf(sent, 'm3')?.eventId).toBeUndefined()
    expect(cardOf(sent, 'm4')).toBeUndefined()
    expect(sent.find((m) => m.id === 'm4')?.text).toBe('No calendar part on this one.')
  })

  test('the calendar not answering leaves every card as the inbox gave it, and the conversation opens all the same', async () => {
    const { sent, answer } = await open('tessa@northfield.example', { calendar: 'down' })
    expect(cardOf(sent, 'm1')).toMatchObject({ title: '', start: null })
    expect(cardOf(sent, 'm1')?.eventId).toBeUndefined()
    expect(answer.parts.every((p) => p.state === 'ok')).toBe(true)
  })

  test('with no calendar part bound at all, there is nothing to join and the cards stand as they are', async () => {
    const { sent } = await open('tessa@northfield.example', { calendar: 'none' })
    expect(cardOf(sent, 'm1')).toMatchObject({ kind: 'reply', answer: 'accepted' })
    expect(cardOf(sent, 'm1')?.eventId).toBeUndefined()
  })
})

describe('what nobody else is given', () => {
  test('a teammate sees the cards and never asks, nor is given, anything of the owner’s calendar', async () => {
    const { sent, calendar } = await open('priya@northfield.example', { install: 'teamed' })
    expect(cardOf(sent, 'm1')).toMatchObject({ kind: 'reply', answer: 'accepted', title: '', start: null, uid: ADVISORY })
    expect(cardOf(sent, 'm1')?.eventId).toBeUndefined()
    expect(cardOf(sent, 'm2')).toMatchObject({ title: 'Roadmap review' })
    expect(calendar.calls).toEqual([])
    expect(JSON.stringify(sent)).not.toContain('Advisory intro')
  })

  test('an install with no Calendar tab (no Gmail switch) never asks the calendar, whoever is signed in', async () => {
    const { sent, calendar } = await open('lane@pinecrest.test', { install: 'lane' })
    expect(cardOf(sent, 'm1')).toMatchObject({ kind: 'reply', answer: 'accepted', title: '' })
    expect(cardOf(sent, 'm1')?.eventId).toBeUndefined()
    expect(calendar.calls).toEqual([])
  })
})

describe('an older page of mail is joined the same way', () => {
  test('a page of earlier messages carries the owner’s links too, and a teammate’s carries none', async () => {
    const page = async (who: Awaited<ReturnType<typeof open>>) => {
      const got = await earlier(who.ask, { mail: { contactId: 'c-ana', before: 'm4' } })
      if (!got.ok) throw new Error(got.message)
      return got.messages as { id: string; calendar?: { eventId?: string; title: string } }[]
    }
    const owner = await open('tessa@northfield.example', { install: 'teamed' })
    const theirs = await open('priya@northfield.example', { install: 'teamed' })
    const ours = await page(owner)
    expect(ours.find((m) => m.id === 'm1')?.calendar).toMatchObject({ title: 'Advisory intro: Maria Lopez' })
    expect(ours.find((m) => m.id === 'm1')?.calendar?.eventId).toBeDefined()
    expect((await page(theirs)).find((m) => m.id === 'm1')?.calendar?.eventId).toBeUndefined()
    expect(theirs.calendar.calls).toEqual([])
  })
})
