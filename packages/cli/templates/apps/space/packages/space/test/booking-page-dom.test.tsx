// The booking page as a visitor runs it (the space's ADR 0025), in a stand-in DOM, over the real door (src/booking.ts) and the calendar's stand-in: a link's page with its month and times in the visitor's zone, the short form, the confirmation, a time that has
// gone, a link that is off or unknown; and a booking's own page with its move and its cancellation. What the owner and the visitor typed is drawn as the words it is. The DOM is registered for this file only, so React is imported after it.
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { BOOKING_DEFAULTS } from '@space/workspace'
import { bookingAnswer } from '../src/booking'
import { standInCalendar } from '../src/stand-in-calendar'
import { OWNER_SIGNED_IN } from './signed-in'
import { mount } from './compose-support'

/** A Thursday at noon in Los Angeles: the stand-in lays its week out around it. */
const NOW = Date.UTC(2026, 10, 5, 20, 0, 0)
const realFetch = globalThis.fetch

beforeAll(() => {
  setSystemTime(new Date(NOW))
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  setSystemTime()
  await GlobalRegistrator.unregister()
  globalThis.fetch = realFetch
})

const LINK = { ...BOOKING_DEFAULTS, slug: 'intro-call', name: 'Intro call', description: 'A first chat about what you need.', account: 'tessa@northfield.example', enabled: true }

/** The door over the calendar's stand-in, as the page's `fetch` reaches it. `hook` answers a call first, to make a time go or a flood come. */
function world(hook?: (req: Request) => Response | undefined) {
  const app = standInCalendar(NOW, 'America/Los_Angeles')
  const seen: { method: string; path: string; body: unknown; credentials: string | undefined }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://space.northfield.example')
    const request = new Request(url, { method: init?.method ?? 'GET', headers: init?.headers as HeadersInit, ...(init?.body ? { body: init.body as string } : {}) })
    seen.push({ method: request.method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, credentials: init?.credentials })
    return hook?.(request) ?? bookingAnswer(request, { face: app.guests })
  }) as typeof fetch
  const make = async (over: Record<string, unknown> = {}) => {
    const made = await app.methods.makeBookingLink(OWNER_SIGNED_IN, { ...LINK, ...over } as never)
    if (!made.ok) throw new Error(JSON.stringify(made))
    return made.value
  }
  return { app, seen, make }
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T | null
const $$ = (selector: string) => [...document.querySelectorAll(selector)] as HTMLElement[]

async function open(path: string, zone: string | null = 'America/Los_Angeles') {
  const { App } = await import('../booking/src/App')
  const page = await mount((h) => h(App, { pathname: path }) as never)
  // The page draws times on the visitor's own clock, which is whatever this machine's is: a test that reads times sets the zone it reads them in.
  if (zone !== null && $('.pk-zone select')) await page.type($('.pk-zone select'), zone)
  return page
}

