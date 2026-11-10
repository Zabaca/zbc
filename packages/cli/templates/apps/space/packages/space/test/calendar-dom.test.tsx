// The Calendar tab and Settings, Calendars as a browser runs them, in a stand-in DOM, over the real routes of the Worker (src/calendar.ts) and a stand-in calendar app: the agenda by day with each account's colour and
// name, an unanswered invitation said, the card an event opens, a lapsed account's amber line and its last picture marked old, Check now, and the shown switch. And the rule that matters most of all on this screen: EVENT TEXT IS
// UNTRUSTED, so a title or a description that is markup is drawn as the words it is and nothing runs. The DOM is registered for this file only, so React is imported after it (as knowledge-dom.test.tsx does).
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { addDays, dayKey } from '../src/client/calendar-words'
import { readAccounts, readAgenda, readEvent, setShown, syncNow } from '../src/calendar'
import { type CalendarFixtureMode, standInCalendar } from '../src/stand-in-calendar'
import { fixtureApps } from '../src/stand-ins'
import { OWNER_SIGNED_IN } from './signed-in'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const realFetch = globalThis.fetch
/**
 * The clock this file runs on. The stand-in calendar lays its events out from "now" (a meeting at 10 pm, one at 11:59 pm), and the page reads the clock for today and the line for now, so a run on the real clock
 * read differently by the hour: at 11:55 pm the Singapore call crossed midnight and its card said "Nov 10". Midday on a Wednesday, pinned for good, keeps every fixture inside the day it is built for.
 */
const NOW = Date.UTC(2026, 10, 4, 20, 0, 0)
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())

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

/** The Worker's calendar routes over a stand-in calendar app (and Meet's stand-in for the meetings), as the page's `fetch` reaches them. */
function standInWorker(mode: CalendarFixtureMode = '1', over: { meet?: boolean; gmail?: unknown[] } = {}) {
  const now = NOW
  const calendar = standInCalendar(now, 'America/Los_Angeles', mode)
  const apps = fixtureApps(now)
  const ask = { apps: { inbox: undefined, meet: over.meet === false ? undefined : apps.meet, calendar: calendar.methods }, install: northfield(), signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50, writeWithinMs: 200 }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const body = init?.method === 'POST' && init.body ? JSON.parse(String(init.body)) : {}
    switch (url.pathname) {
      case '/api/calendar/agenda': {
        const got = await readAgenda(ask, url.searchParams)
        return got.ok ? json(got.value) : json({ error: got.message }, 400)
      }
      case '/api/calendar/accounts':
        return json(await readAccounts(ask))
      case '/api/calendar/event': {
        const got = await readEvent(ask, url.searchParams.get('id'))
        return got.ok ? json(got.value) : json({ error: got.message }, 400)
      }
      case '/api/calendar/shown': {
        const got = await setShown(ask, body)
        return got.ok ? json(got.value) : json({ error: got.message }, 400)
      }
      case '/api/calendar/sync':
        return json(await syncNow(ask))
      case '/api/inbox/mailboxes':
        // The inbox's own list of accounts, which Settings reads to hint Google when an account is connected again.
        return json({ result: 'ok', value: { gmailAccounts: over.gmail ?? [{ id: 'mb-ashgrove', address: 'tessa@ashgrove.example', name: 'ashgrove', connected: true, state: 'lapsed' }], mailboxes: [], assistantKey: false } })
      default:
        return json({ error: 'Not found' }, 404)
    }
  }) as typeof fetch
  return { calendar, now }
}

async function mount(node: (h: typeof import('react').createElement) => React.ReactElement) {
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  document.body.innerHTML = '<div id="root"></div>'
  const root = createRoot(document.getElementById('root') as HTMLElement)
  await act(async () => {
    root.render(node(createElement))
    await sleep(120)
  })
  const q = <T extends Element = HTMLElement>(testid: string) => document.querySelector(`[data-testid="${testid}"]`) as T | null
  const all = (testid: string) => [...document.querySelectorAll(`[data-testid="${testid}"]`)] as HTMLElement[]
  const click = async (el: Element | null) => {
    if (!el) throw new Error('nothing to click')
    await act(async () => {
      ;(el as HTMLElement).click()
      await sleep(120)
    })
  }
  return { q, all, click, text: () => document.body.textContent ?? '', unmount: () => act(async () => root.unmount()) }
}

