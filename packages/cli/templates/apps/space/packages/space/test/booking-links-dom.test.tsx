// Settings, Calendars: the Booking links card (the space's ADR 0025) as a browser runs it, in a stand-in DOM, over the real routes of the Worker (src/calendar.ts) and a stand-in calendar app: the empty card, making a link from its defaults, what a refusal
// says, changing a link, turning it off and on, deleting it (asked first), copying its address, the sentence for a link that cannot be booked, and the record of each link's bookings, which a visitor's words are drawn into as text.
// The DOM is registered for this file only, so React is imported after it.
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { northfield } from '../../workspace/test/helpers'
import { changeBookingLink, deleteBookingLink, makeBookingLink, readBookingLinks } from '../src/calendar'
import { type CalendarFixtureMode, standInCalendar } from '../src/stand-in-calendar'
import { OWNER_SIGNED_IN } from './signed-in'
import { mount } from './compose-support'

const NOW = Date.UTC(2026, 10, 5, 20, 0, 0)
const realFetch = globalThis.fetch
const realClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'clipboard')

beforeAll(() => {
  setSystemTime(new Date(NOW))
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  setSystemTime()
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
  void realClipboard
})

type Ask = Parameters<typeof readBookingLinks>[0]

function standInWorker(mode: CalendarFixtureMode = '1') {
  const calendar = standInCalendar(NOW, 'America/Los_Angeles', mode)
  const ask: Ask = { apps: { inbox: undefined, meet: undefined, calendar: calendar.methods }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50, writeWithinMs: 200 }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const called: { path: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const body = init?.method === 'POST' && init.body ? JSON.parse(String(init.body)) : {}
    if (init?.method === 'POST') called.push({ path: url.pathname, body })
    const route = async (run: (ask: Ask, body: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; message: string }>) => {
      const got = await run(ask, body)
      return got.ok ? json(got.value) : json({ error: got.message }, 400)
    }
    switch (url.pathname) {
      case '/api/calendar/booking-links':
        return json(await readBookingLinks(ask))
      case '/api/calendar/booking-links/make':
        return route(makeBookingLink)
      case '/api/calendar/booking-links/change':
        return route(changeBookingLink)
      case '/api/calendar/booking-links/delete':
        return route(deleteBookingLink)
      default:
        return json({ error: 'Not found' }, 404)
    }
  }) as typeof fetch
  return { calendar, called }
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T | null
const $$ = (selector: string) => [...document.querySelectorAll(selector)] as HTMLElement[]

async function openCard() {
  const { BookingLinksCard } = await import('../src/client/BookingLinksSettings')
  return mount((h) => h(BookingLinksCard) as never)
}

/** Make the first link through the form, as the owner does. */
async function makeThroughForm(page: Awaited<ReturnType<typeof openCard>>, over: { name?: string; slug?: string; description?: string } = {}) {
  await page.click($('[data-testid="booking-new"]'))
  await page.type($('[data-testid="booking-name"]'), over.name ?? 'Intro call')
  await page.type($('[data-testid="booking-slug"]'), over.slug ?? 'intro-call')
  await page.type($('[data-testid="booking-description"]'), over.description ?? 'A first chat about what you need.')
  await page.click($('[data-testid="booking-save"]'))
}

