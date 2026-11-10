// Seam 1 again: what happens to the SFU when someone is dropped, how relay credentials are reused,
// that the usage estimate only errs high, and that a name nobody started is never written to.
import { beforeEach, describe, expect, test } from 'bun:test'
import { meterOf } from '../src/calls'
import { LEDGER_NAME } from '../src/room'
import { MEMBER_TIMEOUT_MS } from '../src/model'
import { type Harness, T0, harness, token } from './helpers'

let h: Harness
let name: string
const base = () => `/r/api/rooms/${name}`

beforeEach(async () => {
  h = await harness()
  name = await h.startCall()
})

type M = { memberId: string; generation: number; tok: string; iceServers: any[] }

async function join(who: string): Promise<M> {
  const r = await h.call('POST', `${base()}/join`, { name: who }, { token: token(who) })
  expect(r.status).toBe(200)
  return { ...r.json, tok: token(who) }
}
const checkin = (m: M) => h.call('POST', `${base()}/checkin`, { generation: m.generation }, { token: m.tok })
const publish = (m: M, kinds: string[]) =>
  h.call(
    'POST',
    `${base()}/publish`,
    { generation: m.generation, offer: 'o', tracks: kinds.map((kind, i) => ({ kind, mid: String(i) })) },
    { token: m.tok },
  )
const subscribe = (m: M, wants: unknown[]) => h.call('POST', `${base()}/subscribe`, { generation: m.generation, wants }, { token: m.tok })

/** Everyone else goes quiet for longer than the timeout while `stays` keeps checking in. Returns that last check-in. */
async function silence(stays: M) {
  h.clock.now += 20_000
  await checkin(stays)
  h.clock.now += 20_000
  return checkin(stays)
}

/** Ana publishes camera and mic; Ben pulls both in. Returns who and what Ben's receiving session holds. */
async function watching() {
  const ana = await join('ana')
  const ben = await join('ben')
  await publish(ana, ['camera', 'mic'])
  const pubs = (await checkin(ben)).json.snapshot.members.find((m: any) => m.id === ana.memberId).publishing
  const sub = await subscribe(
    ben,
    pubs.map((p: any) => ({ memberId: ana.memberId, kind: p.kind, v: p.v })),
  )
  const recvSession = h.rt.of('addRemoteTracks')[0]!.sessionId
  return { ana, ben, recvSession, mids: sub.json.tracks.map((t: any) => t.mid) as string[] }
}