describe('a link’s page', () => {
  test('shows the company, the link’s name, its length and what it is for, the month, and the times of the first free day in the visitor’s zone', async () => {
    const w = world()
    await w.make()
    const page = await open('/book/intro-call')
    expect($('.company')?.textContent).toBe('Northfield Works')
    expect($('h1')?.textContent).toBe('Intro call')
    expect($('.meta')?.textContent).toContain('30 minutes')
    expect($('.meta')?.textContent).toContain('Google Meet')
    expect($('.description')?.textContent).toBe('A first chat about what you need.')
    expect($('.pk-month')?.textContent).toContain('November 2026')
    // The days with a time are buttons, the rest are not, and the first day is chosen so its times are on the screen.
    const days = $$('button.pk-day')
    expect(days.length).toBeGreaterThan(5)
    expect(days[0]?.getAttribute('aria-pressed')).toBe('true')
    expect($$('.pk-time').length).toBeGreaterThan(0)
    // The stand-in's Thursday is taken (a standup, a coffee and the board call), and the first free time is Friday's, after the planning meeting and the quarter of an hour kept around it.
    expect($('.pk-day-name')?.textContent).toBe('Friday, November 6')
    expect($$('.pk-time')[0]?.textContent).toMatch(/10:00.AM/)
    expect($('.pk-zone select')).not.toBeNull()
    // No cookie is sent with any call.
    expect(w.seen.every((s) => s.credentials === 'omit')).toBe(true)
    await page.unmount()
  })

  test('picking a time asks for a name and an email and shows the time; booking it says so, with the address that moves or cancels it', async () => {
    const w = world()
    await w.make()
    const page = await open('/book/intro-call')
    await page.click($$('.pk-time')[0] as HTMLElement)
    expect($('.form h2')?.textContent).toBe('Your details')
    expect($('.chosen')?.textContent).toMatch(/Friday, November 6/)
    expect($('.chosen')?.textContent).toMatch(/10:00.AM to 10:30.AM/)
    expect($('.chosen')?.textContent).toContain('PST, America / Los Angeles')
    // A script that fills every field fills the hidden one: it is out of sight and out of the way of a person.
    expect($('.hp')?.getAttribute('aria-hidden')).toBe('true')
    expect($('.hp input')?.getAttribute('tabindex')).toBe('-1')
    await page.type($('input[name="name"]'), 'Ada Quill')
    await page.type($('input[name="email"]'), 'ada@example.org')
    await page.type($('textarea[name="note"]'), 'Looking forward to it.')
    await page.submit($('form'))
    expect($('[data-testid="booked-title"]')?.textContent).toBe('You are booked')
    expect(page.text()).toContain('A calendar invitation with the meeting link has been sent to ada@example.org.')
    expect(page.text()).toContain('Ada Quill')
    const manage = $('.manage a')?.getAttribute('href') ?? ''
    expect(manage).toMatch(/^\/book\/manage\/standin-secret-/)
    // What was sent is what was typed, and the hidden field with it empty.
    expect(w.seen.at(-1)).toMatchObject({ method: 'POST', path: '/book/api/links/intro-call/book', body: { name: 'Ada Quill', email: 'ada@example.org', note: 'Looking forward to it.', website: '' } })
    expect(w.app.events.some((e) => e.title === 'Intro call: Ada Quill')).toBe(true)
    await page.unmount()
  })

  test('the time zone can be changed: the same moments are drawn on another clock', async () => {
    const w = world()
    await w.make()
    const page = await open('/book/intro-call')
    const before = $$('.pk-time')[0]?.textContent
    // A zone whose name is the same in every runtime's list (India's is `Asia/Calcutta` in one and `Asia/Kolkata` in another, so it is not used here).
    await page.type($('.pk-zone select'), 'Europe/London')
    const after = $$('.pk-time')[0]?.textContent
    expect(before).toMatch(/10:00.AM/)
    // 10 am in Los Angeles in November (UTC-8) is 6 pm the same day in London (UTC+0).
    expect(after).toMatch(/6:00.PM/)
    expect($('.pk-day-name')?.textContent).toBe('Friday, November 6')
    expect($('.pk-zone-short')?.textContent).toMatch(/GMT/)
    await page.unmount()
  })

  test('a visitor whose browser reports a zone name the runtime does not list (the old name of a zone) still sees their own zone selected, not another', async () => {
    const w = world()
    await w.make()
    const own = 'Asia/Kolkata'
    const listed = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
    const realFormat = Intl.DateTimeFormat.prototype.resolvedOptions
    // The browser says India's zone is Kolkata whatever its own list calls it, and its list holds the old name only.
    ;(Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf = () => ['America/Los_Angeles', 'Asia/Calcutta', 'Europe/London']
    Intl.DateTimeFormat.prototype.resolvedOptions = function (this: Intl.DateTimeFormat) {
      return { ...realFormat.call(this), timeZone: own }
    }
    try {
      const page = await open('/book/intro-call', null)
      const select = $('.pk-zone select') as unknown as HTMLSelectElement
      expect(select.value).toBe(own)
      expect([...select.options].some((o) => o.value === own)).toBe(true)
      await page.unmount()
    } finally {
      Intl.DateTimeFormat.prototype.resolvedOptions = realFormat
      ;(Intl as unknown as { supportedValuesOf?: unknown }).supportedValuesOf = listed
    }
  })

  test('words the owner and the visitor typed are drawn as words: markup in a description or a name is text, and nothing runs', async () => {
    const w = world()
    await w.make({ description: '<img src=x onerror="window.__ran = 1"> and <b>bold</b>' })
    const page = await open('/book/intro-call')
    expect($('.description')?.textContent).toBe('<img src=x onerror="window.__ran = 1"> and <b>bold</b>')
    expect(document.querySelectorAll('.description img, .description b')).toHaveLength(0)
    await page.click($$('.pk-time')[0] as HTMLElement)
    await page.type($('input[name="name"]'), '<script>window.__ran = 2</script>')
    await page.type($('input[name="email"]'), 'ada@example.org')
    await page.submit($('form'))
    expect(document.querySelectorAll('script:not([src])')).toHaveLength(0)
    expect((globalThis as { __ran?: number }).__ran).toBeUndefined()
    expect(page.text()).toContain('<script>window.__ran = 2</script>')
    await page.unmount()
  })

  test('a time that has gone is said, and the times are read again; what the server refuses on the form (a bad address) stays on the form with what was typed', async () => {
    let first = true
    const w = world((req) => {
      if (req.method === 'POST' && first) {
        first = false
        return Response.json({ error: 'That time is no longer free. Please pick another one.', reason: 'conflict' }, { status: 409 })
      }
      return undefined
    })
    await w.make()
    const page = await open('/book/intro-call')
    await page.click($$('.pk-time')[0] as HTMLElement)
    await page.type($('input[name="name"]'), 'Ada Quill')
    await page.type($('input[name="email"]'), 'ada@example.org')
    const reads = w.seen.filter((s) => s.path.endsWith('/slots')).length
    await page.submit($('form'))
    expect($('.say.bad')?.textContent).toBe('That time is no longer free. Please pick another one.')
    expect($$('.pk-time').length).toBeGreaterThan(0)
    expect(w.seen.filter((s) => s.path.endsWith('/slots')).length).toBe(reads + 1)
    await page.click($$('.pk-time')[1] as HTMLElement)
    // The email field is checked by the browser first; a value the server refuses (an address in the name) is said on the form.
    await page.type($('input[name="name"]'), 'visit https://evil.example')
    await page.type($('input[name="email"]'), 'ada@example.org')
    await page.submit($('form'))
    expect($('.say.bad')?.textContent).toBe('Please give your name, not an address.')
    expect(($('input[name="name"]') as HTMLInputElement).value).toBe('visit https://evil.example')
    expect($('.form')).not.toBeNull()
    await page.unmount()
  })

  test('a link that is off says it cannot be booked right now and offers no time; a link that does not exist says so; a call that cannot be made says it, with Try again', async () => {
    const w = world()
    await w.make({ enabled: false })
    let page = await open('/book/intro-call')
    expect(page.text()).toContain('This link cannot be booked right now')
    expect($$('.pk-time')).toHaveLength(0)
    await page.unmount()

    page = await open('/book/nothing-here')
    expect($('.notice-title')?.textContent).toBe('There is no such link')
    await page.unmount()

    page = await open('/book')
    expect($('.notice-title')?.textContent).toBe('There is nothing here')
    await page.unmount()

    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    page = await open('/book/intro-call')
    expect($('.notice-title')?.textContent).toBe('This page could not be loaded')
    expect(page.text()).toContain('The calendar could not be reached')
    expect($('.notice .btn')?.textContent).toBe('Try again')
    await page.unmount()
  })

  test('a link with no free time says so', async () => {
    const w = world()
    await w.make({ hours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [{ from: 0, to: 20 }] }, minutes: 30 })
    const page = await open('/book/intro-call')
    expect(page.text()).toContain('There is no free time in the coming weeks')
    await page.unmount()
  })
})

