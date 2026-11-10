// The first seam for the phone's calls in (docs/adr/0005): the Worker's HTTP API at its doors, with the real phone core over
// in-memory SQLite and a fake Telnyx that records what it was asked. What rings and in what order, who takes a call, what the
// caller ends up with (a voicemail, a missed call), who sees and hears it, what is counted. Nothing here checks how the core
// stores things; the one test that does is the migration.
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { runCron } from '../src/cron'
import { LINE } from '../src/phone-line'
import { PHONE_ADDITIONS, PHONE_TABLES, PhoneCore, STALE_CALL_MS, VOICEMAIL_DEADLINE_MS } from '../src/phone'
import { parseDestination } from '../src/phone-model'
import { WS_SCHEMA, WorkspaceCore } from '../src/workspace'
import { ANA, BEN, LINE_NUMBER, OWNER, harness, installFor } from './helpers'
import { PHONE_V1 } from './old-schemas'
import { type Actors, G, W, actors } from './workspace.helpers'

type H = Awaited<ReturnType<typeof harness>>
let h: H
let a: Actors

const P = '/phone'
const CALLER = '+12135550199'
const ADDRESS = { street: '1 Main St', extended: '', city: 'Springfield', state: 'CA', zip: '91101' }
const MINUTE = 60_000

beforeEach(async () => {
  h = await harness({ devBypass: false })
  a = actors(h)
})

let eventCount = 0
const event = (type: string, payload: Record<string, unknown>, id = `evt-${++eventCount}`) => ({
  data: { id, event_type: type, occurred_at: new Date(h.clock.now).toISOString(), payload },
})

async function hook(body: unknown) {
  const raw = JSON.stringify(body)
  const res = await h.app.request('http://localhost/r/api/phone/webhook', { method: 'POST', headers: await h.phone.sign(raw), body: raw })
  return res.status
}

/** A call to the Northfield Works number, parked at Telnyx. */
const incoming = (leg = 'in-1', from: string = CALLER, to: string = LINE_NUMBER, extra: Record<string, unknown> = {}) =>
  event('call.initiated', { call_control_id: leg, to, from, direction: 'incoming', state: 'parked', connection_id: 'conn-1', ...extra })

/** The phone of a Northfield Works person is registered once they have asked for a login: they have a credential. */
async function register(email: string, emergencyNumber = '+12135550111') {
  if (email !== OWNER) h.phonePeople[email] = { emergencyNumber }
  expect((await a.tm(email, 'POST', `${P}/token`)).status).toBe(200)
}

const rings = () => h.phone.telnyx.of('ring')
const ops = (op: string) => h.phone.telnyx.of(op)
const answered = (leg: string, clientState?: string) => hook(event('call.answered', { call_control_id: leg, ...(clientState ? { client_state: clientState } : {}) }))
const ended = (leg: string, extra: Record<string, unknown> = {}) => hook(event('call.hangup', { call_control_id: leg, hangup_cause: 'normal_clearing', ...extra }))
const state = (r: any): string => r?.clientState ?? ''
const sipOf = (email: string) => `sip:${h.phoneCore.credentialOf(email)?.sipUsername}@sip.telnyx.com`

/** The Phone conversation's id and its messages, as a teammate reads them. */
async function phoneConv(email = OWNER) {
  const boot = (await a.tm(email, 'GET', '/bootstrap')).json
  const conv = boot.conversations.find((c: any) => c.kind === 'phone')
  const messages = conv ? (await a.tm(email, 'GET', `/conversations/${conv.id}/messages`)).json.messages : []
  return { conv, messages: messages as any[], boot }
}

/** A call all the way to its voicemail: nobody registered, no cell. Returns the caller's leg. */
async function toVoicemail(leg = 'in-1') {
  const [answers, speaks, records] = [ops('answer').length, ops('speak').length, ops('record').length]
  await hook(incoming(leg))
  expect(ops('answer')).toHaveLength(answers + 1)
  await answered(leg)
  expect(ops('speak')).toHaveLength(speaks + 1)
  await hook(event('call.speak.ended', { call_control_id: leg }))
  expect(ops('record')).toHaveLength(records + 1)
  return leg
}

const saved = (leg: string, id = 'rec-1', secs = 42) =>
  hook(
    event('call.recording.saved', {
      call_control_id: leg,
      recording_id: id,
      recording_started_at: new Date(h.clock.now).toISOString(),
      recording_ended_at: new Date(h.clock.now + secs * 1000).toISOString(),
    }),
  )

describe('a call to the number rings every Northfield Works person with a phone, at once', () => {
  test('each registered phone person gets one leg, to their own SIP address, linked to the parked call, for 20 seconds, showing the caller’s number', async () => {
    await register(OWNER)
    await register(ANA)
    expect(await hook(incoming())).toBe(200)
    expect(rings().map((r) => r.to).sort()).toEqual([sipOf(OWNER), sipOf(ANA)].sort())
    for (const r of rings()) {
      expect(r).toMatchObject({ from: CALLER, linkTo: 'in-1', timeoutSecs: 20, timeLimitSecs: LINE.callLimitSecs })
    }
    // The caller’s leg is left parked, so the caller hears ringing: it is not answered until someone takes the call.
    expect(ops('answer')).toHaveLength(0)
    expect(ops('hangup')).toHaveLength(0)
  })

  test('a teammate who is not on the phone list, one with no phone registered, and a guest are never rung', async () => {
    await register(OWNER)
    // Ben is a teammate with a phone login but no place on the phone list; Ana is on the list but has never asked for a login.
    await a.tm(BEN, 'POST', `${P}/token`)
    h.phonePeople[ANA] = { emergencyNumber: '+12135550111' }
    const conv = (await a.tm(OWNER, 'POST', '/channels', { name: 'Acme', privacy: 'private' })).json.conversation.id
    await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })
    await hook(incoming())
    expect(rings().map((r) => r.to)).toEqual([sipOf(OWNER)])
  })

  test('the ring time is the line’s setting, and the default is 20 seconds', async () => {
    await register(OWNER)
    expect((await a.tm(OWNER, 'PUT', `${P}/settings`, { ringSeconds: 12 })).json.settings.ringSeconds).toBe(12)
    await hook(incoming())
    expect(rings()[0]?.timeoutSecs).toBe(12)
  })

  test('an event Telnyx delivers twice rings once', async () => {
    await register(OWNER)
    const e = incoming()
    await hook(e)
    await hook(e)
    expect(rings()).toHaveLength(1)
    // And the same call announced again under another event id is the same call: its parked leg is already known.
    await hook(incoming('in-1'))
    expect(rings()).toHaveLength(1)
  })

  test('the call is rung whatever the month’s minutes: past the cap, and when the number is withheld', async () => {
    h = await harness({ devBypass: false, phoneCap: 1 })
    a = actors(h)
    await register(OWNER)
    // Use the month up with a call taken in meet.
    await hook(incoming('first'))
    await answered(rings()[0]!.leg!)
    await answered('first')
    h.clock.now += 5 * MINUTE
    await ended(rings()[0]!.leg!)
    await ended('first')
    expect(h.phoneCore.minutesUsed(h.clock.now)).toBe(5)
    await hook(incoming('second', 'anonymous'))
    // Rung from the Northfield Works number, since there is no number of the caller’s to show.
    expect(rings().at(-1)).toMatchObject({ linkTo: 'second', to: sipOf(OWNER), from: LINE_NUMBER })
    expect(ops('hangup').map((c) => c.leg)).not.toContain('second')
  })
})

