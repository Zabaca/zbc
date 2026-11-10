// The room's rules at the core, without the router: overlapping usage offers, and a call started by an
// earlier commit opened with today's code.
import { describe, expect, test } from 'bun:test'
import { ORPHAN_GIVE_UP_MS, RoomCore } from '../src/room'
import { T0, memSql } from './helpers'
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3 } from './old-schemas'

const NAME = 'k7m2qx9frtn4w6hbc8jd'
const FLAGS = { muted: false, cameraOff: false }

/** Ana publishes a camera and Ben pulls it in, so Ben's check-ins accrue usage. */
function watching() {
  const core = new RoomCore(memSql())
  core.create(NAME, T0)
  core.join('ha', 'ma', 'Ana', T0, null)
  core.join('hb', 'mb', 'Ben', T0, null)
  core.setSessions('ha', 1, 'a-send', 'a-recv', null, T0)
  core.setSessions('hb', 1, 'b-send', 'b-recv', null, T0)
  core.planPublish('ha', 1, ['camera'], T0)
  core.recordPublished('ha', 1, [{ kind: 'camera', trackName: 'camera-1', v: 1, mid: '0' }], T0)
  const want = { memberId: 'ma', kind: 'camera' as const, v: 1 }
  core.resolveSubscribe('hb', 1, [want], T0)
  core.recordSubscribed('hb', 1, [{ ...want, trackName: 'camera-1', mid: '5' }], T0)
  return core
}

const TEN_SECONDS_OF_CAMERA = (1_000_000 * 10) / 8

describe('usage offers that overlap', () => {
  test("a second check-in before the first one's write is acknowledged is offered only what is new", () => {
    const core = watching()
    const first = core.checkIn('hb', 1, FLAGS, T0 + 10_000).usage
    expect(first).toBe(TEN_SECONDS_OF_CAMERA)
    // Ben's next 10 seconds fall due before the first write has come back.
    const second = core.checkIn('hb', 1, FLAGS, T0 + 20_000).usage
    expect(second).toBe(TEN_SECONDS_OF_CAMERA)
    // Another check-in straight after, from either person, is offered nothing.
    expect(core.checkIn('ha', 1, FLAGS, T0 + 20_001).usage).toBe(0)
  })

  test('an acknowledgement takes off exactly what was offered, whatever has accrued since', () => {
    const core = watching()
    const first = core.checkIn('hb', 1, FLAGS, T0 + 10_000).usage
    core.checkIn('hb', 1, FLAGS, T0 + 15_000) // more accrues while the first write is out
    core.ackUsage(first)
    // The 5 s accrued meanwhile and the 10 s after it are all still to come, none lost and none counted twice.
    expect(core.checkIn('hb', 1, FLAGS, T0 + 25_000).usage).toBe((1_000_000 * 15) / 8)
  })

  test('bytes whose write never came back are offered again once their claim has run out', () => {
    const core = watching()
    expect(core.checkIn('hb', 1, FLAGS, T0 + 10_000).usage).toBe(TEN_SECONDS_OF_CAMERA)
    // No acknowledgement. Check-ins carry on; the claim is 30 s old by T0 + 40 s.
    for (let s = 20; s <= 30; s += 10) {
      core.checkIn('ha', 1, FLAGS, T0 + s * 1000 - 1)
      core.checkIn('hb', 1, FLAGS, T0 + s * 1000)
    }
    core.checkIn('ha', 1, FLAGS, T0 + 39_999)
    const again = core.checkIn('hb', 1, FLAGS, T0 + 40_000).usage
    expect(again).toBe((1_000_000 * 40) / 8)
  })
})

