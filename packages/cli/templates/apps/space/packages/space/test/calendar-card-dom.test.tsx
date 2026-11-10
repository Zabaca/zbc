// An email's calendar card as the page draws it: each kind of card in a conversation over the `SPACE_FIXTURES=calendar-mail` stand-ins (one invented person, Ana Vidal, whose emails have a calendar part and no words), in a stand-in DOM so what a
// person reads can be asserted. What these prove is the space's half: a card in place of the empty bubble (never both), the kind and the answer in words, the time on the company's clock, the owner's "Open in Calendar" where the event is in the
// Calendar tab and a bare answer's title and time taken from there, the file chip kept under the card, and nothing on a card that could answer an invitation or send anything.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { T0, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { newCompose } from '../src/client/compose'
import { openConversation } from '../src/conversation'
import { fixtureApps } from '../src/stand-ins'
import { OWNER_SIGNED_IN } from './signed-in'

const ZONE = 'America/Los_Angeles'
const install = northfield()
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, install)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function draw(options: { withFile?: boolean } = {}) {
  const apps = fixtureApps(T0, 'calendar-mail', { zone: ZONE })
  const opened = await openConversation({ apps, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 200, now: () => T0 }, 'ana@vidalcreative.example')
  if (!opened.ok) throw new Error(opened.message)
  const answer = opened.value
  if (options.withFile) {
    // The same email with a file under its card, as a business mailbox's would have: the chip stays.
    const first = answer.sources.find((s) => s.kind === 'mail')
    if (first?.kind === 'mail' && first.messages[0]) first.messages[0].attachments = [{ name: 'invite.ics', size: 1009, type: 'text/calendar', picture: false, download: true }]
  }
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ConversationView } = await import('../src/client/Conversation')
  document.body.innerHTML = '<div id="root"></div>'
  const host = document.getElementById('root') as HTMLElement
  const root = createRoot(host)
  const props = {
    me: ME,
    now: T0,
    answer,
    sources: answer.sources,
    loadingEarlier: false,
    onEarlier: () => undefined,
    way: 'email' as const,
    onWay: () => undefined,
    threadId: null,
    onThread: () => undefined,
    compose: newCompose(),
    onText: () => undefined,
    onSend: () => undefined,
    onSendAndClose: () => undefined,
    onClose: () => undefined,
    onReopen: () => undefined,
    reopen: null,
    changing: false,
    changed: null,
    onDismiss: () => undefined,
    drafts: {},
    onSendDraft: () => undefined,
    onDismissDraft: () => undefined,
    onDraftChanged: () => undefined,
    profileOpen: false,
    onProfile: () => undefined,
    onBack: () => undefined,
  }
  await act(async () => {
    root.render(createElement(ConversationView, props))
    await sleep(10)
  })
  return { host, answer, done: () => act(async () => root.unmount()) }
}

const cards = (host: HTMLElement) => [...host.querySelectorAll('[data-testid="calendar-card"]')] as HTMLElement[]
const byTitle = (host: HTMLElement, title: string) => cards(host).find((c) => c.querySelector('[data-testid="calendar-title"]')?.textContent === title)
const text = (card: Element | null | undefined, id: string) => card?.querySelector(`[data-testid="calendar-${id}"]`)?.textContent ?? null