describe('a booking that is still being confirmed', () => {
  const view = (state: 'pending' | 'booked') => ({ company: 'Northfield Works', title: 'Intro call', slug: 'intro-call', minutes: 30, start: NOW + 86_400_000, end: NOW + 86_400_000 + 1_800_000, name: 'Ada Quill', email: 'ada@example.org', state, zone: 'America/Los_Angeles', meetLink: state === 'booked' ? 'https://meet.example/abc' : null, canMove: false, canCancel: false, linkOpen: true })
  const link = { company: 'Northfield Works', name: 'Intro call', description: '', minutes: 30, zone: 'America/Los_Angeles', open: true }

  test('is asked about again and the page changes when it is booked, with the Meet link', async () => {
    let asks = 0
    globalThis.fetch = (async () => {
      asks += 1
      return Response.json({ value: view(asks >= 3 ? 'booked' : 'pending') })
    }) as unknown as typeof fetch
    const { Done } = await import('../booking/src/Done')
    const page = await mount((h) => h(Done, { booked: { secret: 'secret-abc-123', booking: view('pending') }, link, zone: 'America/Los_Angeles', pollMs: 20 }) as never)
    expect($('[data-testid="booked-title"]')?.textContent).toBe('Your time is held')
    expect(page.text()).toContain('checks for a few minutes')
    await page.wait(150)
    expect($('[data-testid="booked-title"]')?.textContent).toBe('You are booked')
    expect($('a[href="https://meet.example/abc"]')?.textContent).toBe('Google Meet')
    const settled = asks
    await page.wait(100)
    expect(asks).toBe(settled)
    await page.unmount()
  })

  test('says where to look when it never is', async () => {
    const { POLL_TIMES, Done } = await import('../booking/src/Done')
    globalThis.fetch = (async () => Response.json({ value: view('pending') })) as unknown as typeof fetch
    expect(POLL_TIMES).toBeGreaterThan(10)
    const page = await mount((h) => h(Done, { booked: { secret: 'secret-abc-123', booking: view('pending') }, link, zone: 'America/Los_Angeles', pollMs: 1 }) as never)
    await page.wait(POLL_TIMES * 30)
    expect(page.text()).toContain('still has not confirmed this')
    expect(page.text()).toContain('the address below shows where it stands')
    await page.unmount()
  })
})

