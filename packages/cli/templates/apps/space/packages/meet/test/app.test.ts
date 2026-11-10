// Seam 1: the Worker's HTTP API, driven the way a browser drives it, with the
// real room rules underneath and a fake SFU that records every call it gets.
import { beforeEach, describe, expect, test } from 'bun:test'
import { meterOf } from '../src/calls'
import { MEMBER_TIMEOUT_MS, ROOM_CAP, displayName } from '../src/model'
import { type Harness, T0, failingSfu, harness, token } from './helpers'

let h: Harness
let name: string

beforeEach(async () => {
  h = await harness()
  name = await h.startCall()
})

const base = () => `/r/api/rooms/${name}`

/** Where the month's meter stands: the ledger's own answer (the space reads it through SpaceMeet; no route carries it any more). */
const usageNow = () => meterOf(h.deps.ledger(), h.clock.now)

/** Join as `who`, answering for the browser: returns the generation to use on every later request. */
async function join(who: string, displayName = who) {
  const r = await h.call('POST', `${base()}/join`, { name: displayName }, { token: token(who) })
  expect(r.status).toBe(200)
  return { ...r.json, tok: token(who) } as { memberId: string; generation: number; snapshot: any; iceServers: any[]; tok: string }
}

const checkin = (m: { tok: string; generation: number }, flags: { muted?: boolean; cameraOff?: boolean } = {}) =>
  h.call('POST', `${base()}/checkin`, { generation: m.generation, ...flags }, { token: m.tok })

const publish = (m: { tok: string; generation: number }, kinds: string[]) =>
  h.call(
    'POST',
    `${base()}/publish`,
    { generation: m.generation, offer: 'offer-sdp', tracks: kinds.map((kind, i) => ({ kind, mid: String(i) })) },
    { token: m.tok },
  )

const subscribe = (m: { tok: string; generation: number }, wants: unknown[]) =>
  h.call('POST', `${base()}/subscribe`, { generation: m.generation, wants }, { token: m.tok })

describe('starting a call and looking at it', () => {
  test('a started call has a 20 character name in groups of five, and the lobby sees it empty', async () => {
    const made = await h.startCall()
    expect(made).toMatch(/^[0-9a-hjkmnp-tv-z]{20}$/)
    const lobby = await h.call('GET', `/r/api/rooms/${displayName(made)}`)
    expect(lobby.json).toMatchObject({ count: 0, cap: ROOM_CAP, full: false, paused: false })
  })

  test('a name that was never started is not a call, and looking creates nothing', async () => {
    const ghost = 'a'.repeat(20)
    for (let i = 0; i < 2; i++)
      expect(await h.call('GET', `/r/api/rooms/${ghost}`)).toMatchObject({ status: 404, json: { error: 'This is not a call.' } })
    const j = await h.call('POST', `/r/api/rooms/${ghost}/join`, { name: 'x' }, { token: token('x') })
    expect(j.status).toBe(404)
    expect(h.rt.of('newSession')).toHaveLength(0)
    expect(await h.call('GET', '/r/api/rooms/not-even-shaped-right')).toMatchObject({ status: 404 })
  })
})