describe('someone who is dropped stops receiving at the SFU', () => {
  test('a tab that stops checking in but keeps its connection open is cut off once it is reaped', async () => {
    const { ana, recvSession, mids } = await watching()
    expect(mids).toHaveLength(2)
    h.rt.calls.length = 0
    const quiet = await silence(ana)
    // Ana's next check-in drops Ben from the list, and the router closes what Ben was pulling in.
    const snap = quiet.json.snapshot
    expect(snap.members.map((m: any) => m.id)).toEqual([ana.memberId])
    expect(h.rt.of('closeTracks')).toEqual([expect.objectContaining({ sessionId: recvSession, mids, force: true })])
  })

  test('what a reaped person was sending is closed too', async () => {
    const ana = await join('ana')
    const ben = await join('ben')
    await publish(ben, ['camera', 'screen'])
    const benSend = h.rt.of('newSession')[2]!.id
    h.rt.calls.length = 0
    await silence(ana)
    expect(h.rt.of('closeTracks')).toEqual([expect.objectContaining({ sessionId: benSend, mids: ['0', '1'], force: true })])
  })

  test('a rejoin closes the old connection, so an old tab left open stops receiving and N rejoins are not N downloads', async () => {
    const { ben, recvSession, mids } = await watching()
    h.rt.calls.length = 0
    const again = await h.call('POST', `${base()}/join`, { name: 'ben' }, { token: ben.tok })
    expect(again.status).toBe(200)
    expect(h.rt.of('closeTracks')).toEqual([expect.objectContaining({ sessionId: recvSession, mids, force: true })])
    // And again: the second rejoin has nothing from the first to close, and the first's were closed once only.
    h.rt.calls.length = 0
    await h.call('POST', `${base()}/join`, { name: 'ben' }, { token: ben.tok })
    expect(h.rt.of('closeTracks')).toEqual([])
  })

  /** Make every close fail until `.ok()`, as an SFU that is down does. */
  function flakySfu() {
    let failing = true
    const real = h.rt.closeTracks.bind(h.rt)
    h.rt.closeTracks = async (...args) => {
      if (failing) throw new Error('503')
      return real(...args)
    }
    return {
      ok: () => {
        failing = false
      },
    }
  }

  test('a close the SFU refuses is tried again with growing pauses, and is not used up by a burst of check-ins', async () => {
    const { ana } = await watching()
    const sfu = flakySfu()
    await silence(ana) // Ben is dropped, and the close is refused
    // Ten more check-ins within a second or two, which the old per-drain budget would have spent entirely.
    for (let i = 0; i < 10; i++) {
      h.clock.now += 150
      await checkin(ana)
    }
    sfu.ok()
    h.rt.calls.length = 0
    await checkin(ana) // still inside the first pause: nothing yet
    expect(h.rt.of('closeTracks')).toEqual([])
    h.clock.now += 5000
    await checkin(ana) // the pause is over: the close is made, and it is the track Ben was pulling in
    expect(h.rt.of('closeTracks')).toHaveLength(1)
    h.rt.calls.length = 0
    h.clock.now += 70_000
    await checkin(ana) // and it is not made again
    expect(h.rt.of('closeTracks')).toEqual([])
  })

  test('a track the SFU will not close for ten minutes is given up on', async () => {
    const { ana } = await watching()
    flakySfu()
    await silence(ana)
    for (let t = 0; t < 9 * 60; t += 29) {
      h.clock.now += 29_000
      await checkin(ana)
    }
    h.rt.calls.length = 0
    for (let t = 0; t < 3 * 60; t += 29) {
      h.clock.now += 29_000
      await checkin(ana)
    }
    // Past ten minutes from when it was dropped there are no more tries (the earlier ones were refused).
    expect(h.rt.of('closeTracks')).toEqual([])
  })

  test('a track the SFU says is already closed counts as closed', async () => {
    const { ana } = await watching()
    h.rt.closeTracks = async (_s, mids) => ({ tracks: mids.map((mid) => ({ mid, trackName: '', errorCode: 'close_track_error' })) })
    await silence(ana)
    h.rt.calls.length = 0
    h.clock.now += 70_000
    await checkin(ana)
    expect(h.rt.of('closeTracks')).toEqual([])
  })

  test('tracks made for someone who moved on, which the SFU then will not close, go to the Room to be retried', async () => {
    const ana = await join('ana')
    const real = h.rt.addLocalTracks.bind(h.rt)
    h.rt.addLocalTracks = async (...args) => {
      await h.call('POST', `${base()}/join`, { name: 'ana' }, { token: ana.tok }) // a refresh while the SFU works
      return real(...args)
    }
    const sfu = flakySfu()
    expect((await publish(ana, ['camera'])).status).toBe(409)
    sfu.ok()
    h.rt.calls.length = 0
    h.clock.now += 5000
    const again = await h.call('POST', `${base()}/join`, { name: 'ana' }, { token: ana.tok })
    expect(again.status).toBe(200)
    expect(h.rt.of('closeTracks')).toEqual([expect.objectContaining({ mids: ['0'], force: true })])
  })
})

describe('relay credentials', () => {
  test('a rejoin reuses the credentials the person holds instead of minting more', async () => {
    const ben = await join('ben')
    expect(h.rt.of('iceServers')).toHaveLength(1)
    const again = await h.call('POST', `${base()}/join`, { name: 'ben' }, { token: ben.tok })
    const third = await h.call('POST', `${base()}/join`, { name: 'ben' }, { token: ben.tok })
    expect(h.rt.of('iceServers')).toHaveLength(1)
    expect(again.json.iceServers).toEqual(ben.iceServers)
    expect(third.json.iceServers).toEqual(ben.iceServers)
  })

  test('a rejoin with the credentials nearly spent gets fresh ones', async () => {
    const ben = await join('ben')
    // Check in every 29 seconds for 7.6 hours so Ben stays in the call while his credentials age.
    for (let t = 0; t < 7.6 * 3600; t += 29) {
      h.clock.now += 29_000
      await checkin(ben)
    }
    await h.call('POST', `${base()}/join`, { name: 'ben' }, { token: ben.tok })
    expect(h.rt.of('iceServers')).toHaveLength(2)
  })

  test('while paused, a rejoin with credentials still in date is let back in, and one without is refused and mints nothing', async () => {
    const ben = await join('ben')
    h.spend(800e9)
    const kept = await h.call('POST', `${base()}/join`, { name: 'ben' }, { token: ben.tok })
    expect(kept.status).toBe(200)
    for (let t = 0; t < 7.6 * 3600; t += 29) {
      h.clock.now += 29_000
      await h.call('POST', `${base()}/checkin`, { generation: kept.json.generation }, { token: ben.tok })
    }
    h.rt.calls.length = 0
    const refused = await h.call('POST', `${base()}/join`, { name: 'ben' }, { token: ben.tok })
    expect(refused).toMatchObject({ status: 403 })
    expect(h.rt.of('iceServers')).toHaveLength(0)
    expect(h.rt.of('newSession')).toHaveLength(0)
  })
})

