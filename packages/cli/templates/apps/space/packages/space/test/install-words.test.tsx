// Addresses, senders and names come from the install: what the page is told of them (GET /api/me), the installed app's name, and
// the screens that say them. Northfield's words are held by the suites that run on Northfield's declaration (app.test.ts, chat-dom.test.tsx, channels-dom.test.tsx, wrangler.test.ts); this one runs the same screens in an
// invented company's shell and proves "Northfield Works", "Tessa" and northfield.example are said nowhere in them.
import { describe, expect, test } from 'bun:test'
import { createInstall } from '@space/workspace'
import { renderToStaticMarkup } from 'react-dom/server'
import { northfield } from '../../workspace/test/helpers'
import { meOf, namedManifest } from '../src/app'
import { privacyNote } from '../src/client/ChatSettings'
import { tagOf } from '../src/client/Channels'
import { notSetUp } from '../src/client/PhonePane'
import { browserTexts } from '../src/client/Notifications'
import { Preview } from '../src/client/forms/ClientForm'
import { NewMessageView } from '../src/client/NewMessage'
import { newCompose } from '../src/client/compose'
import { shellOf } from './northfield-shell'

const BRIGHTWATER = createInstall({
  company: { id: 'brightwater', name: 'Brightwater Builders', domain: 'brightwater.example', timeZone: 'America/Chicago' },
  access: { teamDomain: 'brightwater.cloudflareaccess.com' },
  space: { host: 'space.brightwater.example', sessionDuration: '730h' },
  senders: { forms: 'signing@brightwater.example', meet: 'chat@brightwater.example' },
  formsService: { name: 'Brightwater Sign', contact: 'office@brightwater.example', runBy: { name: 'Brightwater', legalName: 'Brightwater Builders Inc.' } },
  people: [{ address: 'ada@brightwater.example', name: 'Ada', mailName: 'Ada Brightwater', role: 'owner' }],
})
const NORTHFIELD = /northfield|tessa/i
const me = meOf({ address: 'ada@brightwater.example', name: 'Ada' }, BRIGHTWATER)
const html = (node: React.ReactNode) => renderToStaticMarkup(shellOf(me, node))

describe('what the page is told of the install’s names', () => {
  test('the company, the host, the senders and the signing service are the install’s', () => {
    expect(me.company.name).toBe('Brightwater Builders')
    expect(me.origin).toBe('https://space.brightwater.example/')
    expect(me.senders).toEqual({ forms: 'signing@brightwater.example', meet: 'chat@brightwater.example' })
    expect(me.forms).toEqual({ service: 'Brightwater Sign', sender: 'signing@brightwater.example', runBy: 'Brightwater' })
    expect(JSON.stringify(me)).not.toMatch(NORTHFIELD)
    expect(meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield()).forms).toEqual({ service: 'Northfield Forms', sender: 'forms@northfield.example', runBy: 'Northfield Works' })
  })
})

describe('the installed app takes the company’s name', () => {
  const asset = () => new Response(JSON.stringify({ id: '/', name: 'Space', short_name: 'Space', icons: [] }), { headers: { 'content-type': 'application/manifest+json', 'content-length': '60' } })
  const nameOf = async (res: Response) => ((await res.json()) as { name: string; short_name: string }).name

  test('"<company> Space", on Northfield’s as "Northfield Works Space", with everything else of the manifest as it was', async () => {
    const z = await namedManifest('https://space.northfield.example/manifest.webmanifest', asset(), northfield())
    expect(await nameOf(z)).toBe('Northfield Works Space')
    const b = await namedManifest('https://space.brightwater.example/manifest.webmanifest', asset(), BRIGHTWATER)
    expect(await b.clone().json()).toEqual({ id: '/', name: 'Brightwater Builders Space', short_name: 'Space', icons: [] })
    expect(b.headers.get('content-type')).toBe('application/manifest+json')
    expect(b.headers.get('content-length')).toBeNull()
  })

  test('any other file, a missing manifest and a manifest that is not JSON are passed on as they are', async () => {
    const page = new Response('<html>', { headers: { 'content-type': 'text/html' } })
    expect(await namedManifest('https://space.brightwater.example/today', page, BRIGHTWATER)).toBe(page)
    const missing = new Response('no', { status: 404 })
    expect(await namedManifest('https://space.brightwater.example/manifest.webmanifest', missing, BRIGHTWATER)).toBe(missing)
    const odd = new Response('<html>stand-in</html>')
    expect(await (await namedManifest('https://space.brightwater.example/manifest.webmanifest', odd, BRIGHTWATER)).text()).toBe('<html>stand-in</html>')
  })
})