/** The Calendar tab on an address that the tab's own links change, as the page's `go` does (the path and its query are kept apart, as the shell keeps them). */
async function openTab(path = '/calendar') {
  const { CalendarTab } = await import('../src/client/Calendar')
  const { useState, createElement } = await import('react')
  const seen: string[] = []
  const Host = () => {
    const [where, setWhere] = useState(path)
    const [pathname = '', query] = where.split('?')
    return createElement(CalendarTab, {
      me: ME,
      pathname,
      search: query === undefined ? '' : `?${query}`,
      go: (p: string) => {
        seen.push(p)
        setWhere(p)
      },
    })
  }
  const page = await mount((h) => h(Host) as never)
  return { page, seen }
}

const row = (page: Awaited<ReturnType<typeof mount>>, title: string) => page.all('cal-event').find((r) => r.textContent?.includes(title))

describe('the agenda', () => {
  test('is a list by day, every account in its own colour and named, with the meetings booked in Meet among them', async () => {
    standInWorker()
    const { page } = await openTab()
    expect(page.q('cal-agenda')).not.toBeNull()
    expect(page.all('cal-day')[0]?.getAttribute('aria-label')).toBe('Today')
    expect(page.all('cal-legend').length).toBe(1)
    expect([...document.querySelectorAll('[data-testid="cal-legend"] li')].map((l) => l.textContent)).toEqual(['northfield', 'ashgrove', 'tessa_marlow', 'fernway'])
    const standup = row(page, 'Northfield Works standup')
    expect(standup?.className).toContain('hue-0')
    expect(standup?.textContent).toContain('northfield')
    // The board call is on two of his calendars and drawn once, naming both accounts.
    expect(page.all('cal-event').filter((r) => r.textContent?.includes('Board call'))).toHaveLength(1)
    expect(row(page, 'Board call')?.querySelector('[data-testid="cal-accounts"]')?.textContent).toBe('northfield and ashgrove')
    // Meet's meetings are among them, with a Join that opens the call in a tab of its own.
    const meetings = page.all('cal-meeting')
    expect(meetings.length).toBeGreaterThan(0)
    const join = meetings[0]?.querySelector('a[data-testid="cal-join"]') as HTMLAnchorElement
    expect(join.target).toBe('_blank')
    expect(join.rel).toContain('noopener')
    expect(join.href.startsWith('https://')).toBe(true)
    // A calendar that is hidden to begin with does not show its events.
    expect(page.text()).not.toContain('Observed holiday')
    await page.unmount()
  })

  test('an invitation not yet answered says so, a declined one is dimmed and struck, a tentative one is italic', async () => {
    standInWorker()
    const { page } = await openTab()
    expect(row(page, 'Intro chat with Arun Mehta')?.querySelector('[data-testid="cal-response"]')?.textContent).toBe('Not answered')
    const declined = row(page, 'Fernway sync')
    expect(declined?.className).toContain('declined')
    expect(declined?.querySelector('[data-testid="cal-response"]')?.textContent).toBe('Declined')
    expect(row(page, 'Lunch with Dana')?.className).toContain('tentative')
    expect(row(page, 'Northfield Works standup')?.querySelector('[data-testid="cal-response"]')).toBeNull()
    await page.unmount()
  })

  test('more days can be asked for, and the agenda reads again with a longer span', async () => {
    standInWorker()
    const { page } = await openTab()
    const before = page.all('cal-day').length
    expect(page.q('cal-more')).not.toBeNull()
    await page.click(page.q('cal-more'))
    expect(page.all('cal-day').length).toBeGreaterThanOrEqual(before)
    await page.unmount()
  })

  test('with no account connected it says so and where to connect one; Check now is still there', async () => {
    const { calendar } = standInWorker('empty')
    calendar.accounts.length = 0
    calendar.calendars.length = 0
    const { page } = await openTab()
    expect(page.q('cal-no-accounts')?.textContent).toContain('Settings, Mailboxes')
    expect(page.q('cal-check')).not.toBeNull()
    await page.unmount()
  })

  test('a Meet that does not answer leaves Google’s events and says its meetings are not listed', async () => {
    standInWorker('1', { meet: false })
    const { page } = await openTab()
    expect(page.q('cal-meetings-missing')?.textContent).toContain('not listed')
    expect(row(page, 'Northfield Works standup')).toBeDefined()
    expect(page.all('cal-meeting')).toHaveLength(0)
    await page.unmount()
  })

  test('the calendar not answering is said in words, with a way to try again, and no event is invented', async () => {
    standInWorker('down')
    const { page } = await openTab()
    expect(page.q('say')?.textContent).toContain('Calendar could not be reached')
    expect(page.all('cal-event')).toHaveLength(0)
    await page.unmount()
  })

  test('Check now asks the calendar and says how many calendars it asked about', async () => {
    standInWorker()
    const { page } = await openTab()
    await page.click(page.q('cal-check'))
    expect(page.q('cal-checked')?.textContent).toContain('Asked Google about 5 calendars')
    await page.unmount()
  })
})