describe('the usage estimate only errs high', () => {
  test('a ledger write that fails loses nothing: the bytes are offered again once their claim runs out', async () => {
    const { ana, ben } = await watching()
    const ledger = h.cores.get(LEDGER_NAME)!
    const real = ledger.addUsage.bind(ledger)
    let failing = true
    ledger.addUsage = (...args) => {
      if (failing) throw new Error('storage unavailable')
      return real(...args)
    }
    for (let s = 2; s <= 30; s += 2) {
      h.clock.now = T0 + s * 1000
      await checkin(ana)
      await checkin(ben)
    }
    expect((await meterOf(h.deps.ledger(), h.clock.now)).usedGb).toBe(0)
    failing = false
    // The write works again. Bytes whose claim ran out are offered once more, the newer ones as they fall due.
    for (let i = 0; i < 10; i++) {
      h.clock.now += 10_000
      await checkin(ana)
      await checkin(ben)
    }
    // Ben has now received 130 s of camera and mic at the full step: 130 s x 1.04 Mbps / 8 = 16.9 MB. All of it
    // is in the ledger bar the last few seconds still waiting, and none of it twice.
    const total = ledger.usageFor('2026-10')
    expect(total).toBeGreaterThan(15e6)
    expect(total).toBeLessThanOrEqual(16.9e6 + 1)
  })

  test('when the last person leaves, what the Room has estimated goes to the ledger at once', async () => {
    const { ana, ben } = await watching()
    for (let s = 2; s <= 6; s += 2) {
      h.clock.now = T0 + s * 1000
      await checkin(ana)
      await checkin(ben)
    }
    const ledger = h.cores.get(LEDGER_NAME)!
    // Under the hand-over interval: nothing yet.
    expect(ledger.usageFor('2026-10')).toBe(0)
    await h.call('POST', `${base()}/leave`, { generation: ben.generation }, { token: ben.tok })
    await h.call('POST', `${base()}/leave`, { generation: ana.generation }, { token: ana.tok })
    // 6 s of camera and mic: 6 x 1.04 Mbps / 8 = 0.78 MB.
    expect(ledger.usageFor('2026-10')).toBeGreaterThan(0.7e6)
  })
})

describe('a name nobody started', () => {
  test('is never written to, whatever is asked of it', async () => {
    const ghost = 'a'.repeat(20)
    await h.call('GET', `/r/api/rooms/${ghost}`)
    await h.call('POST', `/r/api/rooms/${ghost}/join`, { name: 'x' }, { token: token('x') })
    for (const op of ['checkin', 'publish', 'subscribe', 'leave', 'renegotiate']) {
      await h.call(
        'POST',
        `/r/api/rooms/${ghost}/${op}`,
        { generation: 1, offer: 'o', answer: 'a', tracks: [{ kind: 'mic', mid: '0' }], wants: [] },
        { token: token('x') },
      )
    }
    expect(h.writes.get(ghost) ?? 0).toBe(0)
    // The call that was started has been written to, as the control.
    expect(h.writes.get(name)).toBeGreaterThan(0)
  })
})

describe('closing what the SFU made for someone who moved on', () => {
  test('a track the SFU answers an error for inside a successful reply is kept to be retried, like one whose request failed', async () => {
    const ana = await join('ana')
    const real = h.rt.addLocalTracks.bind(h.rt)
    h.rt.addLocalTracks = async (...args) => {
      await h.call('POST', `${base()}/join`, { name: 'ana' }, { token: ana.tok }) // a refresh while the SFU works
      return real(...args)
    }
    const closeReal = h.rt.closeTracks.bind(h.rt)
    let busy = true
    h.rt.closeTracks = async (session, mids, opts) =>
      busy ? { tracks: mids.map((mid) => ({ mid, trackName: '', errorCode: 'busy' })) } : closeReal(session, mids, opts)
    expect((await publish(ana, ['camera'])).status).toBe(409)
    busy = false
    h.rt.calls.length = 0
    h.clock.now += 5000
    expect((await h.call('POST', `${base()}/join`, { name: 'ana' }, { token: ana.tok })).status).toBe(200)
    expect(h.rt.of('closeTracks')).toEqual([expect.objectContaining({ mids: ['0'], force: true })])
  })
})