describe('the screens that say the company, the senders and the service, in another company’s shell', () => {
  test('a teammate is tagged with the company’s name, a guest as a guest', () => {
    expect(tagOf({ kind: 'teammate' }, 'Brightwater Builders')).toBe('Brightwater Builders')
    expect(tagOf({ kind: 'guest' }, 'Brightwater Builders', true)).toBe('Invited')
    expect(html(<NewMessageView people={[{ person: { id: 'p1', name: 'Bo', kind: 'teammate', address: 'bo@brightwater.example' } } as never]} q="" onQ={() => undefined} to={null} onPick={() => undefined} compose={newCompose(() => 'k')} onText={() => undefined} onSend={() => undefined} onClose={() => undefined} />)).toContain('Brightwater Builders')
  })

  test('the chat’s privacy note names the company and the owner, and says nothing of Northfield’s', () => {
    const note = privacyNote(me.company.name, me.owner)
    const text = note.map((p) => `${p.lead} ${p.body}`).join('\n')
    expect(text).toContain('Brightwater Builders people can see who is in the channels they are in.')
    expect(text).toContain('ask Ada at ada@brightwater.example.')
    expect(text).toContain('Brightwater Builders runs meet on Cloudflare')
    expect(text).not.toMatch(NORTHFIELD)
  })

  test('the phone and the notifications name the company and the host they are in', () => {
    expect(notSetUp('Brightwater Builders')).toContain('from the Brightwater Builders number')
    expect(browserTexts('space.brightwater.example').blocked).toContain('site settings for space.brightwater.example')
    for (const s of Object.values(browserTexts('space.brightwater.example'))) expect(s).not.toMatch(NORTHFIELD)
  })

  test('a client’s signing preview shows the email as it will come: from the install’s sender, via the install’s service', () => {
    const out = html(<Preview name="Harbor Co" accent="#1f4e79" replyTo="office@harbor.example" />)
    expect(out).toContain('Harbor Co via Brightwater Sign &lt;signing@brightwater.example&gt;')
    expect(out).toContain('via Brightwater Sign')
    expect(out).not.toMatch(NORTHFIELD)
  })
})

describe('where the install’s Forms sends only for its own company (formsService.ownCompanyOnly)', () => {
  const OWN = createInstall({ ...(BRIGHTWATER.declaration as object), formsService: { name: 'Brightwater Sign', contact: 'office@brightwater.example', ownCompanyOnly: true } })
  const ownMe = meOf({ address: 'ada@brightwater.example', name: 'Ada' }, OWN)

  test('the page is told so, and only then', () => {
    expect(ownMe.forms).toEqual({ service: 'Brightwater Sign', sender: 'signing@brightwater.example', runBy: 'Brightwater Builders', ownCompanyOnly: true })
    expect('ownCompanyOnly' in me.forms).toBe(false)
    expect('ownCompanyOnly' in meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield()).forms).toBe(false)
  })

  test('a client’s signing preview shows no “via”, in the From line or under the name', () => {
    const out = renderToStaticMarkup(shellOf(ownMe, <Preview name="Brightwater Builders" accent="#1f4e79" replyTo="ada@brightwater.example" />))
    expect(out).toContain('Brightwater Builders &lt;signing@brightwater.example&gt;')
    expect(out).not.toMatch(/\bvia\b/)
  })
})