// ── The views: Week and Month ────────────────────────────────────────────────────────────────────────────────────────────

const ZONE = 'America/Los_Angeles'
const TODAY = dayKey(NOW, ZONE)

/** A phone, as `matchMedia` answers the tab's one question about width. Restored by the caller. */
function phone(on: boolean): () => void {
  const real = window.matchMedia
  window.matchMedia = ((query: string) => ({ matches: on && query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  return () => {
    window.matchMedia = real
  }
}

describe('the view and the day are in the address', () => {
  test('the choice of view is Agenda, Week and Month; each one writes itself to the address, and Agenda writes nothing', async () => {
    standInWorker()
    const { page, seen } = await openTab()
    expect(page.all('cal-day').length).toBeGreaterThan(0)
    expect(page.q('cal-view-agenda')?.getAttribute('aria-pressed')).toBe('true')
    await page.click(page.q('cal-view-week'))
    expect(seen.at(-1)).toBe('/calendar?view=week')
    expect(page.q('cal-week')).not.toBeNull()
    expect(page.q('cal-view-week')?.getAttribute('aria-pressed')).toBe('true')
    await page.click(page.q('cal-view-month'))
    expect(seen.at(-1)).toBe('/calendar?view=month')
    expect(page.q('cal-month')).not.toBeNull()
    await page.click(page.q('cal-view-agenda'))
    expect(seen.at(-1)).toBe('/calendar')
    expect(page.q('cal-agenda')).not.toBeNull()
    await page.unmount()
  })

  test('a reload on ?view=week&date=… draws that week, titled by its days', async () => {
    standInWorker()
    const { page } = await openTab('/calendar?view=week&date=2026-11-05')
    expect(page.q('calendar-tab')?.getAttribute('data-view')).toBe('week')
    expect(page.q('cal-range')?.textContent).toBe('Nov 1 to 7, 2026')
    expect(page.all('cal-week-day').map((d) => d.getAttribute('data-day'))).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'])
    await page.unmount()
  })

  test('Previous, Next and Today move the range, read the store for the new span, and Today is for when it is somewhere else', async () => {
    const { calendar } = standInWorker()
    const { page, seen } = await openTab('/calendar?view=week')
    expect(page.q<HTMLButtonElement>('cal-today')?.disabled).toBe(true)
    const first = page.all('cal-week-day').map((d) => d.getAttribute('data-day'))
    await page.click(page.q('cal-next'))
    expect(seen.at(-1)).toBe(`/calendar?view=week&date=${addDays(TODAY, 7)}`)
    expect(page.all('cal-week-day')[0]?.getAttribute('data-day')).toBe(addDays(first[0] as string, 7))
    const asked = calendar.calls.filter((c) => c.method === 'agenda').at(-1)?.args as number[]
    expect((asked[1] as number) - (asked[0] as number)).toBeGreaterThanOrEqual(7 * 24 * 3_600_000)
    await page.click(page.q('cal-prev'))
    await page.click(page.q('cal-prev'))
    expect(page.all('cal-week-day')[0]?.getAttribute('data-day')).toBe(addDays(first[0] as string, -7))
    expect(page.q<HTMLButtonElement>('cal-today')?.disabled).toBe(false)
    await page.click(page.q('cal-today'))
    expect(seen.at(-1)).toBe('/calendar?view=week')
    expect(page.all('cal-week-day')[0]?.getAttribute('data-day')).toBe(first[0] as string)
    await page.unmount()
  })

  test('Previous and Next step a month at a time in the Month, and the agenda by its length', async () => {
    standInWorker()
    const { page, seen } = await openTab('/calendar?view=month')
    const title = page.q('cal-range')?.textContent
    await page.click(page.q('cal-next'))
    expect(seen.at(-1)).toMatch(/^\/calendar\?view=month&date=\d{4}-\d{2}-01$/)
    expect(page.q('cal-range')?.textContent).not.toBe(title)
    // The day stays when the view changes: the agenda begins on the first of that month, and Next is two weeks on.
    const monthDay = new URLSearchParams(seen.at(-1)?.split('?')[1]).get('date') as string
    await page.click(page.q('cal-view-agenda'))
    expect(seen.at(-1)).toBe(`/calendar?date=${monthDay}`)
    await page.click(page.q('cal-next'))
    expect(seen.at(-1)).toBe(`/calendar?date=${addDays(monthDay, 14)}`)
    expect(page.all('cal-day')[0]?.getAttribute('data-day')).toBe(addDays(monthDay, 14))
    await page.unmount()
  })
})

describe('the week', () => {
  test('is a column a day with an all-day row, today lit and a line for now; events are blocks coloured by account', async () => {
    standInWorker()
    const { page } = await openTab('/calendar?view=week')
    expect(page.all('cal-week-col')).toHaveLength(7)
    expect(page.all('cal-week-day').filter((d) => d.className.includes('today'))).toHaveLength(1)
    expect(page.all('cal-week-col').filter((d) => d.className.includes('today'))).toHaveLength(1)
    expect(page.all('cal-now')).toHaveLength(1)
    expect(page.q('cal-allday')).not.toBeNull()
    const blocks = page.all('cal-block').filter((b) => b.getAttribute('data-kind') === 'event')
    expect(blocks.length).toBeGreaterThan(0)
    const hues = new Set(blocks.map((b) => /hue-\d/.exec(b.className)?.[0]))
    expect(hues.size).toBeGreaterThanOrEqual(2)
    await page.unmount()
  })

  test('things that overlap sit side by side, each with its share of the day’s width', async () => {
    standInWorker()
    // The day after tomorrow has Harbor Dental walkthrough, Design review and Quick sync together (10:00, 10:15 and 10:30).
    const day = addDays(TODAY, 2)
    const { page } = await openTab(`/calendar?view=week&date=${day}`)
    const col = page.all('cal-week-col').find((c) => c.getAttribute('data-day') === day) as HTMLElement
    const block = (t: string) => col.querySelector(`[data-testid="cal-block"][title^="${t}"]`) as HTMLElement | null
    const lefts = ['Harbor Dental walkthrough', 'Design review', 'Quick sync'].map((t) => block(t)?.style.left)
    expect(lefts.every((l) => l !== undefined)).toBe(true)
    expect(new Set(lefts).size).toBe(3)
    expect(block('Quick sync')?.style.width).toContain('33.3')
    await page.unmount()
  })

  test('a block opens the event’s card beside it, on an address that keeps the view; closing it comes back to the same week', async () => {
    standInWorker()
    const tomorrow = addDays(TODAY, 1)
    const { page, seen } = await openTab(`/calendar?view=week&date=${tomorrow}`)
    await page.click(page.all('cal-block').find((b) => b.getAttribute('title')?.startsWith('Weekly planning')) ?? null)
    expect(seen.at(-1)).toMatch(new RegExp(`^/calendar/event/.+\\?view=week&date=${tomorrow}$`))
    expect(page.q('cal-card')).not.toBeNull()
    expect(page.q('cal-week')).not.toBeNull()
    expect(page.q('cal-close')?.textContent).toContain('Week')
    await page.click(page.q('cal-close'))
    expect(seen.at(-1)).toBe(`/calendar?view=week&date=${tomorrow}`)
    expect(page.q('cal-card')).toBeNull()
    await page.unmount()
  })

  test('on a phone the week is three days from the chosen one and Previous and Next step by three', async () => {
    const restore = phone(true)
    try {
      standInWorker()
      // A date in the past for good: the address leaves the date out when it is today, so a date that could become today would make this fail on that day.
      const { page, seen } = await openTab('/calendar?view=week&date=2020-03-05')
      expect(page.all('cal-week-day').map((d) => d.getAttribute('data-day'))).toEqual(['2020-03-05', '2020-03-06', '2020-03-07'])
      expect(page.q('cal-range')?.textContent).toBe('Mar 5 to 7, 2020')
      await page.click(page.q('cal-next'))
      expect(seen.at(-1)).toBe('/calendar?view=week&date=2020-03-08')
      await page.unmount()
    } finally {
      restore()
    }
  })

  test('an event whose title is markup is drawn as the words it is, in the week and in the month', async () => {
    const { calendar } = standInWorker()
    const target = calendar.events.find((e) => e.title === 'Weekly planning')
    if (!target) throw new Error('no fixture event')
    target.title = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>'
    ;(globalThis as { __pwned?: number }).__pwned = undefined
    const { page } = await openTab(`/calendar?view=week&date=${addDays(TODAY, 1)}`)
    expect(page.text()).toContain('<img src=x')
    expect(document.querySelector('#root img')).toBeNull()
    expect(document.querySelector('#root script')).toBeNull()
    await page.click(page.q('cal-view-month'))
    expect(page.text()).toContain('<img src=x')
    expect(document.querySelector('#root img')).toBeNull()
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined()
    await page.unmount()
  })
})

describe('the month', () => {
  test('is whole weeks of days, today lit, each day’s events as chips coloured by account, and a crowded day cut to "+N more"', async () => {
    standInWorker()
    const crowded = addDays(TODAY, 3)
    const { page } = await openTab(`/calendar?view=month&date=${crowded}`)
    const cells = page.all('cal-month-day')
    expect(cells.length % 7).toBe(0)
    expect(cells.length).toBeGreaterThanOrEqual(28)
    expect(page.all('cal-month-week')).toHaveLength(cells.length / 7)
    const day = cells.find((c) => c.getAttribute('data-day') === crowded) as HTMLElement
    const count = Number(day.getAttribute('data-count'))
    expect(count).toBeGreaterThan(3)
    expect(day.querySelectorAll('[data-testid="cal-block"]')).toHaveLength(2)
    expect(day.querySelector('[data-testid="cal-day-more"]')?.textContent).toBe(`+${count - 2} more`)
    // Today is lit only when it is in the grid (the grid is the month the chosen day is in).
    const today = cells.find((c) => c.getAttribute('data-day') === TODAY)
    if (today) expect(today.className).toContain('today')
    await page.unmount()
  })

  test('a chip opens the event’s card, and a day (its number, "+N more" or the empty part of its cell) opens that week', async () => {
    standInWorker()
    const crowded = addDays(TODAY, 3)
    const { page, seen } = await openTab(`/calendar?view=month&date=${crowded}`)
    const day = () => page.all('cal-month-day').find((c) => c.getAttribute('data-day') === crowded) as HTMLElement
    await page.click(day().querySelector('[data-testid="cal-block"]'))
    expect(seen.at(-1)).toMatch(/^\/calendar\/event\/.+\?view=month&date=/)
    await page.click(page.q('cal-close'))
    await page.click(day().querySelector('[data-testid="cal-day-more"]'))
    expect(seen.at(-1)).toBe(`/calendar?view=week&date=${crowded}`)
    expect(page.q('cal-week')).not.toBeNull()
    await page.unmount()
  })

  test('on a phone a day is its number and a few dots, a tap chooses it, and its things are listed under the grid', async () => {
    const restore = phone(true)
    try {
      standInWorker()
      const crowded = addDays(TODAY, 3)
      const { page, seen } = await openTab(`/calendar?view=month&date=${crowded}`)
      const cell = () => page.all('cal-month-day').find((c) => c.getAttribute('data-day') === crowded) as HTMLElement
      expect(cell().querySelectorAll('.cal-dot').length).toBeGreaterThan(0)
      expect(cell().querySelector('[data-testid="cal-block"]')).toBeNull()
      expect(cell().getAttribute('aria-label')).toMatch(/things?$/)
      expect(page.q('cal-chosen')?.querySelector('[data-testid="cal-day"]')?.getAttribute('data-day')).toBe(crowded)
      expect(page.q('cal-chosen')?.textContent).toContain('Pipeline review')
      expect(cell().className).toContain('selected')
      // Another day is chosen by a tap on it.
      const other = addDays(TODAY, 1)
      await page.click(page.all('cal-month-day').find((c) => c.getAttribute('data-day') === other) ?? null)
      expect(seen.at(-1)).toBe(`/calendar?view=month&date=${other}`)
      expect(page.q('cal-chosen')?.textContent).toContain('Weekly planning')
      await page.click(page.q('cal-chosen')?.querySelector('[data-testid="cal-event"]') ?? null)
      expect(seen.at(-1)).toMatch(/^\/calendar\/event\/.+\?view=month&date=/)
      await page.unmount()
    } finally {
      restore()
    }
  })

  test('a span the store does not keep is drawn empty and says so', async () => {
    standInWorker()
    const { page } = await openTab(`/calendar?view=month&date=${addDays(TODAY, 400)}`)
    expect(page.q('cal-window-note')?.textContent).toContain('about 3 months back to 6 months ahead')
    expect(page.all('cal-block')).toHaveLength(0)
    await page.unmount()
  })
})

describe('a lapsed account', () => {
  test('is named in one amber sentence with a way to Settings, and its last events are marked as old', async () => {
    standInWorker('lapsed')
    const { page } = await openTab()
    const trouble = page.q('cal-trouble')
    expect(trouble?.textContent).toContain('tessa@ashgrove.example')
    expect(trouble?.textContent).toContain('Connect it again')
    expect(trouble?.querySelector('a')?.getAttribute('href')).toBe('/settings/calendars')
    const old = row(page, 'Ashgrove all-hands')
    expect(old?.className).toContain('stale')
    expect(old?.textContent).toContain('Old')
    expect(row(page, 'Northfield Works standup')?.className).not.toContain('stale')
    await page.unmount()
  })
})

describe('an event’s card', () => {
  test('opens from a row on the address, shows the place, the video call, who is invited and how they answered, and the notes, and closes back to the agenda', async () => {
    standInWorker()
    const { page, seen } = await openTab()
    await page.click(row(page, 'Intro chat with Arun Mehta') as HTMLElement)
    expect(seen.at(-1)).toMatch(/^\/calendar\/event\//)
    expect(page.q('cal-card-title')?.textContent).toBe('Intro chat with Arun Mehta')
    expect(page.q('cal-card-when')?.textContent).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+, \d+:\d\d (AM|PM) to \d+:\d\d (AM|PM) P[SD]T$/)
    expect(page.q('cal-card-where')?.textContent).toContain('Juniper Coffee')
    expect(page.q('cal-card-response')?.textContent).toContain('Not answered')
    expect(page.q('cal-card-notes')?.textContent).toContain('Ask what he would want a board to do')
    expect(page.q('cal-card-guests')?.textContent).toContain('Arun Mehta')
    expect(page.q('cal-card-guests')?.textContent).toContain('(you)')
    expect(page.q('cal-card-accounts')?.textContent).toContain('tessa@ashgrove.example')
    expect(page.q('cal-card-read')?.textContent).toContain('Read from Google')
    const google = page.q<HTMLAnchorElement>('cal-card-google')
    expect(google?.href.startsWith('https://www.google.com/calendar/')).toBe(true)
    expect(google?.rel).toContain('noopener')
    await page.click(page.q('cal-close'))
    expect(seen.at(-1)).toBe('/calendar')
    expect(page.q('cal-card')).toBeNull()
    await page.unmount()
  })

  test('a meeting on two calendars says both accounts, and a video call is a link that opens in a tab of its own', async () => {
    standInWorker()
    const { page } = await openTab()
    await page.click(row(page, 'Board call') as HTMLElement)
    expect(page.q('cal-card-accounts')?.textContent).toContain('northfield and ashgrove (the same meeting is on each)')
    const video = page.q('cal-card-video')?.querySelector('a') as HTMLAnchorElement
    expect(video.href).toBe('https://meet.google.com/xyz-board-call')
    expect(video.target).toBe('_blank')
    expect(video.rel).toContain('noopener')
    await page.unmount()
  })

  test('an event that has gone says so in the app’s words and offers the way back', async () => {
    standInWorker()
    const { page } = await openTab('/calendar/event/tessa%40northfield.example%7Cnope%7Cev9')
    expect(page.q('say')?.textContent).toContain('That event is gone')
    await page.unmount()
  })
})

describe('event text is untrusted', () => {
  const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><a href="javascript:alert(1)">click</a>'

  test('a title, a place, a guest’s name and notes that are markup are drawn as the words they are: nothing is made, nothing runs', async () => {
    const { calendar } = standInWorker()
    const target = calendar.events.find((e) => e.title === 'Northfield Works standup')
    if (!target) throw new Error('no fixture event')
    Object.assign(target, {
      title: HOSTILE,
      location: HOSTILE,
      description: HOSTILE,
      guests: [{ name: HOSTILE, email: 'x@example.com', response: 'accepted', organizer: false, self: false }],
      organizer: { name: HOSTILE, email: null },
    })
    ;(globalThis as { __pwned?: number }).__pwned = undefined
    const { page } = await openTab()
    const shown = row(page, '<img src=x')
    expect(shown?.textContent).toContain(HOSTILE)
    expect(document.querySelector('#root img')).toBeNull()
    expect(document.querySelector('#root script')).toBeNull()
    await page.click(shown as HTMLElement)
    expect(page.q('cal-card-title')?.textContent).toBe(HOSTILE)
    expect(page.q('cal-card-notes')?.querySelector('p')?.textContent).toBe(HOSTILE)
    expect(page.q('cal-card')?.querySelector('img, script')).toBeNull()
    // The only links in the card are the ones the app vouched for (https, and Google's own host for the event).
    for (const a of page.q('cal-card')?.querySelectorAll('a') ?? []) expect((a as HTMLAnchorElement).href).toMatch(/^https:\/\//)
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined()
    await page.unmount()
  })
})

describe('Settings, Calendars', () => {
  async function openSettings() {
    const { CalendarsSection } = await import('../src/client/CalendarsSettings')
    const seen: string[] = []
    const page = await mount((h) => h(CalendarsSection, { go: (p: string) => void seen.push(p) }) as never)
    return { page, seen }
  }

  test('one card per account with its calendars and a switch; the sentence for a lapsed one, and Connect again hinting that account to Google', async () => {
    standInWorker('lapsed')
    const { page } = await openSettings()
    const accounts = page.all('calendar-account')
    expect(accounts.map((a) => [a.getAttribute('data-account'), a.getAttribute('data-state')])).toEqual([
      ['tessa@northfield.example', 'live'],
      ['tessa@ashgrove.example', 'lapsed'],
      ['tessa_marlow@gmail.com', 'needs-calendar'],
      ['tessa.marlow@fernway.example', 'live'],
    ])
    expect(accounts[0]?.querySelectorAll('[data-testid="calendar-row"]')).toHaveLength(3)
    const shown = [...(accounts[0]?.querySelectorAll('[data-testid="calendar-row"]') ?? [])].map((r) => [r.textContent?.includes('Holidays'), r.getAttribute('data-shown')])
    expect(shown).toEqual([[false, 'true'], [false, 'true'], [true, 'false']])
    expect(accounts[1]?.querySelector('[data-testid="calendar-reason"]')?.textContent).toContain('Connect it again')
    expect(accounts[1]?.querySelector('a[data-testid="calendar-connect-again"]')?.getAttribute('href')).toBe('/api/inbox/gmail/start?account=mb-ashgrove')
    // MAIL IS NEVER HELD BEHIND A CALENDAR CONSENT: Connect again is the mailboxes' own sign-in (no purpose named), and an account connected for mail without the calendar permission has a button of its own, Connect calendar, whose
    // sign-in asks for that one permission incrementally.
    expect(accounts[1]?.querySelector('a[data-testid="calendar-connect-again"]')?.getAttribute('href')).not.toContain('for=')
    const needs = accounts[2]
    expect(needs?.querySelector('[data-testid="calendar-reason"]')?.textContent).toContain('Press Connect calendar')
    expect(needs?.querySelector('a[data-testid="calendar-connect"]')?.getAttribute('href')).toBe('/api/inbox/gmail/start?for=calendar')
    expect(needs?.querySelector('[data-testid="calendar-connect-again"]')).toBeNull()
    expect(needs?.querySelectorAll('[data-testid="calendar-row"]')).toHaveLength(0)
    // A live account has nothing to connect.
    expect(accounts[0]?.querySelector('[data-testid="calendar-connect-again"]')).toBeNull()
    expect(accounts[0]?.querySelector('[data-testid="calendar-connect"]')).toBeNull()
    // An account that reads but was connected before the permission to change events was asked for says so once, in a hint with a link to Connect calendar; accounts that can edit say nothing, and the hint is not the button.
    const hint = accounts[3]?.querySelector('[data-testid="calendar-events-hint"]')
    expect(hint?.textContent).toContain('Editing events needs Connect calendar again')
    expect(hint?.querySelector('a')?.getAttribute('href')).toBe('/api/inbox/gmail/start?for=calendar')
    expect(accounts[3]?.querySelector('[data-testid="calendar-connect"]')).toBeNull()
    expect(accounts[0]?.querySelector('[data-testid="calendar-events-hint"]')).toBeNull()
    expect(needs?.querySelector('[data-testid="calendar-events-hint"]')).toBeNull()
    // There is no Disconnect here: one permission serves mail and calendar, and removing an account is Mailboxes'.
    expect(page.text()).not.toMatch(/Disconnect\b(?! in)/)
    expect(page.text()).toContain('use Disconnect in')
    await page.unmount()
  })

  test('switching a calendar on shows it and says so; switching it off drops its events', async () => {
    const { calendar } = standInWorker()
    const { page } = await openSettings()
    const holidays = page.all('calendar-row').find((r) => r.textContent?.includes('Holidays')) as HTMLElement
    await page.click(holidays.querySelector('[data-testid="calendar-switch"]'))
    expect(calendar.calendars.find((c) => c.name.startsWith('Holidays'))?.shown).toBe(true)
    expect(page.q('done')?.textContent).toContain('It is shown now')
    const again = page.all('calendar-row').find((r) => r.textContent?.includes('Holidays')) as HTMLElement
    await page.click(again.querySelector('[data-testid="calendar-switch"]'))
    expect(calendar.calendars.find((c) => c.name.startsWith('Holidays'))?.shown).toBe(false)
    expect(page.q('done')?.textContent).toContain('hidden now')
    await page.unmount()
  })

  test('Connect calendar hints the account to Google when the inbox lists it', async () => {
    standInWorker('lapsed', { gmail: [{ id: 'mb-homemail', address: 'tessa_marlow@gmail.com', name: 'tessa_marlow', connected: true, state: 'live' }] })
    const { page } = await openSettings()
    const needs = page.all('calendar-account').find((a) => a.getAttribute('data-state') === 'needs-calendar')
    expect(needs?.querySelector('a[data-testid="calendar-connect"]')?.getAttribute('href')).toBe('/api/inbox/gmail/start?account=mb-homemail&for=calendar')
    await page.unmount()
  })

  test('Check now asks for every calendar to be read again', async () => {
    standInWorker()
    const { page } = await openSettings()
    await page.click(page.q('calendar-sync'))
    expect(page.q('done')?.textContent).toContain('Asked Google about 5 calendars')
    await page.unmount()
  })

  test('with no account it says where to connect one', async () => {
    const { calendar } = standInWorker()
    calendar.accounts.length = 0
    calendar.calendars.length = 0
    const { page } = await openSettings()
    expect(page.q('calendar-none')?.textContent).toContain('Mailboxes')
    await page.unmount()
  })
})