describe('the first to answer takes the call', () => {
  async function twoRinging() {
    await register(OWNER)
    await register(ANA)
    await hook(incoming())
    // Tessa’s leg first, then Ana’s, whatever order meet rang them in.
    return [rings().find((r) => r.to === sipOf(OWNER))!, rings().find((r) => r.to === sipOf(ANA))!]
  }

  test('the caller is answered, the other phone is let go, and the two are bridged once the caller is answered', async () => {
    const [tessa, ana] = await twoRinging()
    await answered(ana!.leg!, state(ana!))
    expect(ops('hangup').map((c) => c.leg)).toEqual([tessa!.leg!])
    expect(ops('answer').map((c) => c.leg)).toEqual(['in-1'])
    expect(ops('bridge')).toHaveLength(0)
    await answered('in-1')
    expect(ops('bridge')).toHaveLength(1)
    expect(ops('bridge')[0]).toMatchObject({ leg: 'in-1', withLeg: ana!.leg })
    expect(ops('record')).toHaveLength(0)
  })

  test('a second phone answering a moment later is hung up, not bridged, and the caller is not answered twice', async () => {
    const [tessa, ana] = await twoRinging()
    await answered(tessa!.leg!)
    await answered(ana!.leg!)
    expect(new Set(ops('hangup').map((c) => c.leg))).toEqual(new Set([ana!.leg]))
    expect(ops('answer')).toHaveLength(1)
    await answered('in-1')
    expect(ops('bridge')).toHaveLength(1)
    expect(ops('bridge')[0]).toMatchObject({ withLeg: tessa!.leg })
  })

  test('when the person hangs up, the caller’s leg goes too; the call is logged as answered, by name, with the caller’s minutes', async () => {
    const [tessa] = await twoRinging()
    await answered(tessa!.leg!)
    await answered('in-1')
    h.clock.now += 90_000
    await ended(tessa!.leg!)
    expect(ops('hangup').at(-1)).toMatchObject({ leg: 'in-1' })
    await ended('in-1')
    const log = (await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls
    expect(log[0]).toMatchObject({ direction: 'in', number: CALLER, outcome: 'answered', minutes: 2, answeredBy: 'Tessa' })
    expect(h.phoneCore.minutesUsed(h.clock.now)).toBe(2)
    // No missed-call line for a call that was taken.
    expect((await phoneConv()).messages).toEqual([])
  })

  test('declining on one phone leaves the others ringing; when every phone has let go the call moves on', async () => {
    const [tessa, ana] = await twoRinging()
    await ended(tessa!.leg!, { hangup_cause: 'call_rejected' })
    expect(ops('answer')).toHaveLength(0)
    expect(ops('hangup')).toHaveLength(0)
    await ended(ana!.leg!, { hangup_cause: 'timeout' })
    // No cell is set: straight to the voicemail.
    expect(ops('answer').map((c) => c.leg)).toEqual(['in-1'])
  })

  test('a phone that cannot be rung at all counts as having let go', async () => {
    await register(OWNER)
    h.phone.telnyx.failRing = 'always'
    await hook(incoming())
    expect(ops('answer').map((c) => c.leg)).toEqual(['in-1'])
  })
})

describe('then the cell, which must press 1', () => {
  beforeEach(async () => {
    await register(OWNER)
    expect((await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '(626) 555-0188' })).json.settings).toMatchObject({ cell: '+16265550188', cellDisplay: '(626) 555-0188', ringSeconds: 20 })
  })

  test('after nobody answers, the cell rings for 15 seconds showing the caller’s own number, and the caller is still not answered', async () => {
    await hook(incoming())
    await ended(rings()[0]!.leg!, { hangup_cause: 'timeout' })
    expect(rings()).toHaveLength(2)
    expect(rings()[1]).toMatchObject({ to: '+16265550188', from: CALLER, linkTo: 'in-1', timeoutSecs: 15 })
    expect(ops('answer')).toHaveLength(0)
  })

  test('with no one to ring in meet the cell rings at once', async () => {
    h = await harness({ devBypass: false })
    a = actors(h)
    await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '6265550188' })
    await hook(incoming())
    expect(rings().map((r) => r.to)).toEqual(['+16265550188'])
  })

  async function cellRinging() {
    await hook(incoming())
    await ended(rings()[0]!.leg!, { hangup_cause: 'timeout' })
    return rings()[1]!
  }

  test('when the cell answers it is asked to press 1, and the caller is not yet answered', async () => {
    const cell = await cellRinging()
    await answered(cell.leg!, state(cell))
    expect(ops('screen')).toHaveLength(1)
    expect(ops('screen')[0]).toMatchObject({ leg: cell.leg, text: 'Call for Northfield Works. Press 1 to answer.' })
    expect(ops('answer')).toHaveLength(0)
  })

  test('pressing 1 takes the call: the caller is answered, then bridged to the cell, and both legs’ minutes count', async () => {
    const cell = await cellRinging()
    await answered(cell.leg!)
    await hook(event('call.gather.ended', { call_control_id: cell.leg, digits: '1', status: 'valid' }))
    expect(ops('answer').map((c) => c.leg)).toEqual(['in-1'])
    await answered('in-1')
    expect(ops('bridge')[0]).toMatchObject({ leg: 'in-1', withLeg: cell.leg })
    h.clock.now += 90_000
    await ended(cell.leg!)
    expect(ops('hangup').at(-1)).toMatchObject({ leg: 'in-1' })
    await ended('in-1')
    const row = (await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls[0]
    expect(row).toMatchObject({ outcome: 'forwarded', minutes: 4 })
    expect(h.phoneCore.minutesUsed(h.clock.now)).toBe(4)
  })

  test('a cell’s own voicemail answering never presses 1: the cell is hung up and the caller goes to meet’s voicemail', async () => {
    const cell = await cellRinging()
    await answered(cell.leg!)
    await hook(event('call.gather.ended', { call_control_id: cell.leg, status: 'timeout' }))
    expect(ops('hangup').map((c) => c.leg)).toContain(cell.leg)
    expect(ops('answer').map((c) => c.leg)).toEqual(['in-1'])
    expect(ops('bridge')).toHaveLength(0)
    // The cell’s hang-up arriving afterwards changes nothing more.
    await ended(cell.leg!)
    expect(ops('answer')).toHaveLength(1)
  })

  test('a cell that does not answer sends the caller to the voicemail', async () => {
    const cell = await cellRinging()
    await ended(cell.leg!, { hangup_cause: 'timeout' })
    expect(ops('answer').map((c) => c.leg)).toEqual(['in-1'])
  })

  test('past the month’s cap the cell is skipped; meet still rings and the voicemail is still taken', async () => {
    h = await harness({ devBypass: false, phoneCap: 3 })
    a = actors(h)
    await register(OWNER)
    await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '6265550188' })
    // Use the month up with a forwarded call of 3 minutes.
    await hook(incoming('first'))
    await ended(rings()[0]!.leg!)
    const cell = rings()[1]!
    await answered(cell.leg!)
    await hook(event('call.gather.ended', { call_control_id: cell.leg, digits: '1' }))
    await answered('first')
    h.clock.now += 61_000
    await ended('first')
    await ended(cell.leg!)
    expect(h.phoneCore.minutesUsed(h.clock.now)).toBeGreaterThanOrEqual(3)
    const before = rings().length
    await hook(incoming('second'))
    expect(rings().length).toBe(before + 1) // meet rings
    expect(rings().at(-1)?.to).toBe(sipOf(OWNER))
    await ended(rings().at(-1)!.leg!, { hangup_cause: 'timeout' })
    expect(rings().length).toBe(before + 1) // but not the cell
    expect(ops('answer').map((c) => c.leg)).toEqual(['first', 'second'])
  })
})