describe('an email with a calendar part and no words', () => {
  test('is a card in place of the empty bubble: every email has one card, and none has an empty bubble', async () => {
    const { host, done } = await draw()
    expect(cards(host)).toHaveLength(15)
    for (const entry of host.querySelectorAll('[data-testid="entry"]')) {
      expect(entry.querySelector('[data-testid="calendar-card"]')).not.toBeNull()
      expect(entry.querySelector('.msg-text.bubble')).toBeNull()
      expect(entry.querySelector('.msg-text')).toBeNull()
    }
    await done()
  })

  test('says what it is: an invitation, an updated invitation, a cancellation, a plain event', async () => {
    const { host, done } = await draw()
    const heading = (title: string, nth = 0) => [...cards(host)].filter((c) => c.querySelector('[data-testid="calendar-title"]')?.textContent === title)[nth]?.querySelector('[data-testid="calendar-heading"]')?.textContent
    expect(heading('Roadmap review', 0)).toBe('Invitation')
    expect(heading('Roadmap review', 1)).toBe('Updated invitation')
    expect(heading('Lunch with the Fernway crew')).toBe('Cancelled')
    expect(heading('Bike fitting at Ridgeway Cycles')).toBe('Event')
    await done()
  })

  test('shows an invitation’s time on the company’s clock, its place, its organizer and its guests, up to ten and a count of the rest', async () => {
    const { host, done } = await draw()
    const card = cards(host)[0] as HTMLElement
    expect(text(card, 'when')).toMatch(/^\w{3}, \w{3} \d{1,2}, 10:00 AM to 10:30 AM P[SD]T$/)
    expect(text(card, 'place')).toBe('Where: Room 4, Vidal Creative')
    expect(text(card, 'from')).toBe('From Ana Vidal')
    expect(text(card, 'guests')).toBe('With Tessa Marlow, Ben Cole, Cal Ortiz, Dee Lund, Eli Park, Fay Mori, Gus Hale, Hana Reyes, Ivo Brandt, Jo Marsh and 4 more')
    await done()
  })

  test('says "From you" on an invitation the owner sent', async () => {
    const { host, done } = await draw()
    expect(text(byTitle(host, 'Brand review'), 'from')).toBe('From you')
    await done()
  })

  test('a cancellation shows the time it was for, struck through', async () => {
    const { host, done } = await draw()
    const card = byTitle(host, 'Lunch with the Fernway crew') as HTMLElement
    expect(card.querySelector('[data-testid="calendar-when"]')?.className).toContain('struck')
    expect(card.className).toContain('bad')
    await done()
  })

  test('a guest’s answer says who answered and how, with their note in their own words; a counter proposal says the time it proposes', async () => {
    const { host, done } = await draw()
    const heading = (kind: string, answer: string) => cards(host).filter((c) => c.getAttribute('data-kind') === kind && c.getAttribute('data-answer') === answer).map((c) => c.querySelector('[data-testid="calendar-heading"]')?.textContent)
    expect(heading('reply', 'accepted')).toEqual(['Ana Vidal accepted', 'Ana Vidal accepted'])
    expect(heading('reply', 'declined')).toEqual(['Ana Vidal declined'])
    expect(heading('reply', 'tentative')).toEqual(['Ana Vidal said maybe'])
    expect(heading('reply', 'counter')[0]).toMatch(/^Ana Vidal proposed a new time: \w{3}, \w{3} \d{1,2}, 2:00 PM to 2:30 PM P[SD]T$/)
    expect(text(byTitle(host, 'Fernway budget review'), 'note')).toBe('I am out of the office that week, sorry. Could we do the week after?')
    // The proposed time is said once, in the heading.
    expect(text(byTitle(host, 'Planning check-in'), 'when')).toBeNull()
    await done()
  })

  test('a repeating event says it repeats, and one occurrence says which', async () => {
    const { host, done } = await draw()
    const weekly = cards(host).filter((c) => c.querySelector('[data-testid="calendar-title"]')?.textContent === 'Weekly planning')
    expect(text(weekly[0], 'repeats')).toBe('Repeats')
    expect(text(weekly[1], 'repeats')).toMatch(/^Part of a repeating event: the one on \w{3}, \w{3} \d{1,2}$/)
    await done()
  })

  test('an all-day event is shown by its days, never as midnight; a time that could not be resolved is said not to be converted; a part of several events counts the rest', async () => {
    const { host, done } = await draw()
    expect(text(byTitle(host, 'Team offsite'), 'when')).toMatch(/^\w{3}, \w{3} \d{1,2} to \w{3}, \w{3} \d{1,2}, all day$/)
    expect(text(byTitle(host, 'Coffee with Ana'), 'when')).toMatch(/\(the part gave no time zone\)$/)
    expect(text(byTitle(host, 'Offsite: day one'), 'more')).toBe('and 2 more events')
    await done()
  })

  test('a bare answer is given the event’s title and time from the Calendar tab, and "Open in Calendar" opens that event; a card for an event nobody holds has no link', async () => {
    const { host, done } = await draw()
    const lent = byTitle(host, 'Advisory intro: Maria Lopez') as HTMLElement
    expect(lent.querySelector('[data-testid="calendar-heading"]')?.textContent).toBe('Ana Vidal accepted')
    expect(text(lent, 'when')).toMatch(/4:00 PM to 4:30 PM P[SD]T$/)
    const link = lent.querySelector('[data-testid="calendar-open"]') as HTMLAnchorElement
    expect(link.textContent).toBe('Open in Calendar')
    expect(link.getAttribute('href')).toMatch(/^\/calendar\/event\/tessa%40northfield\.example%7Ctessa%40northfield\.example%7Cev\d+$/)
    expect(host.querySelectorAll('[data-testid="calendar-open"]')).toHaveLength(1)
    await done()
  })

  test('has nothing on it that answers an invitation, sends anything or follows a stranger’s link', async () => {
    const { host, done } = await draw()
    for (const card of cards(host)) {
      expect(card.querySelector('button, form, input, textarea')).toBeNull()
      expect([...card.querySelectorAll('a')].map((a) => a.getAttribute('data-testid'))).toEqual(card.querySelector('[data-testid="calendar-open"]') ? ['calendar-open'] : [])
      expect(card.textContent).not.toMatch(/\b(Accept|Decline|Reply|RSVP)\b/)
      expect(card.innerHTML).not.toContain('http')
    }
    await done()
  })

  test('keeps the file chip under the card, as it is today', async () => {
    const { host, done } = await draw({ withFile: true })
    const entry = host.querySelector('[data-testid="entry"]') as HTMLElement
    expect(entry.querySelector('[data-testid="calendar-card"]')).not.toBeNull()
    expect(entry.textContent).toContain('invite.ics')
    // The card comes first in the entry, the file after it.
    expect(entry.innerHTML.indexOf('invite.ics')).toBeGreaterThan(entry.innerHTML.indexOf('calendar-card'))
    await done()
  })
})
