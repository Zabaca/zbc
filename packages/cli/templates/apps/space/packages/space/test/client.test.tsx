// What a person sees: the five tabs, the one they are on, and an honest empty tab. Rendered to markup from the same `Me`
// the Worker sends (meOf), so a change to the layer's tabs shows here.
import { beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { lane, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { Space } from '../src/client/App'
import { tabAt } from '../src/client/route'

const TESSA = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
const view = (pathname: string, me = TESSA) => renderToStaticMarkup(<Space me={me} pathname={pathname} go={() => undefined} />)

/** The tabs as drawn: their text, their address and whether the page is marked as being on them. */
function tabsIn(html: string) {
  return [...html.matchAll(/<a href="(\/[a-z]+)" class="rail-item( on)?"([^>]*)data-tab="([a-z]+)"[^>]*>.*?<span class="rail-label">([^<]+)<\/span>/g)].map((m) => [m[5], m[1], m[2] ? 'on' : '', m[3]?.includes('aria-current="page"') ? 'page' : ''])
}

describe('the tabs of an install that has every part', () => {
  test('are Today, Inbox, Meet, Calendar, Forms, People and Knowledge, in that order, on every screen', () => {
    for (const path of ['/today', '/inbox', '/meet', '/calendar', '/forms', '/people', '/knowledge']) {
      expect(tabsIn(view(path)).map((t) => t[0])).toEqual(['Today', 'Inbox', 'Meet', 'Calendar', 'Forms', 'People', 'Knowledge'])
    }
  })

  test('mark the one the address is on, for the screen reader as well as the eye', () => {
    expect(tabsIn(view('/forms'))).toEqual([
      ['Today', '/today', '', ''],
      ['Inbox', '/inbox', '', ''],
      ['Meet', '/meet', '', ''],
      ['Calendar', '/calendar', '', ''],
      ['Forms', '/forms', 'on', 'page'],
      ['People', '/people', '', ''],
      ['Knowledge', '/knowledge', '', ''],
    ])
  })

  test('the space opens on Today, also where the Worker’s redirect was bypassed', () => {
    expect(tabsIn(view('/')).find((t) => t[2] === 'on')?.[0]).toBe('Today')
    expect(tabAt('/', TESSA.tabs, TESSA.home)).toBe('today')
  })

  test('a path under a tab is on that tab, and a path under none is not found, with a way back to Today', () => {
    expect(tabAt('/inbox/ana', TESSA.tabs, TESSA.home)).toBe('inbox')
    expect(tabAt('/meet/chat%3Achannel%3A21', TESSA.tabs, TESSA.home)).toBe('meet')
    expect(tabAt('/inboxx', TESSA.tabs, TESSA.home)).toBeNull()
    expect(tabAt('/conversations/ana', TESSA.tabs, TESSA.home)).toBeNull()
    const lost = view('/nowhere')
    expect(lost).toContain('Not found')
    expect(lost).toContain('Go to Today')
    expect(tabsIn(lost).some((t) => t[2] === 'on')).toBe(false)
  })

  test('are the company’s own, under its own name', () => {
    const l = meOf({ address: 'lane@pinecrest.test', name: 'Lane' }, lane())
    const html = view('/today', l)
    expect(html).toContain('Pinecrest Test')
    expect(html).toContain('>L<')
  })
})

describe('the Forms tab', () => {
  // The tab's screens are loaded when it is first opened (App.tsx, `lazy`), so a first render may show the fallback ("Opening Forms"); this renders once to ask for them and waits until they are there.
  beforeAll(async () => {
    view('/forms')
    await import('../src/client/forms/FormsTab')
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  test('is forms’ screens drawn in the space’s own page: no frame, no empty state, no link out to forms.northfield.example', () => {
    const html = view('/forms')
    expect(html).not.toContain('<iframe')
    expect(html).toContain('data-testid="forms-tab"')
    expect(html).not.toContain('empty-forms')
    expect(html).not.toContain('Open Forms')
    expect(html).not.toContain('forms.northfield.example')
    // The tabs are still drawn beside it, with Forms marked.
    expect(tabsIn(html).find((t) => t[2] === 'on')?.[0]).toBe('Forms')
  })

  test('has its sections as a tree under the Forms tab in the rail, and as a row across the top of the screen for a phone, the current one marked in both', () => {
    for (const [path, current] of [['/forms', 'Clients'], ['/forms/clients/new', 'Clients'], ['/forms/envelopes', 'Envelopes'], ['/forms/envelopes/2b1c0f3e-0000-4000-8000-000000000001/answers', 'Envelopes'], ['/forms/send', 'Envelopes'], ['/forms/forms', 'Forms'], ['/forms/documents', 'Documents'], ['/forms/seal', 'Seal'], ['/forms/history', 'History']] as const) {
      const html = view(path)
      const tree = [...html.matchAll(/<a href="(\/forms[^"]*)" class="t-item( on)?"[^>]*data-testid="forms-section"[^>]*><span class="t-label">([^<]+)<\/span>/g)].map((m) => [m[3], m[1], m[2] ? 'on' : ''])
      expect(tree.map((t) => t[0]), path).toEqual(['Clients', 'Envelopes', 'Forms', 'Documents', 'Seal', 'History'])
      expect(tree.filter((t) => t[2] === 'on').map((t) => t[0]), path).toEqual([current])
      const row = [...html.matchAll(/<a href="(\/forms[^"]*)" class="forms-section( on)?"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[3], m[2] ? 'on' : ''])
      expect(row.filter((t) => t[1] === 'on').map((t) => t[0]), path).toEqual([current])
    }
  })

  test('no tab is a frame on another page', () => {
    for (const path of ['/today', '/inbox', '/meet', '/forms', '/forms/envelopes', '/people']) expect(view(path)).not.toContain('<iframe')
  })

  test('draws the screen the address names, and says so plainly for one that is none', () => {
    expect(view('/forms')).toContain('Loading')
    expect(view('/forms/nonsense')).toContain('There is nothing at this address.')
    expect(view('/forms/envelopes/not-an-id')).toContain('There is nothing at this address.')
  })

  test('the tree is under Forms only while Forms is the page', () => {
    for (const path of ['/today', '/inbox', '/meet', '/people', '/settings']) expect(view(path)).not.toContain('forms-tree')
  })
})

describe('the empty tabs say so', () => {
  test('Today does not claim that nothing needs you before its answer has come: it says it is loading (what it shows once it has is test/today-view.test.tsx)', () => {
    const html = view('/today')
    expect(html).toContain('data-testid="loading"')
    expect(html).not.toContain('Nothing needs you')
    expect(html).not.toContain('empty-today')
  })

  test('the Inbox does not claim there is nothing in it before the list has come: it says it is loading', () => {
    const html = view('/inbox')
    expect(html).toContain('data-testid="loading"')
    expect(html).not.toContain('data-testid="empty-conversations"')
    expect(html).not.toContain('<iframe')
  })

  test('People does not claim no one is listed before the list has come: it says it is loading', () => {
    const html = view('/people')
    expect(html).toContain('data-testid="loading"')
    expect(html).not.toContain('data-testid="empty-people"')
  })

  test('the signed-in person is named at the foot of the tabs', () => {
    expect(view('/today')).toContain('Tessa')
  })

  test('there is no bar of links to the other apps beside the tabs', () => {
    const rail = /<nav class="rail".*?<\/nav>/s.exec(view('/today'))?.[0] ?? ''
    expect(rail).not.toContain('inbox.northfield.example')
    expect(rail).not.toContain('forms.northfield.example')
    expect(rail).not.toContain('meet.northfield.example')
    // The seven tabs, and the space's own Settings (at the foot of the rail on a computer, the gear in the strip on a phone): nothing else.
    expect([...rail.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1])).toEqual(['/today', '/inbox', '/meet', '/calendar', '/forms', '/people', '/knowledge', '/settings', '/settings'])
  })
})