describe('joining', () => {
  test('a guest joins with no sign-in, gets a seat, a generation and relay credentials without port 53', async () => {
    const r = await join('ana', '  Ana   B  ')
    expect(r.generation).toBe(1)
    expect(r.snapshot.members).toEqual([{ id: r.memberId, name: 'Ana B', muted: false, cameraOff: false, publishing: [] }])
    expect(r.iceServers.flatMap((s: any) => s.urls).some((u: string) => /:53(\?|$)/.test(u))).toBe(false)
    expect(h.rt.of('newSession')).toHaveLength(2)
  })

  test('relay credentials come only with a join: nothing else carries them, and a token that never joined gets nothing', async () => {
    const stranger = { tok: token('eve'), generation: 1 }
    for (const path of ['checkin', 'publish', 'subscribe', 'renegotiate', 'unsubscribe', 'unpublish']) {
      const valid = { generation: 1, offer: 'o', answer: 'a', tracks: [{ kind: 'mic', mid: '0' }], kinds: ['mic'], wants: [] }
      const r = await h.call('POST', `${base()}/${path}`, valid, { token: stranger.tok })
      expect(r.status).toBe(401)
    }
    expect(h.rt.of('iceServers')).toHaveLength(0)
    const ana = await join('ana')
    const c = await checkin(ana)
    expect(JSON.stringify(c.json)).not.toContain('credential')
  })

  test('a request with no token, or a token that is not shaped like one, is refused', async () => {
    expect((await h.call('POST', `${base()}/checkin`, { generation: 1 })).status).toBe(401)
    expect((await h.call('POST', `${base()}/checkin`, { generation: 1 }, { token: 'short' })).status).toBe(401)
  })

  test('the 9th person is told the call is full; someone already in can still come back in', async () => {
    for (let i = 1; i <= ROOM_CAP; i++) await join(`p${i}`)
    const ninth = await h.call('POST', `${base()}/join`, { name: 'late' }, { token: token('p9') })
    expect(ninth).toMatchObject({ status: 409, json: { error: 'This call is full.' } })
    // The refused person made no SFU sessions.
    expect(h.rt.of('newSession')).toHaveLength(ROOM_CAP * 2)
    const again = await h.call('POST', `${base()}/join`, { name: 'p3' }, { token: token('p3') })
    expect(again.status).toBe(200)
    expect(again.json.generation).toBe(2)
    expect((await h.call('GET', base())).json).toMatchObject({ count: ROOM_CAP, full: true })
  })

  test('the picture steps down once a call passes 4 people', async () => {
    for (let i = 1; i <= 4; i++) await join(`p${i}`)
    expect((await checkin({ tok: token('p1'), generation: 1 })).json.snapshot.quality).toBe('full')
    await join('p5')
    expect((await checkin({ tok: token('p1'), generation: 1 })).json.snapshot).toMatchObject({ quality: 'low', count: 5 })
  })

  test('a refresh with the same token is the same person under a new generation, with fresh SFU sessions', async () => {
    const first = await join('ana')
    await publish(first, ['camera'])
    const second = await join('ana')
    expect(second.memberId).toBe(first.memberId)
    expect(second.generation).toBe(2)
    expect(second.snapshot.members).toHaveLength(1)
    expect(second.snapshot.members[0].publishing).toEqual([])
    expect(h.rt.of('newSession')).toHaveLength(4)
    const sessions = h.rt.of('newSession').map((c) => c.id)
    expect(new Set(sessions).size).toBe(4)
  })

  test('a reply meant for a replaced connection is refused and changes nothing', async () => {
    const first = await join('ana')
    const second = await join('ana')
    expect((await checkin(first)).status).toBe(409)
    expect((await publish(first, ['camera'])).status).toBe(409)
    expect((await checkin(second)).json.snapshot.members[0].publishing).toEqual([])
    // The old tab saying goodbye does not remove the new connection.
    await h.call('POST', `${base()}/leave`, { generation: first.generation }, { token: first.tok })
    expect((await checkin(second)).status).toBe(200)
  })

  test('when the call service fails the seat is given back', async () => {
    h.rt.newSession = async () => {
      throw failingSfu()
    }
    const r = await h.call('POST', `${base()}/join`, { name: 'x' }, { token: token('ana') })
    expect(r).toMatchObject({ status: 502, json: { error: 'The call service did not answer. Try again.' } })
    expect((await h.call('GET', base())).json.count).toBe(0)
  })
})