describe('then the voicemail', () => {
  test('the caller is answered and hears the greeting, then a beep and a recording of at most 3 minutes', async () => {
    await toVoicemail()
    expect(ops('speak')[0]?.text).toBe('You have reached Northfield Works. Nobody can take your call right now. Please leave a message after the tone, and hang up when you are done.')
    expect(ops('record')[0]).toMatchObject({ leg: 'in-1', maxSecs: 180 })
  })

  test('a recording that is saved is one voicemail: one message from Phone, unread, with its length and a way to play it', async () => {
    await a.tm(OWNER, 'GET', '/bootstrap')
    await toVoicemail()
    await saved('in-1', 'rec-1', 75)
    await saved('in-1', 'rec-1', 75)
    const { conv, messages } = await phoneConv()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ person: 'phone', name: 'Phone', text: 'Voicemail from (213) 555-0199, 1 min 15 sec', phone: { kind: 'voicemail', number: CALLER, display: '(213) 555-0199', seconds: 75 } })
    expect(typeof messages[0].phone.id).toBe('number')
    expect(messages[0].phone.id).toBeGreaterThan(0)
    // Unread for the Northfield Works person who has not read it.
    expect((await a.tm(OWNER, 'GET', '/bootstrap')).json.conversations.find((c: any) => c.id === conv.id).unread).toBe(1)
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls[0]).toMatchObject({ direction: 'in', outcome: 'voicemail' })
  })

  test('every Northfield Works person who has opened meet is emailed the number and the length, never the sound, and the subject is fixed', async () => {
    await a.tm(OWNER, 'GET', '/bootstrap')
    await a.tm(ANA, 'GET', '/bootstrap')
    await toVoicemail()
    await saved('in-1', 'rec-1', 61)
    const mails = h.mail.filter((m) => m.subject === 'You have a voicemail on meet')
    expect(mails.map((m) => m.to).sort()).toEqual([ANA, OWNER].sort())
    for (const m of mails) {
      expect(m.text).toContain('(213) 555-0199')
      expect(m.text).toContain('1 min 1 sec')
      expect(m.text).not.toMatch(/https?:\/\/(?!space\.northfield\.example\/meet\/phone,)/)
      expect(m.text).toContain('https://space.northfield.example/meet/phone,')
      expect(m.text).not.toContain('rec-1')
    }
  })

  test('the same off switch as direct-message emails: a person who turned them off is not emailed, though the voicemail reaches them', async () => {
    await a.tm(OWNER, 'GET', '/bootstrap')
    await a.tm(ANA, 'GET', '/bootstrap')
    await a.tm(ANA, 'PATCH', '/me', { nudgesOff: true })
    await toVoicemail()
    await saved('in-1')
    expect(h.mail.filter((m) => m.subject === 'You have a voicemail on meet').map((m) => m.to)).toEqual([OWNER])
    expect((await phoneConv(ANA)).messages).toHaveLength(1)
  })

  test('voicemail emails count against the hour’s email allowance', async () => {
    await a.tm(OWNER, 'GET', '/bootstrap')
    for (let i = 0; i < 50; i++) h.workspaceCore.phoneDesk().audience(h.clock.now)
    await toVoicemail()
    await saved('in-1')
    expect(h.mail.filter((m) => m.subject === 'You have a voicemail on meet')).toEqual([])
  })

  test('the message reaches the Northfield Works people’s open pages as a change, and no one else', async () => {
    await a.tm(OWNER, 'GET', '/bootstrap')
    const ana = await a.tm(ANA, 'GET', '/bootstrap')
    const gus = await guestIn()
    h.delivered.length = 0
    await toVoicemail()
    await saved('in-1')
    const sent = h.delivered.filter((d) => d.change.kind === 'message')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.people.sort()).toEqual([ana.json.me.id, (await a.tm(OWNER, 'GET', '/bootstrap')).json.me.id].sort())
    expect(sent[0]?.people).not.toContain(gus.id)
  })

  test('a caller who hangs up before anyone answers or the voicemail starts is a missed call: a line in the Phone conversation, no email', async () => {
    await register(OWNER)
    await hook(incoming())
    await ended('in-1', { hangup_cause: 'originator_cancel' })
    expect(ops('hangup').map((c) => c.leg)).toEqual([rings()[0]!.leg!])
    const { messages } = await phoneConv()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ text: 'Missed call from (213) 555-0199', phone: { kind: 'missed', number: CALLER } })
    expect(h.mail.filter((m) => m.subject === 'You have a voicemail on meet')).toEqual([])
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls[0]).toMatchObject({ direction: 'in', outcome: 'missed', minutes: 0 })
  })

  test('hanging up during the greeting is a missed call; hanging up while recording waits for the recording, and the cron settles it if none comes', async () => {
    await hook(incoming('g'))
    await answered('g')
    h.clock.now += 2000
    await ended('g')
    expect((await phoneConv()).messages.map((m) => m.phone.kind)).toEqual(['missed'])
    const leg = await toVoicemail('r')
    await ended(leg)
    expect((await phoneConv()).messages.map((m) => m.phone.kind)).toEqual(['missed'])
    await saved(leg, 'rec-late', 5)
    expect((await phoneConv()).messages.map((m) => m.phone.kind)).toEqual(['missed', 'voicemail'])
    // And one whose recording never arrives is a missed call after ten minutes.
    const lost = await toVoicemail('lost')
    await ended(lost)
    const before = (await phoneConv()).messages.length
    h.clock.now += STALE_CALL_MS + MINUTE
    await runCron(h.deps)
    expect((await phoneConv()).messages.length).toBe(before + 1)
    await runCron(h.deps)
    expect((await phoneConv()).messages.length).toBe(before + 1)
  })

  test('the cron winds up a call whose events were lost: its legs are hung up and it is a missed call', async () => {
    await register(OWNER)
    await hook(incoming())
    h.clock.now += STALE_CALL_MS + MINUTE
    await runCron(h.deps)
    expect(ops('hangup').map((c) => c.leg).sort()).toEqual([rings()[0]!.leg!, 'in-1'].sort())
    expect((await phoneConv()).messages.map((m) => m.phone.kind)).toEqual(['missed'])
  })
})

describe('no live call is ever recorded', () => {
  test('across calls answered in meet, taken at the cell and sent to voicemail, recording starts once, on the voicemail’s caller leg, after the greeting', async () => {
    await register(OWNER)
    await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '6265550188' })
    // Answered in meet.
    await hook(incoming('one'))
    await answered(rings()[0]!.leg!)
    await answered('one')
    await ended(rings()[0]!.leg!)
    await ended('one')
    // Forwarded.
    await hook(incoming('two'))
    await ended(rings()[1]!.leg!)
    await answered(rings()[2]!.leg!)
    await hook(event('call.gather.ended', { call_control_id: rings()[2]!.leg, digits: '1' }))
    await answered('two')
    await ended('two')
    expect(ops('record')).toHaveLength(0)
    // Voicemail.
    await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '' })
    await hook(incoming('three'))
    await ended(rings().at(-1)!.leg!, { hangup_cause: 'timeout' })
    await answered('three')
    await hook(event('call.speak.ended', { call_control_id: 'three' }))
    expect(ops('record')).toHaveLength(1)
    expect(ops('record')[0]).toMatchObject({ leg: 'three' })
    // Nothing meet ever asks Telnyx for names a recording: not a ring, a dial, an answer or a bridge.
    for (const c of h.phone.telnyx.calls.filter((c) => ['ring', 'dial', 'answer', 'bridge'].includes(c.op))) {
      expect(JSON.stringify(c)).not.toMatch(/record/i)
    }
  })
})