describe('a call started by an earlier commit', () => {
  const COLUMNS = (sql: ReturnType<typeof memSql>, table: string) =>
    sql.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)

  function started(schema: string[], withCredentials: boolean) {
    const sql = memSql()
    for (const stmt of schema) sql.run(stmt)
    sql.run('INSERT INTO room (id, name, created_at, revision, flushed_at) VALUES (1, ?, ?, 3, ?)', NAME, T0, T0)
    sql.run(
      `INSERT INTO members (id, token_hash, name, generation, send_session, recv_session, joined_at, last_seen, last_meter${withCredentials ? ', ice, ice_expires' : ''})
       VALUES ('m1', 'h1', 'Ana', 1, 's1', 'r1', ?, ?, ?${withCredentials ? ', \'[{"urls":["stun:x"]}]\', ?' : ''})`,
      ...[T0, T0, T0, ...(withCredentials ? [T0 + 8 * 3600_000] : [])],
    )
    sql.run("INSERT INTO pubs (member_id, kind, v, track_name, mid) VALUES ('m1', 'camera', 1, 'camera-1', '0')")
    return sql
  }

  for (const [label, schema, withCredentials] of [
    ['the first commit (no relay credentials, no orphans table)', SCHEMA_V1, false],
    ['the first deploy (relay credentials and orphans, no usage claims or retry times)', SCHEMA_V2, true],
    ['the deploy before chat (no messages table, no chat columns, no seat count)', SCHEMA_V3, true],
  ] as const) {
    test(`from ${label} it keeps working, with its people and what they were sending`, () => {
      const sql = started(schema, withCredentials)
      const core = new RoomCore(sql)
      expect(core.exists()).toBe(true)
      for (const [table, column] of [
        ['members', 'ice'],
        ['members', 'ice_expires'],
        ['room', 'offered_bytes'],
        ['room', 'offered_at'],
        ['orphans', 'created_at'],
        ['orphans', 'next_try_at'],
        ['members', 'chat_window_at'],
        ['members', 'chat_count'],
        ['room', 'people'],
      ] as const) {
        expect(COLUMNS(sql, table)).toContain(column)
      }
      // The person who was in it is still in it, still sending, and can check in.
      const seen = core.checkIn('h1', 1, FLAGS, T0 + 2000)
      expect(seen.snapshot.members).toEqual([
        { id: 'm1', name: 'Ana', muted: false, cameraOff: false, publishing: [{ kind: 'camera', v: 1 }] },
      ])
      expect(seen.usage).toBe(0)
      // A rejoin works, closes what the old connection held, and hands back the credentials a V2 call stored.
      const back = core.join('h1', 'unused', 'Ana', T0 + 4000, null)
      expect(back.generation).toBe(2)
      expect(back.ice).toEqual(withCredentials ? [{ urls: ['stun:x'] }] : null)
      expect(core.takeOrphans(T0 + 4000).map((o) => [o.session, o.mid])).toEqual([['s1', '0']])
      // A new person can join, and leaving works.
      expect(core.join('h2', 'm2', 'Ben', T0 + 5000, null).snapshot.count).toBe(2)
      expect(core.leave('h2', 1, T0 + 6000)).not.toBeNull()
      // Chat works in it: the messages table was made on the boot, and the old member can send and be read.
      expect(sql.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'")).toHaveLength(1)
      const sent = core.chat('h1', 2, 'hello from an old call', T0 + 7000)
      expect(sent).toMatchObject({ id: 1, memberId: 'm1', name: 'Ana', text: 'hello from an old call' })
      expect(core.checkIn('h1', 2, FLAGS, T0 + 8000, 0).chat.messages).toEqual([sent])
      // Its seat count starts from its next new member (here Ben); it never shows fewer than who is in it.
      expect(core.summary(T0 + 8000)).toMatchObject({ messages: 1, present: 1, people: 1 })
    })
  }

  test('an orphan row the first deploy left behind is closed, then given up on by age like any other', () => {
    const sql = started(SCHEMA_V2, true)
    sql.run("INSERT INTO orphans (session, mid, tries) VALUES ('old', '9', 2)")
    const core = new RoomCore(sql)
    expect(core.takeOrphans(T0 + 1000).map((o) => o.mid)).toEqual(['9'])
    // Not due again straight away, and still there until it is closed or too old.
    expect(core.takeOrphans(T0 + 1001)).toEqual([])
    expect(core.takeOrphans(T0 + 1000 + ORPHAN_GIVE_UP_MS + 1)).toEqual([])
    expect(sql.all('SELECT 1 FROM orphans')).toEqual([])
  })

  test('migrating twice, and a fresh call, give the same columns', () => {
    const migrated = started(SCHEMA_V1, false)
    new RoomCore(migrated)
    new RoomCore(migrated)
    const fresh = memSql()
    new RoomCore(fresh).create(NAME, T0)
    for (const table of ['room', 'members', 'pubs', 'subs', 'orphans', 'usage', 'messages', 'calls']) {
      expect(COLUMNS(migrated, table).sort()).toEqual(COLUMNS(fresh, table).sort())
    }
  })
})

describe('orphans and the last person leaving', () => {
  test('a slow acknowledgement cannot delete a newer orphan that was given the same row number', () => {
    const core = new RoomCore(memSql())
    core.create(NAME, T0)
    core.addOrphans([{ session: 's1', mid: '0' }], T0)
    const [slow] = core.takeOrphans(T0)
    expect(slow).toBeDefined()
    // The track is given up on, its row goes, and a new orphan takes the same row number.
    core.takeOrphans(T0 + ORPHAN_GIVE_UP_MS + 1)
    core.addOrphans([{ session: 's2', mid: '7' }], T0 + ORPHAN_GIVE_UP_MS + 2)
    core.closedOrphans([slow as NonNullable<typeof slow>])
    expect(core.takeOrphans(T0 + ORPHAN_GIVE_UP_MS + 3).map((o) => [o.session, o.mid])).toEqual([['s2', '7']])
  })

  test('an acknowledgement for a track that is there closes it', () => {
    const core = new RoomCore(memSql())
    core.create(NAME, T0)
    core.addOrphans([{ session: 's1', mid: '0' }], T0)
    core.closedOrphans(core.takeOrphans(T0))
    expect(core.takeOrphans(T0 + ORPHAN_GIVE_UP_MS / 2)).toEqual([])
  })

  test('when the last person leaves, bytes still under the claim of a write that never came back are offered too', () => {
    const core = watching()
    const leased = core.checkIn('hb', 1, FLAGS, T0 + 10_000).usage // offered, and the write never comes back
    expect(leased).toBe(TEN_SECONDS_OF_CAMERA)
    core.checkIn('ha', 1, FLAGS, T0 + 11_000)
    expect(core.leave('hb', 1, T0 + 12_000)?.usage).toBe(0) // Ana is still there, and the claim has not run out
    // Nobody is left to check in again, so the leased bytes and the 2 s since are offered now.
    expect(core.leave('ha', 1, T0 + 13_000)?.usage).toBe(leased + (1_000_000 * 2) / 8)
  })
})