describe('who is in the call', () => {
  test('a person not heard from for 30 seconds is gone from the list, with what they were sending', async () => {
    const ana = await join('ana')
    const ben = await join('ben')
    await publish(ana, ['camera', 'mic'])
    expect((await checkin(ben)).json.snapshot.members.find((m: any) => m.id === ana.memberId).publishing).toHaveLength(2)
    h.clock.now += MEMBER_TIMEOUT_MS - 1000
    expect((await checkin(ben)).json.snapshot.count).toBe(2)
    h.clock.now += 1001 + 1000
    const snap = (await checkin(ben)).json.snapshot
    expect(snap.members.map((m: any) => m.id)).toEqual([ben.memberId])
    expect(snap.revision).toBeGreaterThan(0)
  })

  test('muting and turning the camera off show to everyone at the next check-in', async () => {
    const ana = await join('ana')
    const ben = await join('ben')
    await checkin(ana, { muted: true, cameraOff: true })
    const seen = (await checkin(ben)).json.snapshot.members.find((m: any) => m.id === ana.memberId)
    expect(seen).toMatchObject({ muted: true, cameraOff: true })
  })

  test('no snapshot carries a session id, a track name, a token or a credential', async () => {
    const ana = await join('ana')
    const ben = await join('ben')
    await publish(ana, ['camera', 'mic', 'screen'])
    await subscribe(ben, [{ memberId: ana.memberId, kind: 'camera', v: 1 }])
    const text = JSON.stringify([ana.snapshot, (await checkin(ben)).json, (await h.call('GET', base())).json])
    for (const secret of ['sess-', 'camera-1', 'mic-2', token('ana'), token('ben'), 'credential', 'username'])
      expect(text).not.toContain(secret)
  })

  test("leaving closes the person's own tracks at the SFU and removes them from the call", async () => {
    const ana = await join('ana')
    const ben = await join('ben')
    await publish(ana, ['camera', 'mic'])
    await subscribe(ben, [{ memberId: ana.memberId, kind: 'camera', v: 1 }])
    h.rt.calls.length = 0
    const out = await h.call('POST', `${base()}/leave`, { generation: ana.generation }, { token: ana.tok })
    expect(out.status).toBe(200)
    const closes = h.rt.of('closeTracks')
    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatchObject({ mids: ['0', '1'], force: true })
    expect((await checkin(ben)).json.snapshot.members.map((m: any) => m.id)).toEqual([ben.memberId])
  })
})