describe('a voicemail is played and deleted only through the teammates’ door', () => {
  async function oneVoicemail() {
    await a.tm(OWNER, 'GET', '/bootstrap')
    h.phone.telnyx.sound['rec-1'] = 'ID3-the-sound-of-a-message'
    await toVoicemail()
    await saved('in-1', 'rec-1', 30)
    const { messages, conv } = await phoneConv()
    return { id: messages[0].id as number, conv: conv.id as number }
  }

  test('a Northfield Works person gets the sound, fetched from Telnyx by its id; nothing in the answer points at Telnyx', async () => {
    const { id } = await oneVoicemail()
    const res = await h.teammateApp.request(`http://localhost${W}${P}/voicemail/${id}/audio`, { headers: { 'cf-access-jwt-assertion': await a.assertion(OWNER) } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('ID3-the-sound-of-a-message')
    expect(ops('recordingAudio')).toHaveLength(1)
    expect(ops('recordingAudio')[0]).toMatchObject({ recordingId: 'rec-1' })
    for (const [k, v] of res.headers) expect(`${k}: ${v}`).not.toMatch(/telnyx|amazonaws|https?:/i)
    // The message a browser is given names a voicemail by a number of meet’s own, not a recording or an address.
    const { messages } = await phoneConv()
    expect(JSON.stringify(messages)).not.toMatch(/rec-1|telnyx|https?:/i)
  })

  test('a browser that seeks gets the range it asked for', async () => {
    const { id } = await oneVoicemail()
    const res = await h.teammateApp.request(`http://localhost${W}${P}/voicemail/${id}/audio`, { headers: { 'cf-access-jwt-assertion': await a.assertion(OWNER), range: 'bytes=0-3' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-3/26')
    expect(ops('recordingAudio')[0]?.range).toBe('bytes=0-3')
  })

  test('any Northfield Works person can play it (the Phone conversation is every teammate’s), but nobody else can', async () => {
    const { id } = await oneVoicemail()
    const play = (headers: Record<string, string>) => h.teammateApp.request(`http://localhost${W}${P}/voicemail/${id}/audio`, { headers })
    expect((await play({ 'cf-access-jwt-assertion': await a.assertion(ANA) })).status).toBe(200)
    expect((await play({})).status).toBe(401)
    // An address Access let in that is not on the teammate list is refused at the door.
    expect((await play({ 'cf-access-jwt-assertion': await a.assertion('mallory@evil.test') })).status).toBe(403)
  })

  test('a guest has no door to it: the guests’ door has no phone route, with a session or without, and a guest cookie on the teammates’ door is nothing', async () => {
    const { id } = await oneVoicemail()
    const gus = await guestIn()
    for (const [method, path] of [['GET', `${P}/voicemail/${id}/audio`], ['DELETE', `${P}/messages/${id}`], ['PUT', `${P}/settings`]] as const) {
      expect([path, (await a.gu(gus.token, method, path, {})).status === 200]).toEqual([path, false])
      expect([path, (await h.call(method, `${G}${path}`, {})).status === 200]).toEqual([path, false])
      expect([path, (await h.callTeammate(method, `${W}${path}`, {}, { headers: { cookie: `meet_guest=${gus.token}` } })).status]).toEqual([path, 401])
    }
    expect(ops('recordingAudio')).toHaveLength(0)
    expect(ops('deleteRecording')).toHaveLength(0)
  })

  test('a message that is not a voicemail, and one that does not exist, play nothing', async () => {
    await oneVoicemail()
    for (const id of ['999', 'x', '0']) {
      const r = await a.tm(OWNER, 'GET', `${P}/voicemail/${id}/audio`)
      expect([id, r.status]).toEqual([id, 404])
    }
    const conv = (await a.tm(OWNER, 'POST', '/channels', { name: 'Acme', privacy: 'private' })).json.conversation.id
    const text = (await a.tm(OWNER, 'POST', `/conversations/${conv}/messages`, { text: 'hi' })).json.message.id
    expect((await a.tm(OWNER, 'GET', `${P}/voicemail/${text}/audio`)).status).toBe(404)
  })

  test('a recording Telnyx no longer holds says so; a Telnyx that is down is a 502 that names no address', async () => {
    const { id } = await oneVoicemail()
    delete h.phone.telnyx.sound['rec-1']
    const gone = await a.tm(OWNER, 'GET', `${P}/voicemail/${id}/audio`)
    expect(gone.status).toBe(404)
    h.phone.telnyx.failAudio = true
    const down = await a.tm(OWNER, 'GET', `${P}/voicemail/${id}/audio`)
    expect(down.status).toBe(502)
    expect(JSON.stringify(down.json)).not.toMatch(/https?:/)
  })

  test('deleting a voicemail deletes its sound at Telnyx, then its message for everyone, and it can no longer be played', async () => {
    const { id, conv } = await oneVoicemail()
    await a.tm(ANA, 'GET', '/bootstrap')
    h.delivered.length = 0
    expect((await a.tm(OWNER, 'DELETE', `${P}/messages/${id}`)).status).toBe(200)
    expect(ops('deleteRecording')).toHaveLength(1)
    expect(ops('deleteRecording')[0]).toMatchObject({ recordingId: 'rec-1' })
    expect((await phoneConv(ANA)).messages).toEqual([])
    expect(h.delivered.some((d) => d.change.kind === 'delete' && (d.change.data as any).id === id && (d.change.data as any).conv === conv)).toBe(true)
    expect((await a.tm(OWNER, 'GET', `${P}/voicemail/${id}/audio`)).status).toBe(404)
    expect((await a.tm(OWNER, 'DELETE', `${P}/messages/${id}`)).status).toBe(404)
  })

  test('if Telnyx will not delete the sound, nothing is deleted here either', async () => {
    const { id } = await oneVoicemail()
    h.phone.telnyx.failDeleteRecording = true
    const r = await a.tm(OWNER, 'DELETE', `${P}/messages/${id}`)
    expect(r.status).toBe(502)
    expect((await phoneConv()).messages).toHaveLength(1)
    expect((await a.tm(OWNER, 'GET', `${P}/voicemail/${id}/audio`)).status).toBe(200)
  })

  test('a missed call’s line is deleted the same way, with nothing to delete at Telnyx', async () => {
    await register(OWNER)
    await hook(incoming())
    await ended('in-1')
    const { messages } = await phoneConv()
    expect((await a.tm(OWNER, 'DELETE', `${P}/messages/${messages[0].id}`)).status).toBe(200)
    expect(ops('deleteRecording')).toHaveLength(0)
    expect((await phoneConv()).messages).toEqual([])
  })

  test('the workspace’s own message routes cannot delete, edit or add to what the phone posted', async () => {
    const { id, conv } = await oneVoicemail()
    expect((await a.tm(OWNER, 'DELETE', `/messages/${id}`)).status).toBe(403)
    expect((await a.tm(OWNER, 'PATCH', `/messages/${id}`, { text: 'forged' })).status).toBe(403)
    expect((await a.tm(OWNER, 'POST', `/conversations/${conv}/messages`, { text: 'hello phone' })).status).toBe(403)
    expect((await phoneConv()).messages).toHaveLength(1)
  })
})

/** A guest of the workspace: invited to a channel and signed in. */
async function guestIn() {
  const conv = (await a.tm(OWNER, 'POST', '/channels', { name: 'Acme', privacy: 'private' })).json.conversation.id
  const invited = await a.tm(OWNER, 'POST', `/channels/${conv}/invite`, { email: 'gus@client.test', name: 'Gus' })
  const token = await a.signIn('gus@client.test')
  return { id: invited.json.person.id as string, token, conv: conv as number }
}

describe('the Phone conversation is for Northfield Works people only', () => {
  test('every Northfield Works person is in it from the start; its members are all teammates', async () => {
    const tessa = await phoneConv(OWNER)
    const ana = await phoneConv(ANA)
    expect(tessa.conv).toMatchObject({ kind: 'phone', name: 'Phone', privacy: 'private' })
    expect(ana.conv.id).toBe(tessa.conv.id)
    const people = (await a.tm(OWNER, 'GET', '/bootstrap')).json.people
    for (const id of ana.conv.members) expect(people.find((p: any) => p.id === id)?.kind).toBe('teammate')
  })

  test('a guest at the guests’ door never sees it: not in the list, not by its id, not to read, write, mark read or leave', async () => {
    const { conv } = await phoneConv()
    const gus = await guestIn()
    const boot = (await a.gu(gus.token, 'GET', '/bootstrap')).json
    expect(boot.conversations.map((c: any) => c.kind)).toEqual(['channel'])
    expect(JSON.stringify(boot)).not.toContain('Phone')
    for (const [method, path, body] of [
      ['GET', `/conversations/${conv.id}/messages`],
      ['POST', `/conversations/${conv.id}/messages`, { text: 'hi' }],
      ['POST', `/conversations/${conv.id}/read`, { upTo: 1 }],
      ['POST', `/channels/${conv.id}/leave`],
      ['POST', `/channels/${conv.id}/join`],
      ['POST', `/channels/${conv.id}/members`, { person: gus.id }],
    ] as const) {
      const r = await a.gu(gus.token, method, path, body)
      expect([method, path, r.status >= 400 && r.status < 500]).toEqual([method, path, true])
    }
  })

  test('a guest cannot be added to it or invited to it by a Northfield Works person, and the Phone conversation cannot be renamed, left or archived', async () => {
    const { conv } = await phoneConv()
    const gus = await guestIn()
    expect((await a.tm(OWNER, 'POST', `/channels/${conv.id}/members`, { person: gus.id })).status).toBe(400)
    expect((await a.tm(OWNER, 'POST', `/channels/${conv.id}/invite`, { email: 'gwen@client.test', name: 'Gwen' })).status).toBe(400)
    expect((await a.tm(OWNER, 'PATCH', `/channels/${conv.id}`, { name: 'Renamed' })).status).toBe(400)
    expect((await a.tm(OWNER, 'POST', `/channels/${conv.id}/leave`)).status).toBe(400)
    expect((await a.tm(OWNER, 'POST', `/channels/${conv.id}/archive`)).status).toBe(404)
    expect((await phoneConv()).conv.members).not.toContain(gus.id)
    // And a guest who becomes a Northfield Works person joins it, because they are one now.
    h.teammates.push('gus@client.test')
    const first = await a.tm('gus@client.test', 'GET', '/bootstrap')
    expect(first.json.conversations.map((c: any) => c.kind)).toContain('phone')
  })

  test('the change feed gives a guest nothing of it, however far back they ask', async () => {
    const gus = await guestIn()
    await toVoicemail()
    await saved('in-1')
    const caught = h.workspaceCore.catchUp({ via: 'socket', person: gus.id }, 0, h.clock.now)
    const changes = caught.reload ? [] : caught.changes
    expect(JSON.stringify(changes)).not.toMatch(/Voicemail|Phone/)
  })

  test('a Northfield Works person taken off the list stops receiving it, and a teammate who is not on the phone list still has the conversation', async () => {
    await a.tm(BEN, 'GET', '/bootstrap')
    expect((await phoneConv(BEN)).conv).toBeTruthy()
    h.teammates.splice(h.teammates.indexOf(BEN), 1)
    expect((await a.tm(BEN, 'GET', '/bootstrap')).status).toBe(403)
  })
})

describe('an incoming call never trips what is written for calls out', () => {
  async function setUp() {
    expect((await a.tm(OWNER, 'POST', `${P}/ack`)).status).toBe(200)
    expect((await a.tm(OWNER, 'PUT', `${P}/address`, ADDRESS)).status).toBe(200)
  }

  test('a dial to the Northfield Works number still in flight does not swallow a call to it: the call rings', async () => {
    await register(OWNER)
    await setUp()
    // Tessa dials his own number; while meet’s dial request is out, a real call arrives (no client state, no ticket).
    const ok = await a.tm(OWNER, 'POST', `${P}/call`, { to: LINE_NUMBER })
    h.phone.telnyx.duringDial = async () => {
      h.phone.telnyx.duringDial = null
      await hook(incoming('real-call'))
    }
    await hook(event('call.initiated', { call_control_id: 'browser-1', to: ok.json.to, direction: 'outgoing', state: 'parked', client_state: btoa(JSON.stringify({ t: ok.json.ticket, w: 'x' })) }))
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
    expect(rings().map((r) => r.linkTo)).toEqual(['real-call'])
  })

  test('an incoming call carries no ticket and is never hung up for lacking one, nor logged as refused', async () => {
    await register(OWNER)
    await hook(incoming())
    expect(ops('hangup')).toHaveLength(0)
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls.map((c: any) => c.outcome)).toEqual(['ringing'])
  })

  test('meet’s own 911 leg, and a browser’s call out, still behave as before while a call is being rung', async () => {
    await register(OWNER)
    await setUp()
    await hook(incoming('in-1'))
    // A 911 call from the browser is dialed from the Northfield Works number, exactly once, with the rule intact.
    h.phone.telnyx.duringDial = async () => {
      h.phone.telnyx.duringDial = null
      await hook(event('call.initiated', { call_control_id: 'whatever', to: '911', direction: 'outgoing', state: 'parked' }))
    }
    await hook(event('call.initiated', { call_control_id: 'e1', to: '911', direction: 'outgoing', state: 'parked' }))
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
    expect(rings()).toHaveLength(1)
  })

  test('an outgoing event addressed to the Northfield Works number is a browser’s call out, not a call in', async () => {
    await register(OWNER)
    await hook(event('call.initiated', { call_control_id: 'o1', to: LINE_NUMBER, direction: 'outgoing', state: 'parked' }))
    expect(rings()).toHaveLength(0)
    expect(ops('hangup').map((c) => c.leg)).toEqual(['o1']) // no approval: refused as any call out without one
  })

  test('calls to some other number, and events on another connection, are left alone', async () => {
    await register(OWNER)
    await hook(incoming('x1', CALLER, '+16265550199'))
    await hook(incoming('x2', CALLER, LINE_NUMBER, { connection_id: 'someone-elses' }))
    expect(h.phone.telnyx.calls.filter((c) => c.op !== 'createCredential' && c.op !== 'loginToken')).toEqual([])
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls).toEqual([])
  })

  test('the legs of a call in are told by Telnyx’s id, or by client state only with the call’s random nonce and the leg’s row', async () => {
    await register(OWNER)
    await hook(incoming())
    const ring = rings()[0]!
    const [, callId, , legRow] = atob(state(ring)).split(':')
    // Forged client states on a stranger’s leg change nothing: wrong nonce, wrong leg, no leg.
    for (const forged of [`meet:${callId}:0000000000000000:${legRow}`, `meet:${callId}:${atob(state(ring)).split(':')[2]}`, `meet:999:${atob(state(ring)).split(':')[2]}:${legRow}`]) {
      await answered('stranger', btoa(forged))
    }
    expect(ops('answer')).toHaveLength(0)
    expect(ops('hangup')).toHaveLength(0)
    // The leg itself, by the id Telnyx gave it, is the call’s.
    await answered(ring.leg!)
    expect(ops('answer').map((c) => c.leg)).toEqual(['in-1'])
  })

  test('an event for a ring leg that beats the ring request’s own answer is still that leg’s', async () => {
    await register(OWNER)
    h.phone.telnyx.duringRing = async (r) => {
      h.phone.telnyx.duringRing = null
      await answered('leg-1', r.clientState)
    }
    await hook(incoming())
    expect(ops('answer').map((c) => c.leg)).toEqual(['in-1'])
    expect(rings()).toHaveLength(1)
    // The leg that took the call is not let go when the ring request comes back.
    expect(ops('hangup')).toHaveLength(0)
  })

  test('a call that moved on or ended while a ring request was out has that leg hung up at once', async () => {
    await register(OWNER)
    h.phone.telnyx.duringRing = async () => {
      h.phone.telnyx.duringRing = null
      await ended('in-1', { hangup_cause: 'originator_cancel' })
    }
    await hook(incoming())
    expect(ops('hangup').map((c) => c.leg)).toContain(rings()[0]!.leg)
  })

  test('a phone that Telnyx will not ring with the caller’s number is rung from the Northfield Works number instead', async () => {
    await register(OWNER)
    h.phone.telnyx.failRing = 'caller-number'
    await hook(incoming())
    expect(rings().map((r) => r.from)).toEqual([CALLER, LINE_NUMBER])
    // And a leg that was made is the call’s: the answer takes it.
    await answered(rings()[1]!.leg!)
    expect(ops('answer')).toHaveLength(1)
  })
})

describe('a 911 dispatcher’s callback rings like any other call', () => {
  const PSAP = '+16265550191'

  test('it rings the Northfield Works people’s phones, whatever the cap, the setup or the pause', async () => {
    h = await harness({ devBypass: false, phoneCap: 1 })
    a = actors(h)
    await register(OWNER)
    // The month is already used up (the cap here is 1 minute).
    await hook(incoming('burn'))
    await answered(rings()[0]!.leg!)
    await answered('burn')
    h.clock.now += 2 * MINUTE
    await ended('burn')
    await ended(rings()[0]!.leg!)
    expect(h.phoneCore.minutesUsed(h.clock.now)).toBeGreaterThanOrEqual(1)
    // The callback: no ticket, no approval, no address on file.
    const before = rings().length
    await hook(incoming('psap', PSAP))
    expect(rings().length).toBe(before + 1)
    expect(rings().at(-1)).toMatchObject({ to: sipOf(OWNER), from: PSAP, linkTo: 'psap' })
    expect(ops('hangup').map((c) => c.leg)).not.toContain('psap')
    // Answering it connects it.
    await answered(rings().at(-1)!.leg!)
    await answered('psap')
    expect(ops('bridge').at(-1)).toMatchObject({ leg: 'psap' })
  })

  test('with no one to ring, no cell and nothing else, the callback is answered and takes a message rather than being dropped', async () => {
    await hook(incoming('psap', PSAP))
    expect(ops('answer').map((c) => c.leg)).toEqual(['psap'])
    expect(ops('hangup')).toHaveLength(0)
  })

  test('a callback to a person’s own 911 number rings as well', async () => {
    await register(OWNER)
    await register(ANA, '+12135550111')
    await hook(incoming('psap-ana', PSAP, '+12135550111'))
    expect(rings().map((r) => r.linkTo)).toEqual(['psap-ana', 'psap-ana'])
  })

  test('the callback is never held back by the “in flight” rule even while 911 is being dialed', async () => {
    await register(OWNER)
    await a.tm(OWNER, 'POST', `${P}/ack`)
    await a.tm(OWNER, 'PUT', `${P}/address`, ADDRESS)
    h.phone.telnyx.duringDial = async () => {
      h.phone.telnyx.duringDial = null
      await hook(incoming('psap', PSAP))
    }
    await hook(event('call.initiated', { call_control_id: 'e1', to: '911', direction: 'outgoing', state: 'parked' }))
    expect(rings().map((r) => r.linkTo)).toEqual(['psap'])
  })
})

describe('a call whose caller has gone is never worked further', () => {
  test('the caller hangs up while a phone rings and a cell is set: the cell is not rung when the ring legs’ hang-ups arrive', async () => {
    await register(OWNER)
    await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '(626) 555-0188' })
    await hook(incoming())
    const ring = rings()[0]!
    await ended('in-1', { hangup_cause: 'originator_cancel' })
    await ended(ring.leg!, { hangup_cause: 'normal_clearing' })
    expect(rings().map((r) => r.to)).toEqual([sipOf(OWNER)])
    expect(ops('answer')).toHaveLength(0)
    expect((await phoneConv()).messages.map((m) => m.phone.kind)).toEqual(['missed'])
  })

  test('the same when the cron wound the call up, and when a ring leg could not be made after the caller left', async () => {
    await register(OWNER)
    await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '(626) 555-0188' })
    await hook(incoming('swept'))
    const ring = rings()[0]!
    h.clock.now += STALE_CALL_MS + MINUTE
    await runCron(h.deps)
    await ended(ring.leg!)
    expect(rings()).toHaveLength(1)
    expect(ops('answer')).toHaveLength(0)
    // A request still out when the caller leaves, then refused by Telnyx: no cell either.
    h.phone.telnyx.duringRing = async () => {
      h.phone.telnyx.duringRing = null
      await ended('late', { hangup_cause: 'originator_cancel' })
      h.phone.telnyx.failRing = 'always'
    }
    await hook(incoming('late'))
    expect(rings().filter((r) => r.to === '+16265550188')).toHaveLength(0)
    expect(ops('answer')).toHaveLength(0)
  })

  test('a cell leg that ends after the caller left sends nothing to the voicemail', async () => {
    await register(OWNER)
    await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '(626) 555-0188' })
    await hook(incoming())
    await ended(rings()[0]!.leg!, { hangup_cause: 'timeout' })
    const cell = rings()[1]!
    await ended('in-1', { hangup_cause: 'originator_cancel' })
    await ended(cell.leg!)
    expect(ops('answer')).toHaveLength(0)
    expect(ops('speak')).toHaveLength(0)
  })
})

