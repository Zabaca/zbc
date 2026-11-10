// Addresses, senders and names come from the install, in meet's words. Northfield's are held by the suites that run on Northfield's
// declaration (space-channels.test.ts, workspace.test.ts, phone.test.ts: "meet@northfield.example", "Northfield's chat", "Only Northfield Works people can do that."); this one runs the same on an invented company and proves
// "Northfield Works", "Tessa" and northfield.example are said nowhere: not in a refusal, an email, the sender or the link, and the guests' pages are told whose workspace they are in.
import { describe, expect, test } from 'bun:test'
import { createInstall } from '@space/workspace'
import { balanceEmail, capEmail, codeEmail, emergencyEmail, inviteEmail, nudgeEmail, senderOf, voicemailEmail } from '../src/mail'
import { appOriginOf } from '../src/wiring'
import { harness } from './helpers'
import { W } from './workspace.helpers'

const BRIGHTWATER = createInstall({
  company: { id: 'brightwater', name: 'Brightwater Builders', domain: 'brightwater.example', timeZone: 'America/Chicago' },
  access: { teamDomain: 'brightwater.cloudflareaccess.com' },
  formsService: { contact: 'help@example.test' },
  space: { host: 'space.brightwater.example', sessionDuration: '730h' },
  senders: { forms: 'signing@brightwater.example', meet: 'chat@brightwater.example' },
  people: [
    { address: 'ada@brightwater.example', name: 'Ada', mailName: 'Ada Brightwater', role: 'owner' },
    { address: 'omar@brightwater.example', name: 'Omar', role: 'member' },
  ],
})
const NORTHFIELD = /northfield|tessa/i
const ADA = 'ada@brightwater.example'
const OMAR = 'omar@brightwater.example'

describe('the links and the sender are the install’s', () => {
  test('every link meet makes is on the install’s space host, and mail goes from the install’s meet sender', () => {
    expect(appOriginOf(BRIGHTWATER)).toBe('https://space.brightwater.example')
    expect(senderOf(BRIGHTWATER)).toEqual({ email: 'chat@brightwater.example', name: 'meet' })
    // With nothing declared the sender is the company's own meet@.
    const quiet = createInstall({ company: { id: 'q', name: 'Quiet Co', domain: 'quiet.example', timeZone: 'America/Chicago' }, access: { teamDomain: 'example.cloudflareaccess.com' }, formsService: { contact: 'help@example.test' }, space: { host: 'space.quiet.example', sessionDuration: '730h' }, people: [{ address: 'q@quiet.example', name: 'Q', role: 'owner' }] })
    expect(senderOf(quiet).email).toBe('meet@quiet.example')
  })

  test('every email names the company and the space, never Northfield’s', () => {
    const origin = appOriginOf(BRIGHTWATER)
    const due = { person: 'p1', email: 'guest@harbor.example', kind: 'guest', total: 2, senders: [{ name: 'Ana', count: 2 }] } as never
    const mails = [
      codeEmail('gus@harbor.example', '123456', BRIGHTWATER),
      inviteEmail('gus@harbor.example', 'Omar', 'dock', origin, BRIGHTWATER),
      nudgeEmail(due, origin, BRIGHTWATER),
      nudgeEmail({ ...(due as object), kind: 'teammate' } as never, origin, BRIGHTWATER),
      emergencyEmail({ name: 'Omar', email: OMAR, address: '1 Main St', at: Date.UTC(2026, 10, 3, 12, 0) } as never, BRIGHTWATER, ADA),
      emergencyEmail({ name: 'Someone', email: null, address: null, at: Date.UTC(2026, 10, 3, 12, 0) } as never, BRIGHTWATER, ADA),
      capEmail(80, 800, 1000, ADA, BRIGHTWATER),
      balanceEmail(4.5, ADA, BRIGHTWATER),
      voicemailEmail(ADA, '+1 312 555 0100', 42, BRIGHTWATER),
    ]
    for (const m of mails) {
      expect(m.from, m.subject).toEqual({ email: 'chat@brightwater.example', name: 'meet' })
      expect(`${m.subject}\n${m.text}`, m.subject).not.toMatch(NORTHFIELD)
    }
    expect(mails[1]?.text).toContain("on meet, Brightwater Builders's chat.")
    expect(mails[1]?.text).toContain('https://space.brightwater.example/w/')
    expect(mails[3]?.text).toContain('https://space.brightwater.example/meet')
    expect(mails[8]?.text).toContain('left on the Brightwater Builders number')
    expect(mails[8]?.text).toContain('for Brightwater Builders people who are signed in')
  })
})

describe('on another company’s install, through the workspace', () => {
  test('a refusal and a close reason name the company, never Northfield Works', async () => {
    const h = await harness({ devBypass: false, install: BRIGHTWATER })
    // An address that is neither on the install's list nor a guest is refused in the company's name.
    const jwt = await h.access.sign({ email: 'stranger@elsewhere.example' })
    const refused = await h.callTeammate('GET', `https://meet.test${W}/bootstrap`, undefined, { headers: { 'cf-access-jwt-assertion': jwt } })
    expect(JSON.stringify(refused.json)).not.toMatch(NORTHFIELD)
  })

  test('the guests’ pages are told whose workspace they are in, with the owner’s name and no address, before anybody signs in', async () => {
    const h = await harness({ devBypass: false, install: BRIGHTWATER })
    const site = await h.call('GET', 'https://space.brightwater.example/w/api/site')
    expect(site.status).toBe(200)
    expect(site.json).toEqual({ company: 'Brightwater Builders', owner: { name: 'Ada' } })
    expect(JSON.stringify(site.json)).not.toContain('@')
  })

  test('the signed-in bootstrap names the company and the owner, with the owner’s address, for a teammate and a guest alike', async () => {
    const h = await harness({ devBypass: false, install: BRIGHTWATER })
    const jwt = await h.access.sign({ email: OMAR })
    const boot = await h.callTeammate('GET', `https://meet.test${W}/bootstrap`, undefined, { headers: { 'cf-access-jwt-assertion': jwt } })
    expect(boot.status).toBe(200)
    expect(boot.json.site).toEqual({ company: 'Brightwater Builders', owner: { name: 'Ada', address: ADA } })
  })
})