describe('publishing and subscribing', () => {
  test("a subscription resolves to the publisher's session and track name, asked for by member and kind", async () => {
    const ana = await join('ana')
    const ben = await join('ben')
    const pub = await publish(ana, ['camera', 'mic'])
    expect(pub.json).toMatchObject({ answer: 'answer-sdp', published: ['camera', 'mic'], failed: [] })
    const anaSend = h.rt.of('newSession')[0]!.id
    const snap = (await checkin(ben)).json.snapshot
    const cam = snap.members.find((m: any) => m.id === ana.memberId).publishing.find((p: any) => p.kind === 'camera')
    const sub = await subscribe(ben, [{ memberId: ana.memberId, kind: 'camera', v: cam.v }])
    expect(sub.json).toMatchObject({
      offer: 'offer-sdp',
      requiresImmediateRenegotiation: true,
      tracks: [{ memberId: ana.memberId, kind: 'camera', v: cam.v }],
      failed: [],
    })
    const pulled = h.rt.of('addRemoteTracks')[0]!
    // Ben's receiving session (his second), asking for Ana's track on Ana's sending session (her first).
    expect(pulled.sessionId).toBe(h.rt.of('newSession')[3]!.id)
    expect(pulled.tracks).toEqual([{ sessionId: anaSend, trackName: 'camera-1' }])
  })

  test('asking again for what is already pulled in, or for something that is not published, asks the SFU for nothing', async () => {
    const ana = await join('ana')
    const ben = await join('ben')
    await publish(ana, ['camera'])
    await subscribe(ben, [{ memberId: ana.memberId, kind: 'camera', v: 1 }])
    const again = await subscribe(ben, [{ memberId: ana.memberId, kind: 'camera', v: 1 }])
    const none = await subscribe(ben, [
      { memberId: ana.memberId, kind: 'screen', v: 9 },
      { memberId: 'nobody', kind: 'mic', v: 1 },
    ])
    expect(again.json.tracks).toEqual([])
    expect(none.json.tracks).toEqual([])
    expect(h.rt.of('addRemoteTracks')).toHaveLength(1)
  })

  test('a member can only act on their own publications and subscriptions', async () => {
    const ana = await join('ana')
    const ben = await join('ben')
    await publish(ana, ['camera'])
    h.rt.calls.length = 0
    // Ben unpublishing "camera" removes Ben's camera (he has none), never Ana's.
    await h.call('POST', `${base()}/unpublish`, { generation: ben.generation, kinds: ['camera'] }, { token: ben.tok })
    expect(h.rt.of('closeTracks')).toHaveLength(0)
    expect((await checkin(ben)).json.snapshot.members.find((m: any) => m.id === ana.memberId).publishing).toHaveLength(1)
    // Ben subscribing to himself is dropped.
    const self = await subscribe(ben, [{ memberId: ben.memberId, kind: 'camera', v: 1 }])
    expect(self.json.tracks).toEqual([])
    // Another member's token with Ana's generation number is still not Ana.
    expect(
      (
        await h.call(
          'POST',
          `${base()}/publish`,
          { generation: ana.generation, offer: 'o', tracks: [{ kind: 'mic', mid: '5' }] },
          { token: ben.tok },
        )
      ).json.published,
    ).toEqual(['mic'])
    const anaView = (await checkin(ana)).json.snapshot.members
    expect(anaView.find((m: any) => m.id === ana.memberId).publishing.map((p: any) => p.kind)).toEqual(['camera'])
  })

  test('a response that mixes successes and failures records only the tracks that succeeded', async () => {
    const ana = await join('ana')
    h.rt.fail.add('mic-2')
    const pub = await publish(ana, ['camera', 'mic'])
    expect(pub.json.published).toEqual(['camera'])
    expect(pub.json.failed).toEqual([{ kind: 'mic', error: 'not accepted' }])
    const snap = (await checkin(ana)).json.snapshot
    expect(snap.members[0].publishing.map((p: any) => p.kind)).toEqual(['camera'])
  })

  test('a publish that lands after the person rejoined closes what the SFU just made', async () => {
    const ana = await join('ana')
    const real = h.rt.addLocalTracks.bind(h.rt)
    h.rt.addLocalTracks = async (...args) => {
      // While the SFU works, Ana refreshes the page.
      await h.call('POST', `${base()}/join`, { name: 'ana' }, { token: ana.tok })
      return real(...args)
    }
    const r = await publish(ana, ['camera'])
    expect(r.status).toBe(409)
    expect(h.rt.of('closeTracks')).toEqual([expect.objectContaining({ mids: ['0'], force: true })])
  })

  test('stopping a share closes its tracks, and sharing again is a new publication', async () => {
    const ana = await join('ana')
    const ben = await join('ben')
    await publish(ana, ['screen', 'screenAudio'])
    const v1 = (await checkin(ben)).json.snapshot.members
      .find((m: any) => m.id === ana.memberId)
      .publishing.find((p: any) => p.kind === 'screen').v
    h.rt.calls.length = 0
    const stop = await h.call(
      'POST',
      `${base()}/unpublish`,
      { generation: ana.generation, kinds: ['screen', 'screenAudio'] },
      { token: ana.tok },
    )
    expect(stop.status).toBe(200)
    expect(h.rt.of('closeTracks')[0]).toMatchObject({ mids: ['0', '1'], force: true })
    expect((await checkin(ben)).json.snapshot.members.find((m: any) => m.id === ana.memberId).publishing).toEqual([])
    await publish(ana, ['screen'])
    const v2 = (await checkin(ben)).json.snapshot.members.find((m: any) => m.id === ana.memberId).publishing[0].v
    expect(v2).toBeGreaterThan(v1)
  })

  test('unsubscribing closes the named tracks on the receiving session, with the offer when the browser sends one', async () => {
    const ana = await join('ana')
    const ben = await join('ben')
    await publish(ana, ['camera'])
    const sub = await subscribe(ben, [{ memberId: ana.memberId, kind: 'camera', v: 1 }])
    const mid = sub.json.tracks[0].mid
    const r = await h.call(
      'POST',
      `${base()}/unsubscribe`,
      { generation: ben.generation, wants: [{ memberId: ana.memberId, kind: 'camera', v: 1 }], offer: 'inactive-offer' },
      { token: ben.tok },
    )
    expect(r.json.answer).toBe('close-answer')
    expect(h.rt.of('closeTracks')[0]).toMatchObject({ mids: [mid], offerSdp: 'inactive-offer' })
  })

  test("the browser's answer to the SFU's offer goes to the receiving session", async () => {
    const ana = await join('ana')
    const ben = await join('ben')
    const r = await h.call('POST', `${base()}/renegotiate`, { generation: ben.generation, answer: 'my-answer' }, { token: ben.tok })
    expect(r.status).toBe(200)
    expect(h.rt.of('renegotiate')).toEqual([expect.objectContaining({ sessionId: h.rt.of('newSession')[3]!.id, answerSdp: 'my-answer' })])
    void ana
  })
})