describe('a voicemail caller is let go once the message is taken', () => {
  test('the caller’s leg is hung up when the recording is saved, and the voicemail is still posted', async () => {
    await a.tm(OWNER, 'GET', '/bootstrap')
    const leg = await toVoicemail()
    await saved(leg, 'rec-1', 60)
    expect(ops('hangup').map((c) => c.leg)).toEqual([leg])
    expect((await phoneConv()).messages.map((m) => m.phone.kind)).toEqual(['voicemail'])
    // Its hang-up arriving after counts the minutes once.
    h.clock.now += 61_000
    await ended(leg)
    expect(h.phoneCore.minutesUsed(h.clock.now)).toBe(2)
  })

  test('a recording saved after the caller left hangs up nothing', async () => {
    const leg = await toVoicemail()
    await ended(leg)
    await saved(leg)
    expect(ops('hangup')).toHaveLength(0)
  })

  test('a silent caller or a robocall that never finishes is hung up by the cron once greeting, 3 minutes and a margin have passed, and what it ran is counted', async () => {
    const leg = await toVoicemail()
    // Not yet: inside the time a message can take.
    h.clock.now += VOICEMAIL_DEADLINE_MS - MINUTE
    await runCron(h.deps)
    expect(ops('hangup')).toHaveLength(0)
    h.clock.now += 2 * MINUTE
    await runCron(h.deps)
    expect(ops('hangup').map((c) => c.leg)).toEqual([leg])
    expect(h.phoneCore.minutesUsed(h.clock.now)).toBeGreaterThanOrEqual(4)
    // It is not asked again, nor counted again when Telnyx reports the hang-up.
    const used = h.phoneCore.minutesUsed(h.clock.now)
    await ended(leg)
    await runCron(h.deps)
    expect(ops('hangup')).toHaveLength(1)
    expect(h.phoneCore.minutesUsed(h.clock.now)).toBe(used)
  })

  test('the same when the greeting never ends or the recording could not start', async () => {
    await hook(incoming('stuck'))
    await answered('stuck')
    expect(ops('speak')).toHaveLength(1)
    h.clock.now += VOICEMAIL_DEADLINE_MS + MINUTE
    await runCron(h.deps)
    expect(ops('hangup').map((c) => c.leg)).toEqual(['stuck'])
  })
})