describe('a booking’s own page', () => {
  async function booked(w: ReturnType<typeof world>) {
    await w.make()
    const slots = await w.app.guests.slots('intro-call')
    if (!slots.ok) throw new Error('no slots')
    const made = await w.app.guests.book('intro-call', { start: slots.value.starts[10] as number, name: 'Ada Quill', email: 'ada@example.org', note: '' }, 'local')
    if (!made.ok) throw new Error(JSON.stringify(made))
    return { secret: made.value.secret, start: made.value.booking.start }
  }

  test('shows the meeting, when it is and where, and offers to move or cancel it', async () => {
    const w = world()
    const { secret } = await booked(w)
    const page = await open(`/book/manage/${secret}`)
    expect($('[data-testid="manage-title"]')?.textContent).toBe('You are booked')
    expect(page.text()).toContain('Intro call')
    expect(page.text()).toContain('Ada Quill')
    expect($('a[href^="https://meet.google.com/"]')?.textContent).toBe('Google Meet')
    expect($('a[href^="https://meet.google.com/"]')?.getAttribute('rel')).toBe('noopener noreferrer')
    expect($$('.actions .btn').map((b) => b.textContent)).toEqual(['Move to another time', 'Cancel this booking'])
    await page.unmount()
  })

  test('a move shows the other free times, and moving says the guest has been told', async () => {
    const w = world()
    const { secret, start } = await booked(w)
    const page = await open(`/book/manage/${secret}`)
    await page.click($$('.actions .btn')[0] as HTMLElement)
    expect($('.move h2')?.textContent).toBe('Pick another time')
    expect($$('.pk-time').length).toBeGreaterThan(0)
    const pick = $$('.pk-time')[0] as HTMLElement
    await page.click(pick)
    expect($$('.move .actions .btn')[0]?.textContent).toMatch(/^Move to /)
    await page.click($$('.move .actions .btn')[0] as HTMLElement)
    expect($('[data-testid="manage-say"]')?.textContent).toBe('It is moved, and the calendar has sent you the new time.')
    expect(w.app.booking.bookings[0]?.start).not.toBe(start)
    expect(w.app.booking.bookings[0]?.moves).toBe(1)
    await page.unmount()
  })

  test('a cancellation asks first, then says it is cancelled and offers another time', async () => {
    const w = world()
    const { secret } = await booked(w)
    const page = await open(`/book/manage/${secret}`)
    await page.click($$('.actions .btn')[1] as HTMLElement)
    expect($('.confirm')?.textContent).toContain('Cancel this meeting?')
    // Keep it: nothing is cancelled.
    await page.click($$('.confirm .btn')[1] as HTMLElement)
    expect(w.app.booking.bookings[0]?.state).toBe('booked')
    await page.click($$('.actions .btn')[1] as HTMLElement)
    await page.click($$('.confirm .btn')[0] as HTMLElement)
    expect($('[data-testid="manage-title"]')?.textContent).toBe('This booking was cancelled')
    expect($('[data-testid="manage-say"]')?.textContent).toBe('It is cancelled, and the calendar has told you by email.')
    expect($('a.btn')?.getAttribute('href')).toBe('/book/intro-call')
    expect(w.app.booking.bookings[0]?.state).toBe('cancelled')
    await page.unmount()
  })

  test('an address that is not a booking’s says so, and a meeting that has been cannot be moved or cancelled', async () => {
    const w = world()
    const { secret } = await booked(w)
    let page = await open('/book/manage/not-a-real-secret-at-all')
    expect($('.notice-title')?.textContent).toBe('We could not find this booking')
    await page.unmount()
    setSystemTime(new Date(NOW + 40 * 24 * 3_600_000))
    page = await open(`/book/manage/${secret}`)
    expect($('[data-testid="manage-title"]')?.textContent).toBe('This meeting has been')
    expect($$('.actions .btn')).toHaveLength(0)
    await page.unmount()
    setSystemTime(new Date(NOW))
  })
})