describe('the usage meter', () => {
  const FULL_BPS = 1_000_000 + 40_000 // one camera at the full step and one microphone

  async function watchedMinute() {
    const ana = await join('ana')
    const ben = await join('ben')
    await publish(ana, ['camera', 'mic'])
    const snap = (await checkin(ben)).json.snapshot
    const pubs = snap.members.find((m: any) => m.id === ana.memberId).publishing
    await subscribe(
      ben,
      pubs.map((p: any) => ({ memberId: ana.memberId, kind: p.kind, v: p.v })),
    )
    for (let s = 2; s <= 60; s += 2) {
      h.clock.now = T0 + s * 1000
      await checkin(ana)
      await checkin(ben)
    }
    return { ana, ben }
  }

  test('what a person receives is counted at the send caps and reaches the ledger every few seconds', async () => {
    await watchedMinute()
    const usage = { json: await usageNow() }
    // Ben received 60 seconds of one camera and one microphone: 60 s x 1.04 Mbps / 8 = 7.8 MB (shown to the
    // nearest MB). The last check-in or two may still be waiting for the next hand-over, never more.
    const full = (60 * FULL_BPS) / 8 / 1e9
    expect(usage.json.usedGb).toBeGreaterThanOrEqual(Math.round((full - 0.0006) * 1000) / 1000)
    expect(usage.json.usedGb).toBeLessThanOrEqual(Math.round(full * 1000) / 1000)
    expect(usage.json).toMatchObject({ freeGb: 1000, tripGb: 800, paused: false })
  })

  test('at 800 GB a new person cannot join and no new call can be started, while people already in carry on', async () => {
    const { ana, ben } = await watchedMinute()
    h.spend(800e9)
    expect(await usageNow()).toMatchObject({ paused: true, pausedUntil: '2026-11-01' })
    expect((await h.call('GET', base())).json).toMatchObject({ paused: true, pausedUntil: '2026-11-01' })
    const late = await h.call('POST', `${base()}/join`, { name: 'late' }, { token: token('late') })
    expect(late).toMatchObject({ status: 403, json: { error: 'Calls are paused until 2026-11-01.' } })
    // Ana and Ben keep checking in, and Ben's refresh gets him back in.
    expect((await checkin(ana)).status).toBe(200)
    expect((await checkin(ben)).status).toBe(200)
    expect((await h.call('POST', `${base()}/join`, { name: 'ben' }, { token: ben.tok })).status).toBe(200)
  })

  test('a new month starts the count again', async () => {
    h.spend(800e9)
    h.clock.now = Date.UTC(2026, 10, 1, 0, 0, 1)
    expect(await usageNow()).toMatchObject({ usedGb: 0, paused: false })
  })
})