describe('Telnyx’s events can arrive out of order', () => {
  test('a caller’s hang-up before its answer counts the minutes and sends the leg nothing', async () => {
    await hook(incoming('v'))
    await answered('v') // meet answered it...
    const speaks = ops('speak').length
    // ...but a second call whose hang-up is processed first:
    await hook(incoming('w'))
    h.clock.now += 30_000
    await ended('w')
    await answered('w')
    expect(ops('speak')).toHaveLength(speaks)
    expect(ops('record')).toHaveLength(0)
    expect(h.phoneCore.minutesUsed(h.clock.now)).toBe(1)
  })

  test('a ring leg’s hang-up before its answer is not a person taking the call', async () => {
    await register(OWNER)
    await register(ANA)
    await hook(incoming())
    const ring = rings().find((r) => r.to === sipOf(OWNER))!
    await ended(ring.leg!)
    await answered(ring.leg!, state(ring))
    // Ana’s phone is still ringing: nobody has taken the call, and nothing is sent to the dead leg.
    expect(ops('answer')).toHaveLength(0)
    expect(ops('bridge')).toHaveLength(0)
    expect(ops('hangup')).toHaveLength(0)
  })

  test('a cell leg’s hang-up before its answer is not screened', async () => {
    await register(OWNER)
    await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '6265550188' })
    await hook(incoming())
    await ended(rings()[0]!.leg!)
    const cell = rings()[1]!
    await ended(cell.leg!)
    await answered(cell.leg!)
    expect(ops('screen')).toHaveLength(0)
  })
})

