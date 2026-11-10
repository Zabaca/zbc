import { describe, expect, test } from 'bun:test'
import { asker, harness, T0 } from '../test-support/harness'

/**
 * What the inbox's part of the space tells about a mailbox on the mail server: the menu's tree and foot line, Settings' card (and the answer's capabilities), Sync now through the one method that already syncs, and the
 * conversation lists' pill. The owner only, as every other view; never a key. The space's own screens are drawn from these in packages/space.
 */

const jh = () => harness({}, { jmap: true })
const unwrap = <T>(reply: { ok: boolean; value?: T }): T => {
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  return (reply as { value: T }).value
}
const a = () => asker()

async function filled() {
  const h = jh()
  h.jmapServer.deliver({ subject: 'Unread', from: 'Dana Smith <dana@example.com>', at: T0 - 2000 })
  h.jmapServer.deliver({ subject: 'Seen', from: 'Arun Mehta <arun@example.org>', seen: true, at: T0 - 1000 })
  await h.jmapRoom.requestJmapSync()
  await h.drain()
  return h
}

describe('the menu', () => {
  test('the mailbox is a place in the Mailboxes tree with its open and unread rows, and a line at the foot that is well', async () => {
    const h = await filled()
    const nav = unwrap(await h.space().navigation(a()))
    expect(nav.jmap).toHaveLength(1)
    expect(nav.jmap?.[0]).toMatchObject({
      name: 'harborline',
      address: 'test@harborline.example',
      count: 2,
      unread: 1,
      state: 'live',
      reason: expect.stringContaining('push address'),
    })
    expect(nav.jmap?.[0]?.lastSyncAt).toBeGreaterThan(0)
    // the business mailboxes (Ridgeway's) are not changed by it
    expect(nav.mailboxes.map((m) => m.name)).toEqual([])
    expect(JSON.stringify(nav)).not.toContain(h.jmapServer.key)
  })

  test('with none declared the list is empty, and a refused key is the line’s reason', async () => {
    const none = harness()
    expect(unwrap(await none.space().navigation(a())).jmap).toEqual([])
    const h = await filled()
    h.jmapServer.refuseKey = true
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    const nav = unwrap(await h.space().navigation(a()))
    expect(nav.jmap?.[0]).toMatchObject({ state: 'refused' })
    expect(nav.jmap?.[0]?.reason).toContain('refused')
  })
})

describe('Settings', () => {
  test('the answer lists the mailbox with its state, its push, its times and its counts, and no key', async () => {
    const h = await filled()
    const m = unwrap(await h.space().mailboxes(a()))
    expect(m.jmap).toHaveLength(1)
    expect(m.jmap?.[0]).toMatchObject({
      name: 'harborline',
      address: 'test@harborline.example',
      declared: true,
      state: 'live',
      refusedAt: null,
      push: 'waiting',
      lastError: null,
      messages: 2,
      conversations: 2,
      open: 2,
      unreadOpen: 1,
    })
    expect(m.jmap?.[0]?.lastSyncAt).toBeGreaterThan(0)
    expect(JSON.stringify(m)).not.toContain(h.jmapServer.key)
    expect(JSON.stringify(m)).not.toContain(h.jmapServer.accessSecret)
  })

  test('the states: filling, unreachable with the time since, refused with when, no longer declared', async () => {
    const h = jh()
    for (let n = 0; n < 130; n += 1) h.jmapServer.deliver({ subject: `m${n}`, at: T0 - (n + 1) * 60_000 })
    await h.jmapRoom.requestJmapSync()
    await h.jmapRoom.runAlarm()
    expect(unwrap(await h.space().mailboxes(a())).jmap?.[0]).toMatchObject({ state: 'filling' })
    await h.drain()
    h.jmapServer.unreachable = true
    await h.jmapRoom.requestJmapSync()
    h.tick(1000)
    await h.drain()
    const down = unwrap(await h.space().mailboxes(a())).jmap?.[0]
    expect(down).toMatchObject({ state: 'unreachable' })
    expect(down?.lastErrorAt).toBeGreaterThan(0)
    expect(down?.lastError).toContain('could not be reached')
    h.jmapServer.unreachable = false
    h.jmapServer.refuseKey = true
    h.tick(2 * 60 * 60 * 1000)
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    const refused = unwrap(await h.space().mailboxes(a())).jmap?.[0]
    expect(refused).toMatchObject({ state: 'refused' })
    expect(refused?.refusedAt).toBeGreaterThan(0)
    expect(refused?.reasons[0]).toContain('refused the space')
    h.jmapDeclared.splice(0)
    expect(unwrap(await h.space().mailboxes(a())).jmap?.[0]).toMatchObject({ state: 'undeclared', declared: false })
  })

  test('only the owner is told any of it', async () => {
    const h = await filled()
    const stranger = asker({ email: 'someone@example.com' })
    expect(await h.space().navigation(stranger)).toMatchObject({ ok: false })
    expect(await h.space().mailboxes(stranger)).toMatchObject({ ok: false })
  })
})

describe('Sync now', () => {
  test('asks the mail server for what changed, through the method that syncs Gmail, naming the mailbox', async () => {
    const h = await filled()
    const id = h.inbox.jmapRows()[0]?.id
    h.jmapServer.deliver({ subject: 'Brand new', from: 'Kim <kim@example.com>', at: h.now() })
    expect(unwrap(await h.space().changeGmail(a(), 'sync', id))).toEqual({ change: 'sync', revoked: null })
    h.tick(1000)
    await h.drain()
    expect(h.db.query("SELECT count(*) AS n FROM message WHERE subject = 'Brand new'").get()).toEqual({ n: 1 })
  })

  test('a mailbox on the mail server is not disconnected from here, and a refused one says why it cannot be synced', async () => {
    const h = await filled()
    const id = h.inbox.jmapRows()[0]?.id
    expect(await h.space().changeGmail(a(), 'disconnect', id)).toMatchObject({ ok: false, reason: 'bad-request' })
    h.jmapServer.refuseKey = true
    await h.jmapRoom.requestJmapSync()
    await h.drain()
    const refused = await h.space().changeGmail(a(), 'sync', id)
    expect(refused).toMatchObject({ ok: false, reason: 'conflict' })
  })
})

describe('the lists', () => {
  test('a conversation carries the mailbox’s pill', async () => {
    const h = await filled()
    const { people } = unwrap(await h.space().people(a()))
    expect(people.map((p) => p.name).sort()).toEqual(['Arun Mehta', 'Dana Smith'])
    const lines = people.flatMap((p) => p.conversations)
    expect(lines).toHaveLength(2)
    expect(
      lines.every((l) => l.mailbox?.name === 'harborline' && l.mailbox.address === 'test@harborline.example'),
    ).toBe(true)
  })
})
