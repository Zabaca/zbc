// A booking link's call (the space's ADR 0026): the window a call keeps where a join is decided (the Room), and what the calendar is handed to make, move and close one (src/booking-calls.ts) over the real Room and Workspace cores. The seam is
// the guests' call API for what a visitor meets (the lobby's look and a join), and the port's own methods for what the calendar asks.
import { describe, expect, test } from 'bun:test'
import { RoomCore, RoomError } from '../src/room'
import { bookingCalls } from '../src/booking-calls'
import { MEMBER_TIMEOUT_MS } from '../src/model'
import { ANA, type Harness, OWNER, T0, harness, memSql, token } from './helpers'

const NAME = 'k7m2qx9frtn4w6hbc8jd'
/** A booking's own id is a UUID: the keys a call is made once for. */
const KEY1 = '6f1c0d1e-4a52-4a58-9a47-0b1d2c3e4f50'
const KEY2 = '0a7b3c2d-9e41-4b6f-8c15-7d2e1f0a9b8c'
const MIN = 60_000
const HOUR = 60 * MIN
const START = T0 + 24 * HOUR
const WINDOW = { opensAt: START - 30 * MIN, closesAt: START + 30 * MIN + 2 * HOUR }

const refusal = (run: () => unknown): RoomError => {
  try {
    run()
  } catch (err) {
    if (err instanceof RoomError) return err
    throw err
  }
  throw new Error('it was not refused')
}

describe('the window of a call at the Room', () => {
  const made = (window?: { opensAt: number; closesAt: number }) => {
    const core = new RoomCore(memSql())
    core.create(NAME, T0, window)
    return core
  }

  test('a call with a window refuses a new person before it opens and after it closes, and lets them in between; its lobby says where it stands', () => {
    const core = made(WINDOW)
    expect(core.info(T0).window).toEqual({ ...WINDOW, state: 'early' })
    expect(refusal(() => core.join('ha', 'ma', 'Ana', T0, null))).toMatchObject({ status: 403, message: 'This call is not open yet.' })
    expect(core.info(T0).count).toBe(0)
    expect(core.info(WINDOW.opensAt).window?.state).toBe('open')
    expect(() => core.join('ha', 'ma', 'Ana', WINDOW.opensAt, null)).not.toThrow()
    expect(core.info(WINDOW.opensAt).count).toBe(1)
    expect(core.info(WINDOW.closesAt).window?.state).toBe('open')
    expect(core.info(WINDOW.closesAt + 1).window?.state).toBe('closed')
    expect(refusal(() => core.join('hb', 'mb', 'Ben', WINDOW.closesAt + 1, null))).toMatchObject({ status: 403, message: 'This call has closed.' })
    // Nobody was seated by a refusal.
    expect(core.info(WINDOW.closesAt + 2).count).toBe(0)
  })

  test('whoever is already in carries on past the close, and the same person coming back is not a new person', () => {
    const core = made(WINDOW)
    const near = WINDOW.closesAt - 1000
    core.join('ha', 'ma', 'Ana', near, null)
    // Ana is still in (she checked in within the timeout) and joins again from the same browser after the close.
    core.checkIn('ha', 1, { muted: false, cameraOff: false }, WINDOW.closesAt + MEMBER_TIMEOUT_MS / 3)
    expect(() => core.join('ha', 'ma', 'Ana', WINDOW.closesAt + (2 * MEMBER_TIMEOUT_MS) / 3, null)).not.toThrow()
  })

  test('a call with no window is exactly as it was: any time, and it has no window to show', () => {
    const core = made()
    expect(core.info(T0).window).toBeUndefined()
    expect(() => core.join('ha', 'ma', 'Ana', T0 + 400 * 24 * HOUR, null)).not.toThrow()
  })

  test('only a call that has a window can be moved or closed: any other call never closes', () => {
    const plain = made()
    expect(refusal(() => plain.setWindow(WINDOW.opensAt, WINDOW.closesAt))).toMatchObject({ status: 400 })
    expect(refusal(() => plain.cancelCall(T0))).toMatchObject({ status: 400 })
    expect(plain.info(T0).window).toBeUndefined()
    expect(() => plain.join('ha', 'ma', 'Ana', T0, null)).not.toThrow()
  })

  test('a window that ends before it begins is refused, and a move changes the one window', () => {
    const core = made(WINDOW)
    expect(refusal(() => core.setWindow(WINDOW.closesAt, WINDOW.opensAt))).toMatchObject({ status: 400 })
    const later = { opensAt: WINDOW.opensAt + 3 * HOUR, closesAt: WINDOW.closesAt + 3 * HOUR }
    core.setWindow(later.opensAt, later.closesAt)
    expect(core.info(WINDOW.opensAt).window).toEqual({ ...later, state: 'early' })
    expect(refusal(() => core.join('ha', 'ma', 'Ana', WINDOW.opensAt, null))).toMatchObject({ status: 403 })
    expect(() => core.join('ha', 'ma', 'Ana', later.opensAt, null)).not.toThrow()
  })

  test('a cancelled booking’s call is not a call to anyone who looks or tries to join, and those already in carry on', () => {
    const core = made(WINDOW)
    const at = WINDOW.opensAt
    core.join('ha', 'ma', 'Ana', at, null)
    core.cancelCall(at + 1000)
    expect(refusal(() => core.info(at + 2000))).toMatchObject({ status: 404, message: 'This is not a call.' })
    expect(refusal(() => core.join('hb', 'mb', 'Ben', at + 2000, null))).toMatchObject({ status: 404 })
    core.checkIn('ha', 1, { muted: false, cameraOff: false }, at + 3000)
    expect(() => core.join('ha', 'ma', 'Ana', at + 4000, null)).not.toThrow()
    // Closing twice is the same as once.
    expect(() => core.cancelCall(at + 5000)).not.toThrow()
  })
})