describe('the person who took the call leaves before the caller is answered', () => {
  test('the caller leaves a message: no second answer is sent, the answer on its way starts the greeting, and the call is not missed', async () => {
    await register(OWNER)
    await hook(incoming())
    const ring = rings()[0]!
    await answered(ring.leg!, state(ring))
    expect(ops('answer')).toHaveLength(1)
    await ended(ring.leg!)
    expect(ops('hangup').map((c) => c.leg)).not.toContain('in-1')
    expect(ops('answer')).toHaveLength(1)
    await answered('in-1')
    expect(ops('bridge')).toHaveLength(0)
    expect(ops('speak')).toHaveLength(1)
    await hook(event('call.speak.ended', { call_control_id: 'in-1' }))
    expect(ops('record')).toHaveLength(1)
    await saved('in-1')
    const { messages } = await phoneConv()
    expect(messages.map((m) => m.phone.kind)).toEqual(['voicemail'])
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls[0]).toMatchObject({ outcome: 'voicemail' })
  })

  test('once the caller was joined to them, their hang-up still ends the call', async () => {
    await register(OWNER)
    await hook(incoming())
    const ring = rings()[0]!
    await answered(ring.leg!)
    await answered('in-1')
    await ended(ring.leg!)
    expect(ops('hangup').map((c) => c.leg)).toEqual(['in-1'])
    expect(ops('speak')).toHaveLength(0)
  })
})

describe('911 never waits on the Phone conversation', () => {
  test('a post that throws changes nothing about the dial, nor about Tessa’s email', async () => {
    await a.tm(OWNER, 'GET', '/bootstrap')
    expect((await a.tm(OWNER, 'POST', `${P}/ack`)).status).toBe(200)
    expect((await a.tm(OWNER, 'PUT', `${P}/address`, ADDRESS)).status).toBe(200)
    h.deskFails.post = true
    const who = (await a.tm(OWNER, 'GET', P)).json.who
    await hook(event('call.initiated', { call_control_id: 'e1', to: '911', direction: 'outgoing', state: 'parked', client_state: btoa(JSON.stringify({ t: null, w: who })) }))
    expect(h.phone.telnyx.of('dial')).toHaveLength(1)
    expect(h.phone.telnyx.of('dial')[0]).toMatchObject({ to: '911', from: LINE_NUMBER })
    expect(h.mail.filter((m) => m.subject === '911 was dialed from meet')).toHaveLength(1)
    // The page's own report is the same: the route still answers and the email still goes.
    h.clock.now += 5 * MINUTE
    expect((await a.tm(OWNER, 'POST', `${P}/emergency`, { to: '911' })).status).toBe(200)
    expect(h.mail.filter((m) => m.subject === '911 was dialed from meet')).toHaveLength(2)
  })
})

describe('premium exchanges inside an ordinary area code', () => {
  test('976 and the N11 exchanges are refused as premium, as a call out and as the cell, and an ordinary exchange is not', async () => {
    for (const n of ['626 976 1234', '(626) 976-0000', '+1 213 976 5555', '626 411 1234', '626 911 1234', '626 311 0000']) {
      const parsed = parseDestination(n)
      expect([n, parsed.ok ? 'ok' : parsed.reason]).toEqual([n, 'premium'])
      const cell = await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: n })
      expect([n, cell.status]).toEqual([n, 400])
      const call = await a.tm(OWNER, 'POST', `${P}/call`, { to: n })
      expect([n, call.status, call.json.reason]).toEqual([n, 403, 'premium'])
    }
    expect(parseDestination('626 555 0123').ok).toBe(true)
    expect(parseDestination('626 977 1234').ok).toBe(true)
    // Nothing was kept as the cell.
    expect(h.phoneCore.settings().cell).toBeNull()
  })
})

describe('a 911 call from meet is posted in the Phone conversation (calls out left this for the conversation to exist)', () => {
  test('every Northfield Works person sees who dialed and the address given, once for the page’s report and Telnyx’s webhook together; it is kept', async () => {
    await a.tm(ANA, 'GET', '/bootstrap')
    expect((await a.tm(OWNER, 'POST', `${P}/ack`)).status).toBe(200)
    expect((await a.tm(OWNER, 'PUT', `${P}/address`, ADDRESS)).status).toBe(200)
    const who = (await a.tm(OWNER, 'GET', P)).json.who
    await a.tm(OWNER, 'POST', `${P}/emergency`, { to: '911' })
    await hook(event('call.initiated', { call_control_id: 'e1', to: '911', direction: 'outgoing', state: 'parked', client_state: btoa(JSON.stringify({ t: null, w: who })) }))
    for (const who of [OWNER, ANA]) {
      const { messages } = await phoneConv(who)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ person: 'phone', phone: { kind: 'emergency' } })
      expect(messages[0].text).toContain('911 was dialed from meet by Tessa')
      expect(messages[0].text).toContain('1 Main St, Springfield, CA 91101')
    }
    // A record is kept: it cannot be deleted from the page.
    const id = (await phoneConv()).messages[0].id
    expect((await a.tm(OWNER, 'DELETE', `${P}/messages/${id}`)).status).toBe(403)
    expect((await phoneConv()).messages).toHaveLength(1)
  })

  test('933, Telnyx’s test line, posts nothing', async () => {
    await a.tm(OWNER, 'GET', '/bootstrap')
    await hook(event('call.initiated', { call_control_id: 't1', to: '933', direction: 'outgoing', state: 'parked' }))
    expect((await phoneConv()).messages).toEqual([])
  })
})