describe('the card', () => {
  test('says nothing is public until a link is made, and offers New booking link; it describes what a link does', async () => {
    standInWorker()
    const page = await openCard()
    expect($('[data-testid="booking-empty"]')?.textContent).toContain('Nothing is public until you make one')
    expect($('[data-testid="booking-links"]')?.textContent).toContain('Google sends the invitation in your name')
    expect($('[data-testid="booking-links"]')?.textContent).toContain('A visitor sees only that a time is free')
    expect($('[data-testid="booking-new"]')?.textContent).toBe('New booking link')
    expect(($('[data-testid="booking-new"]') as HTMLButtonElement).disabled).toBe(false)
    await page.unmount()
  })

  test('a new link starts from the defaults (Monday to Friday, 9 to 5, four hours’ notice, thirty days ahead, a quarter hour around other meetings), and making it says what it made', async () => {
    const { calendar, called } = standInWorker()
    const page = await openCard()
    await page.click($('[data-testid="booking-new"]'))
    expect(($('[data-testid="booking-minutes"]') as HTMLInputElement).value).toBe('30')
    expect(($('[data-testid="booking-notice"]') as HTMLInputElement).value).toBe('4')
    expect(($('[data-testid="booking-ahead"]') as HTMLInputElement).value).toBe('30')
    expect(($('[data-testid="booking-gap"]') as HTMLInputElement).value).toBe('15')
    expect(($('[data-testid="booking-perday"]') as HTMLInputElement).value).toBe('')
    expect(($('[data-testid="booking-enabled"]') as HTMLInputElement).checked).toBe(true)
    expect(($('[data-testid="booking-account"]') as unknown as HTMLSelectElement | null)?.value).toBe('tessa@northfield.example')
    const days = $$('[data-testid="booking-day"]')
    expect(days.map((d) => [d.getAttribute('data-day'), [...d.querySelectorAll('input[type="time"]')].map((i) => (i as HTMLInputElement).value)])).toEqual([
      ['mon', ['09:00', '17:00']],
      ['tue', ['09:00', '17:00']],
      ['wed', ['09:00', '17:00']],
      ['thu', ['09:00', '17:00']],
      ['fri', ['09:00', '17:00']],
      ['sat', []],
      ['sun', []],
    ])
    expect(days[5]?.textContent).toContain('Closed')
    await page.type($('[data-testid="booking-name"]'), 'Intro call')
    await page.type($('[data-testid="booking-slug"]'), 'intro-call')
    await page.type($('[data-testid="booking-description"]'), 'A first chat about what you need.')
    await page.click($('[data-testid="booking-save"]'))
    expect(called.at(-1)).toMatchObject({ path: '/api/calendar/booking-links/make', body: { slug: 'intro-call', name: 'Intro call', minutes: 30, noticeMinutes: 240, aheadDays: 30, gapMinutes: 15, perDay: null, enabled: true, account: 'tessa@northfield.example' } })
    expect(calendar.booking.links).toHaveLength(1)
    expect($('[data-testid="done"]')?.textContent).toContain('The link is made: https://space.northfield.example/book/intro-call')
    // The form is closed and the link is listed with its address, its length, its account, its hours and its rules.
    expect($('[data-testid="booking-form"]')).toBeNull()
    const item = $('[data-testid="booking-link"]')
    expect(item?.getAttribute('data-slug')).toBe('intro-call')
    expect($('[data-testid="booking-url"]')?.textContent).toBe('https://space.northfield.example/book/intro-call')
    expect(item?.textContent).toContain('30 minutes, on tessa@northfield.example. Mon to Fri 9:00 AM to 5:00 PM; 4 hours’ notice, up to 30 days ahead, a 15 minute gap.')
    expect($('[data-testid="booking-switch"]')?.getAttribute('aria-checked')).toBe('true')
    expect($('[data-testid="booking-none"]')?.textContent).toContain('Nobody has booked this link yet')
    await page.unmount()
  })

  test('a refusal is said in the calendar’s words and the form keeps what was typed', async () => {
    standInWorker()
    const page = await openCard()
    await page.click($('[data-testid="booking-new"]'))
    await page.type($('[data-testid="booking-name"]'), 'Intro call')
    await page.type($('[data-testid="booking-slug"]'), 'api')
    await page.click($('[data-testid="booking-save"]'))
    expect($('[data-testid="say"]')?.textContent).toContain('api cannot be an address')
    expect($('[data-testid="booking-form"]')).not.toBeNull()
    expect(($('[data-testid="booking-name"]') as HTMLInputElement).value).toBe('Intro call')
    // A link with no hours at all is refused in words too.
    await page.type($('[data-testid="booking-slug"]'), 'intro-call')
    for (const remove of $$('[data-testid="booking-day"] button[aria-label^="Remove"]')) await page.click(remove)
    await page.click($('[data-testid="booking-save"]'))
    expect($('[data-testid="say"]')?.textContent).toContain('at least one weekday some hours')
    await page.unmount()
  })

  test('hours are edited a day at a time: open Saturday, add a second span on Friday, remove Monday’s, and the link says what the week is', async () => {
    const { calendar } = standInWorker()
    const page = await openCard()
    await makeThroughForm(page)
    await page.click($('[data-testid="booking-edit"]'))
    const day = (d: string) => $$('[data-testid="booking-day"]').find((x) => x.getAttribute('data-day') === d) as HTMLElement
    await page.click([...day('sat').querySelectorAll('button')].find((b) => b.textContent === 'Open this day') as HTMLElement)
    await page.click([...day('fri').querySelectorAll('button')].find((b) => b.textContent === 'Add hours') as HTMLElement)
    await page.click(day('mon').querySelector('button[aria-label^="Remove"]'))
    expect([...day('fri').querySelectorAll('input[type="time"]')].map((i) => (i as HTMLInputElement).value)).toEqual(['09:00', '17:00', '17:00', '17:00'])
    // Friday's second span is a span of nothing until it is set: the calendar refuses it in words.
    await page.click($('[data-testid="booking-save"]'))
    expect($('[data-testid="say"]')?.textContent).toContain('runs from one time to a later one')
    const second = [...day('fri').querySelectorAll('input[type="time"]')] as HTMLInputElement[]
    await page.type(second[2] as HTMLInputElement, '18:00')
    await page.type(second[3] as HTMLInputElement, '19:30')
    await page.click($('[data-testid="booking-save"]'))
    const saved = calendar.booking.links[0]
    expect(saved?.hours.mon).toEqual([])
    expect(saved?.hours.sat).toEqual([{ from: 540, to: 1020 }])
    expect(saved?.hours.fri).toEqual([{ from: 540, to: 1020 }, { from: 1080, to: 1170 }])
    expect($('[data-testid="booking-link"]')?.textContent).toContain('Tue to Thu 9:00 AM to 5:00 PM')
    expect($('[data-testid="booking-link"]')?.textContent).toContain('Fri 9:00 AM to 5:00 PM and 6:00 PM to 7:30 PM')
    expect($('[data-testid="booking-link"]')?.textContent).toContain('Sat 9:00 AM to 5:00 PM')
    await page.unmount()
  })

  test('editing changes a link and says so; the on switch turns it off and on and says what each means', async () => {
    const { calendar, called } = standInWorker()
    const page = await openCard()
    await makeThroughForm(page)
    await page.click($('[data-testid="booking-edit"]'))
    expect(($('[data-testid="booking-name"]') as HTMLInputElement).value).toBe('Intro call')
    await page.type($('[data-testid="booking-name"]'), 'Intro chat')
    await page.type($('[data-testid="booking-minutes"]'), '45')
    await page.type($('[data-testid="booking-perday"]'), '3')
    await page.type($('[data-testid="booking-notice"]'), '24')
    await page.click($('[data-testid="booking-save"]'))
    expect(called.at(-1)).toMatchObject({ path: '/api/calendar/booking-links/change', body: { id: 'link-1', link: { name: 'Intro chat', minutes: 45, perDay: 3, noticeMinutes: 1440 } } })
    expect($('[data-testid="done"]')?.textContent).toBe('Saved. Intro chat is on.')
    expect($('[data-testid="booking-link"]')?.textContent).toContain('45 minutes')
    expect($('[data-testid="booking-link"]')?.textContent).toContain('1 day’s notice')
    expect($('[data-testid="booking-link"]')?.textContent).toContain('at most 3 a day')
    await page.click($('[data-testid="booking-switch"]'))
    expect(calendar.booking.links[0]?.enabled).toBe(false)
    expect($('[data-testid="booking-link"]')?.getAttribute('data-on')).toBe('false')
    expect($('[data-testid="done"]')?.textContent).toContain('takes no new booking, and bookings already made stay as events')
    await page.click($('[data-testid="booking-switch"]'))
    expect(calendar.booking.links[0]?.enabled).toBe(true)
    expect($('[data-testid="done"]')?.textContent).toContain('visitors can book it')
    await page.unmount()
  })

  test('a link is deleted only after the owner is asked, and the question says what stays', async () => {
    const { calendar } = standInWorker()
    const page = await openCard()
    await makeThroughForm(page)
    await page.click($('[data-testid="booking-delete"]'))
    expect($('[data-testid="ask"]')?.textContent).toContain('Delete Intro call?')
    expect($('[data-testid="ask"]')?.textContent).toContain('stay on your calendar as ordinary events')
    await page.click($('[data-testid="ask-no"]'))
    expect(calendar.booking.links).toHaveLength(1)
    await page.click($('[data-testid="booking-delete"]'))
    await page.click($('[data-testid="ask-yes"]'))
    expect(calendar.booking.links).toHaveLength(0)
    expect($('[data-testid="booking-link"]')).toBeNull()
    expect($('[data-testid="done"]')?.textContent).toContain('is deleted. The bookings it made stay as events')
    expect($('[data-testid="booking-empty"]')).not.toBeNull()
    await page.unmount()
  })

  test('the address is copied: to the clipboard when the browser allows it, and selected for the owner’s own copy when it does not', async () => {
    standInWorker()
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } })
    const page = await openCard()
    await makeThroughForm(page)
    await page.click($('[data-testid="booking-copy"]'))
    expect(copied).toEqual(['https://space.northfield.example/book/intro-call'])
    expect($('[data-testid="booking-copied"]')?.textContent).toBe('Copied https://space.northfield.example/book/intro-call')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('not allowed')
        },
      },
    })
    await page.click($('[data-testid="booking-copy"]'))
    expect($('[data-testid="booking-copied"]')?.textContent).toMatch(/^The address is selected: copy it \((Ctrl|Cmd) and C\)\.$/)
    await page.unmount()
  })
})