describe('what the calendar is handed to make, move and close a call', () => {
  const calls = (h: Harness) => bookingCalls({ install: h.deps.install, workspace: h.deps.workspace, room: h.deps.room, ledger: h.deps.ledger, appOrigin: h.deps.appOrigin, now: () => h.clock.now, randomBytes: h.deps.randomBytes })
  const spec = (key: string, startsAt = START) => ({ key, title: 'Intro call: Ada Quill', startsAt, guest: { name: 'Ada Quill', email: 'ada@example.org' }, opensAt: startsAt - 30 * MIN, closesAt: startsAt + 30 * MIN + 2 * HOUR })
  const nameOf = (link: string) => link.split('/r/')[1] as string
  const actor = { via: 'access', email: OWNER } as never

  test('is on where the install has calls, and says whether a call can be made', async () => {
    const h = await harness()
    const c = calls(h)
    expect(c.on).toBe(true)
    expect(await c.check()).toEqual({ ok: true })
    h.spend(800e9)
    const stopped = await c.check()
    expect(stopped).toMatchObject({ ok: false })
    expect((stopped as { why: string }).why).toContain('Calls are paused until')
    expect(await c.make(spec('b-1'))).toMatchObject({ ok: false })
  })

  test('makes one call for each key: on the space’s host, open only around its time, a meeting of the owner’s with the guest invited, and a second ask for the same key is the same call', async () => {
    const h = await harness()
    const c = calls(h)
    const made = await c.make(spec(KEY1))
    expect(made).toMatchObject({ ok: true })
    if (!made.ok) throw new Error('not made')
    expect(made.link).toBe(`https://space.northfield.example/r/${made.name}`)
    expect(await c.make(spec(KEY1))).toEqual(made)
    const other = await c.make(spec(KEY2))
    expect(other.ok && other.name !== made.name).toBe(true)
    // The guest's side: the lobby says early, a join before the window is refused, one inside it seats the guest.
    const lobby = await h.call('GET', `/r/api/rooms/${made.name}`)
    expect(lobby.json.window).toEqual({ ...WINDOW, state: 'early' })
    const early = await h.call('POST', `/r/api/rooms/${made.name}/join`, { name: 'Ada' }, { token: token('ada') })
    expect(early).toMatchObject({ status: 403, json: { error: 'This call is not open yet.' } })
    h.clock.now = WINDOW.opensAt
    expect((await h.call('POST', `/r/api/rooms/${made.name}/join`, { name: 'Ada' }, { token: token('ada') })).status).toBe(200)
    // The owner's record: a meeting of theirs with its time and the guest invited, which the Calendar strip does not list a second time beside the Google event.
    const rows = h.workspaceSql.all<{ kind: string; title: string; starts_at: number; booking: number; person_id: number }>('SELECT kind, title, starts_at, booking, person_id FROM space_calls WHERE name = ?', made.name)
    expect(rows).toMatchObject([{ kind: 'meeting', title: 'Intro call: Ada Quill', starts_at: START, booking: 1 }])
    expect(await h.deps.workspace().spaceMeetings(actor, T0, T0 + 3 * 24 * HOUR, h.clock.now)).toEqual([])
  })

  test('a move keeps the call and its link at the new time; a close makes the link say there is no such call; closing twice is closing once', async () => {
    const h = await harness()
    const c = calls(h)
    const made = await c.make(spec(KEY1))
    if (!made.ok) throw new Error('not made')
    const later = START + 3 * HOUR
    expect(await c.move(made.name, { startsAt: later, opensAt: later - 30 * MIN, closesAt: later + 30 * MIN + 2 * HOUR })).toEqual({ ok: true })
    h.clock.now = WINDOW.opensAt
    expect((await h.call('POST', `/r/api/rooms/${made.name}/join`, { name: 'Ada' }, { token: token('ada') })).status).toBe(403)
    expect((await h.call('GET', `/r/api/rooms/${made.name}`)).json.window.opensAt).toBe(later - 30 * MIN)
    h.clock.now = later
    expect(await c.close(made.name)).toEqual({ ok: true })
    expect(await c.close(made.name)).toEqual({ ok: true })
    expect(await h.call('GET', `/r/api/rooms/${made.name}`)).toMatchObject({ status: 404, json: { error: 'This is not a call.' } })
    expect((await h.call('POST', `/r/api/rooms/${made.name}/join`, { name: 'Ada' }, { token: token('ada') })).status).toBe(404)
  })

  test('nothing but a booking’s own call can be moved or closed through it: a huddle, a meeting made in the space and a name that was never a call are all refused and unchanged', async () => {
    const h = await harness()
    const c = calls(h)
    const ordinary = await h.startCall()
    const when = { startsAt: START, opensAt: START - 30 * MIN, closesAt: START + HOUR }
    expect(await c.move(ordinary, when)).toMatchObject({ ok: false })
    expect(await c.close(ordinary)).toMatchObject({ ok: false })
    expect(await c.close('a'.repeat(20))).toMatchObject({ ok: false })
    // The ordinary call is as it was: open now and a year on, never closed.
    expect((await h.call('GET', `/r/api/rooms/${ordinary}`)).json.window).toBeUndefined()
    h.clock.now = T0 + 400 * 24 * HOUR
    expect((await h.call('POST', `/r/api/rooms/${ordinary}/join`, { name: 'Ada' }, { token: token('ada') })).status).toBe(200)
  })

  test('the record of a booking’s call is moved and closed by the owner who made it and by nobody else, and a time past a year is refused', async () => {
    const h = await harness()
    const c = calls(h)
    const made = await c.make(spec(KEY1))
    if (!made.ok) throw new Error('not made')
    const ana = { via: 'access', email: ANA } as never
    const refused = async (run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (err) {
        return err instanceof RoomError ? err.status : -1
      }
      return 0
    }
    expect(await refused(() => h.deps.workspace().callMove(ana, made.name, START + HOUR, h.clock.now))).toBe(404)
    expect(await refused(() => h.deps.workspace().callCancel(ana, made.name, h.clock.now))).toBe(404)
    expect(await refused(() => h.deps.workspace().callMove(actor, made.name, T0 + 500 * 24 * HOUR, h.clock.now))).toBe(400)
    expect(await refused(() => h.deps.workspace().callMove(actor, made.name, START + HOUR, h.clock.now))).toBe(0)
    expect(h.workspaceSql.all<{ starts_at: number }>('SELECT starts_at FROM space_calls WHERE name = ?', made.name)[0]?.starts_at).toBe(START + HOUR)
    // Once cancelled it is not moved again, and cancelling again changes nothing.
    expect(await refused(() => h.deps.workspace().callCancel(actor, made.name, h.clock.now))).toBe(0)
    expect(await refused(() => h.deps.workspace().callMove(actor, made.name, START + 2 * HOUR, h.clock.now))).toBe(404)
    expect(await refused(() => h.deps.workspace().callCancel(actor, made.name, h.clock.now + 1000))).toBe(0)
  })

  test('with calls switched off it makes none and says so', async () => {
    const h = await harness({ install: undefined })
    const off = bookingCalls({ install: { ...h.deps.install, has: () => false } as never, workspace: h.deps.workspace, room: h.deps.room, ledger: h.deps.ledger, appOrigin: h.deps.appOrigin, now: () => h.clock.now, randomBytes: h.deps.randomBytes })
    expect(off.on).toBe(false)
    expect(await off.check()).toMatchObject({ ok: false })
    expect(await off.make(spec(KEY1))).toMatchObject({ ok: false })
  })
})