describe('the line’s settings: the cell and the ring time, set by a Northfield Works person in meet', () => {
  test('they are in the phone status, with no number built in: out of the box there is no cell and the ring is 20 seconds', async () => {
    const s = (await a.tm(OWNER, 'GET', P)).json
    expect(s.settings).toEqual({ cell: null, cellDisplay: null, ringSeconds: 20 })
    expect(JSON.stringify(Object.values(LINE))).not.toMatch(/\+1\d{10}/)
  })

  test('a cell is kept as E.164, shown as people read it, and clearing it sends unanswered calls straight to voicemail', async () => {
    const r = await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '1 (626) 555-0188' })
    expect(r.json.settings).toMatchObject({ cell: '+16265550188', cellDisplay: '(626) 555-0188' })
    expect((await a.tm(OWNER, 'GET', P)).json.settings.cell).toBe('+16265550188')
    expect((await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '' })).json.settings.cell).toBeNull()
    await hook(incoming())
    expect(rings()).toHaveLength(0)
    expect(ops('answer')).toHaveLength(1)
  })

  test('only a US number that is not meet’s own can be the cell; the ring time is a whole number of seconds in range', async () => {
    for (const cell of ['+14165550123', '900 555 0123', 'nonsense', '911', LINE_NUMBER, '(626) 555-0100']) {
      const r = await a.tm(OWNER, 'PUT', `${P}/settings`, { cell })
      expect([cell, r.status]).toEqual([cell, 400])
    }
    for (const ringSeconds of [0, 4, 41, 12.5, '20', null]) {
      const r = await a.tm(OWNER, 'PUT', `${P}/settings`, { ringSeconds })
      expect([ringSeconds, r.status]).toEqual([ringSeconds, 400])
    }
    expect((await a.tm(OWNER, 'GET', P)).json.settings).toEqual({ cell: null, cellDisplay: null, ringSeconds: 20 })
  })

  test('only the line’s owner changes them: another Northfield Works person with the dial pad is refused, sees them, and is told they cannot edit', async () => {
    h.phonePeople[ANA] = { emergencyNumber: '+12135550111' }
    await a.tm(ANA, 'POST', `${P}/ack`)
    expect((await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '6265550188', ringSeconds: 15 })).status).toBe(200)
    const refused = await a.tm(ANA, 'PUT', `${P}/settings`, { cell: '2135550111', ringSeconds: 30 })
    expect(refused.status).toBe(403)
    expect(h.phoneCore.settings()).toMatchObject({ cell: '+16265550188', ringSeconds: 15 })
    const seen = (await a.tm(ANA, 'GET', P)).json
    expect(seen.settings).toMatchObject({ cell: '+16265550188', ringSeconds: 15 })
    expect(seen.canEditLine).toBe(false)
    expect((await a.tm(OWNER, 'GET', P)).json.canEditLine).toBe(true)
  })

  test('a teammate who is not on the phone list cannot change them either, and a write from another site is refused', async () => {
    expect((await a.tm(BEN, 'PUT', `${P}/settings`, { cell: '6265550188' })).status).toBe(403)
    expect((await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '6265550188' }, { origin: 'https://evil.test' })).status).toBe(403)
    expect(h.phoneCore.settings().cell).toBeNull()
  })

  test('with the phone not set up there are no settings to change', async () => {
    h.phoneOff.on = true
    expect((await a.tm(OWNER, 'PUT', `${P}/settings`, { cell: '6265550188' })).status).toBe(404)
  })
})

describe('the log shows calls in to every Northfield Works person with the phone', () => {
  test('a call in is the line’s, so both people see it, and each still sees only their own calls out', async () => {
    await register(OWNER)
    await register(ANA)
    await hook(incoming())
    await ended('in-1')
    for (const who of [OWNER, ANA]) {
      const calls = (await a.tm(who, 'GET', `${P}/calls`)).json.calls
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ direction: 'in', number: CALLER, display: '(213) 555-0199', outcome: 'missed' })
    }
  })

  test('a withheld number is shown as such, and the missed line says so', async () => {
    await hook(incoming('anon', 'anonymous'))
    await ended('anon')
    expect((await a.tm(OWNER, 'GET', `${P}/calls`)).json.calls[0]).toMatchObject({ direction: 'in', number: '', display: 'Unknown number' })
    expect((await phoneConv()).messages[0].text).toBe('Missed call from an unknown number')
  })
})

describe('storage made before calls in is migrated by adding, never rebuilding', () => {
  function oldStorage() {
    const db = new Database(':memory:')
    const sql = {
      all: <T>(q: string, ...params: unknown[]) => db.query(q).all(...(params as never[])) as T[],
      run: (q: string, ...params: unknown[]) => {
        db.query(q).run(...(params as never[]))
      },
    }
    for (const stmt of [...WS_SCHEMA, ...PHONE_V1]) sql.run(stmt)
    return sql
  }
  const columns = (sql: ReturnType<typeof oldStorage>, table: string) => new Set(sql.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name))
  const tables = (sql: ReturnType<typeof oldStorage>) => new Set(sql.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((t) => t.name))

  test('a workspace made before this slice gains the new tables and columns on its next boot, and keeps what it held', () => {
    const sql = oldStorage()
    sql.run(`INSERT INTO people (id, email, name, kind, status, created_at) VALUES ('p1', 'tessa@northfield.example', 'Tessa', 'teammate', 'active', 1)`)
    sql.run(`INSERT INTO conversations (kind, name, privacy, created_at) VALUES ('channel', 'Acme', 'private', 1)`)
    sql.run(`INSERT INTO conv_members (conv_id, person_id, added_at) VALUES (1, 'p1', 1)`)
    sql.run(`INSERT INTO messages (conv_id, person_id, text, at) VALUES (1, 'p1', 'kept', 1)`)
    sql.run(`INSERT INTO phone_profiles (email, who, created_at) VALUES ('tessa@northfield.example', 'abc', 1)`)
    sql.run(`INSERT INTO phone_calls (at, email, to_number, browser_leg, outcome, minutes, counted, nonce) VALUES (5, 'tessa@northfield.example', '+16265550123', 'b1', 'completed', 3, 1, 'n')`)
    // None of what calls in add is there yet.
    for (const t of ['phone_settings', 'phone_legs', 'phone_voicemails']) expect(tables(sql).has(t)).toBe(false)
    for (const c of ['direction', 'from_number', 'stage', 'answered_by', 'bridge_to', 'closed']) expect(columns(sql, 'phone_calls').has(c)).toBe(false)
    expect(columns(sql, 'messages').has('extra')).toBe(false)

    const ws = new WorkspaceCore(sql, () => installFor(['tessa@northfield.example']))
    const phone = new PhoneCore(sql, () => installFor(['tessa@northfield.example']), () => ({ 'tessa@northfield.example': { emergencyNumber: 'line' } }), 1000, ws.phoneDesk())

    for (const t of ['phone_settings', 'phone_legs', 'phone_voicemails']) expect(tables(sql).has(t)).toBe(true)
    for (const { table, column } of PHONE_ADDITIONS) expect(columns(sql, table).has(column)).toBe(true)
    expect(columns(sql, 'messages').has('extra')).toBe(true)
    // What was there is intact and reads as it did: the old call is a call out.
    expect(phone.recent('tessa@northfield.example')).toEqual([
      { id: 1, at: 5, direction: 'out', number: '+16265550123', display: '(626) 555-0123', outcome: 'completed', reason: null, minutes: 3, emergency: false, answeredBy: null },
    ])
    expect(ws.history({ via: 'access', email: 'tessa@northfield.example' }, 1, null, 10).messages.map((m) => m.text)).toEqual(['kept'])
    // And the new parts work on it: a call in, and a second boot changes nothing.
    const actions = phone.webhook(
      { id: 'e1', type: 'call.initiated', at: 10, leg: 'in', to: '+16265550100', from: '+12135550199', direction: 'incoming', state: 'parked', connection: null, digits: null, gather: null, recordingId: null, recordingStart: null, recordingEnd: null, ours: null, who: null, start: null, end: null, cause: null, ticketHash: null },
      10,
      '+16265550100',
    )
    expect(actions).toEqual([{ do: 'answer', callId: 2, nonce: expect.any(String), legRow: 1, leg: 'in' }])
    new PhoneCore(sql, () => installFor(['tessa@northfield.example']))
    expect(phone.recent('tessa@northfield.example').map((r) => r.id)).toEqual([2, 1])
    expect(PHONE_TABLES.length).toBeGreaterThan(PHONE_V1.length)
  })
})

describe('the phone is still all or nothing', () => {
  test('with the phone not configured, a call to the number is not heard at all', async () => {
    h.phoneOff.on = true
    const raw = JSON.stringify(incoming())
    const res = await h.app.request('http://localhost/r/api/phone/webhook', { method: 'POST', headers: await h.phone.sign(raw), body: raw })
    expect(res.status).toBe(404)
  })

  test('an unsigned call event rings nothing', async () => {
    await register(OWNER)
    const raw = JSON.stringify(incoming())
    expect((await h.app.request('http://localhost/r/api/phone/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).status).toBe(401)
    expect(rings()).toHaveLength(0)
  })
})
