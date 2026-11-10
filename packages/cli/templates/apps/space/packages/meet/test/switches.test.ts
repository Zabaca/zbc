// Calls and the phone are switches any install may turn on. Meet reads them: it refuses to make a call and answers none of the call API where `calls` is off,
// and has no phone (no Telnyx, no dial pad, no Phone conversation, no webhook) where `phone` is off. Run on an invented company with each switch off and on; Northfield's, where both are on, is every other suite here.
import { describe, expect, test } from 'bun:test'
import { createInstall, type Install, type SignedIn } from '@space/workspace'
import { createGuestApp } from '../src/space-guests'
import { CALL_API } from '../src/model'
import { CALLS_OFF, PHONE_OFF, type SpaceMeetDeps, spaceMeet } from '../src/space-meet'
import { type MeetPartEnv, partDepsFor } from '../src/wiring'
import { harness, signedAs } from './helpers'

const BASE = {
  company: { id: 'brightwater', name: 'Brightwater Marine Services', domain: 'brightwater.example', timeZone: 'America/Los_Angeles' },
  access: { teamDomain: 'brightwater.cloudflareaccess.com' },
  formsService: { contact: 'help@example.test' },
  space: { host: 'space.brightwater.example', sessionDuration: '730h' },
  people: [
    { address: 'priya@brightwater.example', name: 'Priya', role: 'owner' },
    { address: 'omar@brightwater.example', name: 'Omar', role: 'member' },
  ],
}
const PRIYA = 'priya@brightwater.example'
/** Nothing on: no calls, no phone. */
const OFF = createInstall(BASE)
/** Calls and the phone on, the phone declared for Priya on the line. */
const ON = createInstall({ ...BASE, phone: { people: { [PRIYA]: { emergencyNumber: 'line' } } }, switches: { calls: true, phone: true } })

async function setup(install: Install) {
  const h = await harness({ devBypass: false, install })
  const deps: SpaceMeetDeps = {
    install,
    workspace: h.deps.workspace,
    room: h.deps.room,
    ledger: h.deps.ledger,
    appOrigin: h.deps.appOrigin,
    mailer: h.deps.mailer,
    now: () => h.clock.now,
    randomBytes: h.deps.randomBytes,
  }
  const meet = spaceMeet(deps)
  const as = async (email: string): Promise<SignedIn> => signedAs(install, email, Math.floor(h.clock.now / 1000) + 3600)
  const key = (what: string) => `${what}-key`.padEnd(24, 'x')
  return { h, meet, as, key }
}

const said = (r: unknown) => r as { ok: boolean; kind?: string; reason?: string; message?: string; value?: unknown }

describe('calls', () => {
  test('where the switch is off, meet makes none: a huddle, a call link and a meeting are each refused in words, and nothing is made', async () => {
    const s = await setup(OFF)
    const who = await s.as(PRIYA)
    const refused = { ok: false, kind: 'refused', reason: 'not-found', message: CALLS_OFF }
    expect(said(await s.meet.startHuddle(who, { key: s.key('h'), conversationId: 1 } as never))).toMatchObject(refused)
    expect(said(await s.meet.startCall(who, { key: s.key('c') } as never))).toMatchObject(refused)
    expect(said(await s.meet.bookMeeting(who, { key: s.key('m'), title: 'Walk-through', startsAt: s.h.clock.now + 3_600_000, home: 'omar@brightwater.example' } as never))).toMatchObject(refused)
    expect([...s.h.cores.keys()]).toEqual([])
    expect(await s.meet.liveCalls(who)).toMatchObject({ ok: true, value: [] })
  })

  test('where it is on, a call link is made on the install’s own address', async () => {
    const s = await setup(ON)
    const made = said(await s.meet.startCall(await s.as(PRIYA), { key: s.key('c') } as never))
    expect(made, JSON.stringify(made)).toMatchObject({ ok: true })
    expect(String((made.value as { link: string }).link)).toMatch(/^https?:\/\/[^/]+\/r\//)
  })

  test('the guests’ call API answers none where the switch is off, and the lobby of a call where it is on', async () => {
    const live = await setup(ON)
    const name = await live.h.startCall()
    const closed = await setup(OFF)
    const nameOff = await closed.h.startCall()
    const ask = (h: Awaited<ReturnType<typeof setup>>['h'], install: Install, n: string) =>
      createGuestApp(() => ({ ...h.deps, install })).request(`https://${install.declaration.space.host}${CALL_API}/rooms/${n}`, { method: 'GET' })
    expect((await ask(live.h, ON, name)).status).toBe(200)
    const refused = await ask(closed.h, OFF, nameOff)
    expect(refused.status).toBe(404)
    expect(await refused.json()).toEqual({ error: 'Not found' })
  })
})

describe('the phone', () => {
  test('where the switch is off nobody has the dial pad, though the phone list names them; where it is on the person it names has it', async () => {
    const off = await setup(OFF)
    off.h.phonePeople[PRIYA] = { emergencyNumber: 'line' }
    expect(off.h.phoneCore.eligible(PRIYA)).toBe(false)
    const on = await setup(ON)
    on.h.phonePeople[PRIYA] = { emergencyNumber: 'line' }
    expect(on.h.phoneCore.eligible(PRIYA)).toBe(true)
    expect(on.h.phoneCore.eligible('omar@brightwater.example')).toBe(false)
  })

  test('the declaration’s phone list is who has the pad when the core is given none of its own', async () => {
    const s = await setup(ON)
    const { PhoneCore } = await import('../src/phone')
    const core = new PhoneCore(s.h.workspaceSql, () => ON)
    expect(core.eligible(PRIYA)).toBe(true)
    expect(core.emergencyNumber(PRIYA)).toBe('line')
    expect(new PhoneCore(s.h.workspaceSql, () => OFF).eligible(PRIYA)).toBe(false)
  })

  test('the Phone conversation and its read are refused where the switch is off, and the overview shows no Phone row', async () => {
    const off = await setup(OFF)
    const who = await off.as(PRIYA)
    expect(said(await off.meet.phoneConversation(who))).toMatchObject({ ok: false, reason: 'not-found', message: PHONE_OFF })
    expect(said(await off.meet.phoneRead(who, 1))).toMatchObject({ ok: false, reason: 'not-found', message: PHONE_OFF })
    expect(((await off.meet.conversations(who)) as { value: { phone: unknown } }).value.phone).toBeNull()
    const on = await setup(ON)
    expect(said(await on.meet.phoneConversation(await on.as(PRIYA)))).toMatchObject({ ok: true })
  })

  test('the Worker has no Telnyx where the switch is off, whatever secrets it holds', () => {
    const env = {
      ROOMS: {},
      WORKSPACE: {},
      TELNYX_API_KEY: 'KEY0123',
      TELNYX_PUBLIC_KEY: 'A'.repeat(43),
      TELNYX_CONNECTION_ID: '1234',
      TELNYX_NUMBER: '+16265550100',
    } as unknown as MeetPartEnv
    expect(partDepsFor(env, 'https://space.brightwater.example/', OFF).phone).toBeNull()
    expect(partDepsFor(env, 'https://space.brightwater.example/', ON).phone).not.toBeNull()
  })
})