describe('what a link says about itself', () => {
  test('a link whose account cannot be booked on says why, and so does an account in the choice', async () => {
    standInWorker('lapsed')
    const page = await openCard()
    await page.click($('[data-testid="booking-new"]'))
    const options = $$('[data-testid="booking-account"] option').map((o) => o.textContent)
    expect(options).toEqual(['Choose an account', 'tessa@northfield.example', 'tessa@ashgrove.example (cannot be booked now)', 'tessa_marlow@gmail.com (cannot be booked now)', 'tessa.marlow@fernway.example (cannot be booked now)'])
    await page.type($('[data-testid="booking-name"]'), 'Ashgrove call')
    await page.type($('[data-testid="booking-slug"]'), 'ashgrove')
    await page.type($('[data-testid="booking-account"]'), 'tessa@ashgrove.example')
    expect($('.cs-booking-form .cs-problem')?.textContent).toContain('sign-in of tessa@ashgrove.example ended')
    await page.click($('[data-testid="booking-save"]'))
    expect($('[data-testid="booking-problem"]')?.textContent).toContain('It cannot be booked right now: The sign-in of tessa@ashgrove.example ended')
    await page.unmount()
  })
})

describe('what each link did', () => {
  test('each booking is a line: who, when, its state and when it was booked; a visitor’s words are text; a cancelled one is said', async () => {
    const { calendar } = standInWorker()
    const page = await openCard()
    await makeThroughForm(page)
    const slots = await calendar.guests.slots('intro-call')
    if (!slots.ok) throw new Error('no slots')
    const [a, b, c] = [slots.value.starts[3], slots.value.starts[8], slots.value.starts[14]] as [number, number, number]
    const first = await calendar.guests.book('intro-call', { start: a, name: 'Ada Quill', email: 'ada@example.org', note: '<b>hello</b> <img src=x onerror="window.__ran = 1">' }, 'local')
    const second = await calendar.guests.book('intro-call', { start: b, name: 'Bea Cole', email: 'bea@example.org', note: '' }, 'local')
    await calendar.guests.book('intro-call', { start: c, name: 'Cy Dunn', email: 'cy@example.org', note: '' }, 'local')
    if (!first.ok || !second.ok) throw new Error('not booked')
    await calendar.guests.cancel(second.value.secret)
    await page.unmount()
    const again = await openCard()
    const rows = $$('[data-testid="booking-row"]')
    expect(rows).toHaveLength(3)
    // Upcoming first, in order of time.
    expect(rows.map((r) => r.querySelector('strong')?.textContent)).toEqual(['Ada Quill', 'Bea Cole', 'Cy Dunn'])
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['booked', 'cancelled', 'booked'])
    expect(rows[0]?.textContent).toContain('ada@example.org')
    expect(rows[0]?.textContent).toMatch(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \w{3} \d+, \d+:\d\d\s(AM|PM)\sPST/)
    expect(rows[0]?.textContent).toContain('On the calendar')
    expect(rows[0]?.textContent).toContain('Booked Nov 5, ')
    expect(rows[1]?.textContent).toContain('Cancelled by the visitor')
    expect($('[data-testid="booking-link"]')?.textContent).toContain('2 coming up')
    // What the visitor wrote is shown as written, and nothing runs.
    expect(rows[0]?.querySelector('.cs-bk-note')?.textContent).toBe('“<b>hello</b> <img src=x onerror="window.__ran = 1">”')
    expect(rows[0]?.querySelectorAll('b, img')).toHaveLength(0)
    expect((globalThis as { __ran?: number }).__ran).toBeUndefined()
    expect(rows[0]?.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
    await again.unmount()
  })
})
