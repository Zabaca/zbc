import { describe, expect, test } from 'bun:test'
import { createJmap, JmapSubmitRefused } from '../src/jmap/client'
import { JmapAuthError, JmapError, JmapOutcomeUnknown, JmapStateGone, JmapUnreachable } from '../src/jmap/types'
import { FakeJmapServer } from '../test-support/fake-jmap'

/** The JMAP client against the fake server: what each call answers, and how each way of failing is told apart (what the caller must DO about it). */

const connect = (server: FakeJmapServer) =>
  createJmap({
    door: server.door,
    accessId: server.accessId,
    accessSecret: server.accessSecret,
    key: server.key,
    fetch: server.fetch,
  })
const outgoing = (identityId: string, over: Partial<Parameters<ReturnType<typeof connect>['submit']>[0]> = {}) => ({
  from: { name: 'Test Mailbox', email: 'test@harborline.example' },
  to: ['tessa@northfield.example'],
  cc: [],
  subject: 'Re: hello',
  body: 'Thanks.',
  messageId: '<out-1@harborline.example>',
  inReplyTo: null,
  references: [],
  identityId,
  at: '2026-11-05T12:00:00.000Z',
  ...over,
})

/** A client that has read the server's folders, as the room's always has before it moves or makes anything (the allow-list learns the folders from that read). */
const opened = async (server: FakeJmapServer) => {
  const jmap = connect(server)
  await jmap.folders()
  return jmap
}

describe('reading', () => {
  test('the account id is the session’s, the folders have their roles, the identities are the address and its aliases', async () => {
    const server = new FakeJmapServer()
    const jmap = connect(server)
    expect(await jmap.accountId()).toBe('c')
    const folders = await jmap.folders()
    expect(folders.list.find((f) => f.role === 'archive')?.name).toBe('Archive')
    expect((await jmap.identities()).map((i) => i.email)).toEqual([
      'test@harborline.example',
      'info@harborline.example',
      'postmaster@harborline.example',
    ])
  })

  test('states, the list of a window (a page at a time) and the messages with their keywords and folders', async () => {
    const server = new FakeJmapServer()
    const jmap = connect(server)
    const before = await jmap.states()
    const ids = [1, 2, 3, 4, 5].map((n) => server.deliver({ subject: `m${n}`, at: server.clock + n * 1000 }))
    server.deliver({ folder: 'sent', at: server.clock + 10_000 })
    const inboxAndSent = [server.folder('inbox'), server.folder('sent')]
    const page1 = await jmap.list({ folderIds: inboxAndSent, after: null, position: 0, limit: 4 })
    const page2 = await jmap.list({ folderIds: inboxAndSent, after: null, position: 4, limit: 4 })
    expect(page1.total).toBe(6)
    expect([...page1.ids, ...page2.ids].length).toBe(6)
    const since = await jmap.list({
      folderIds: [server.folder('inbox')],
      after: new Date(server.clock + 3500).toISOString(),
      position: 0,
      limit: 50,
    })
    expect(since.ids).toEqual(ids.slice(3))
    const [first] = await jmap.emails([ids[0] as string])
    expect(first).toMatchObject({ id: ids[0], mailboxIds: { a: true }, keywords: {} })
    expect(first?.structure).toBeUndefined()
    expect((await jmap.emails([ids[0] as string], { structure: true }))[0]?.structure?.subject).toBe('m1')
    expect(await jmap.emails(['nope'])).toEqual([])
    expect((await jmap.states()).email).not.toBe(before.email)
  })

  test('changes since a cursor: created, updated and destroyed, in pages when there are too many', async () => {
    const server = new FakeJmapServer()
    const jmap = connect(server)
    const a = server.deliver({})
    const cursor = await jmap.states()
    const b = server.deliver({})
    server.markSeen(a, true)
    server.deliver({})
    server.destroy(b)
    const all = await jmap.changes(cursor, 500)
    expect(all.emails.created.length).toBe(1)
    expect(all.emails.updated).toEqual([a])
    expect(all.emails.destroyed).toEqual([])
    expect(all.emails.hasMoreChanges).toBe(false)
    expect(all.emails.newState).toBe(server.state)

    const paged = await jmap.changes(cursor, 1)
    expect(paged.emails.hasMoreChanges).toBe(true)
    const rest = await jmap.changes({ email: paged.emails.newState, mailbox: paged.mailboxState }, 500)
    expect(rest.emails.hasMoreChanges).toBe(false)
  })

  test('a cursor the server cannot answer from, and one it cannot read, are both a stale cursor', async () => {
    const server = new FakeJmapServer()
    const jmap = connect(server)
    server.deliver({})
    const cursor = await jmap.states()
    server.deliver({})
    server.forgetHistory()
    await expect(jmap.changes({ email: 's101', mailbox: cursor.mailbox }, 100)).rejects.toBeInstanceOf(JmapStateGone)
    await expect(jmap.changes({ email: 'garbage', mailbox: cursor.mailbox }, 100)).rejects.toBeInstanceOf(JmapStateGone)
    server.cannotCalculate = true
    await expect(jmap.changes(await jmap.states(), 100)).rejects.toBeInstanceOf(JmapStateGone)
  })

  test('a thread names its messages and a download is the message exactly as the server holds it', async () => {
    const server = new FakeJmapServer()
    const jmap = connect(server)
    const a = server.deliver({ messageId: '<a@x>' })
    const b = server.deliver({ inReplyTo: '<a@x>', messageId: '<b@x>' })
    const [email] = await jmap.emails([a])
    expect(await jmap.thread(email?.threadId as string)).toEqual([a, b])
    expect(await jmap.thread('nope')).toEqual([])
    expect(new TextDecoder().decode(await jmap.raw(email?.blobId as string))).toContain('Message-ID: <a@x>')
  })
})

describe('how each way of failing is told', () => {
  test('a refused key and a refused service token are an auth error, not a retry', async () => {
    const server = new FakeJmapServer()
    server.refuseKey = true
    await expect(connect(server).folders()).rejects.toBeInstanceOf(JmapAuthError)
    server.refuseKey = false
    server.refuseAccess = true
    const error = await connect(server)
      .folders()
      .catch((e) => e as Error)
    expect(error).toBeInstanceOf(JmapAuthError)
    expect((error as Error).message).toContain('Access')
  })

  test('a server that cannot be reached is unreachable; a server that is unwell is an error with its status', async () => {
    const server = new FakeJmapServer()
    server.unreachable = true
    await expect(connect(server).folders()).rejects.toBeInstanceOf(JmapUnreachable)
    server.unreachable = false
    server.failNext(502)
    const e = await connect(server)
      .folders()
      .catch((x) => x as JmapError)
    expect(e).toBeInstanceOf(JmapError)
    expect((e as JmapError).status).toBe(502)
    expect(e).not.toBeInstanceOf(JmapAuthError)
  })

  test('a call the key may not make is an auth error too (the server said forbidden)', async () => {
    const server = new FakeJmapServer()
    const jmap = connect(server)
    const original = server.fetch
    const forbidding = createJmap({
      door: server.door,
      accessId: server.accessId,
      accessSecret: server.accessSecret,
      key: server.key,
      fetch: async (url, init) => {
        if (typeof init?.body === 'string' && init.body.includes('Identity/get')) {
          return Response.json({
            methodResponses: [['error', { type: 'forbidden', description: 'You are not authorized' }, 'c0']],
          })
        }
        return original(url, init)
      },
    })
    await expect(forbidding.identities()).rejects.toBeInstanceOf(JmapAuthError)
    expect((await jmap.identities()).length).toBe(3)
  })
})

describe('changes to the mailbox', () => {
  test('read and unread; moving between folders; a message that is gone or refused is reported and the rest are moved', async () => {
    const server = new FakeJmapServer()
    const jmap = await opened(server)
    const a = server.deliver({})
    const b = server.deliver({})
    await jmap.setSeen([a, b], true)
    expect(server.emails.get(a)?.keywords.$seen).toBe(true)
    await jmap.setSeen([a], false)
    expect(server.emails.get(a)?.keywords.$seen).toBeUndefined()

    server.refuseUpdatesOf.add(b)
    const moved = await jmap.move([a, b, 'gone'], server.folder('inbox'), server.folder('archive'))
    expect(moved.moved).toEqual([a])
    expect(moved.failed.map((f) => f.id).sort()).toEqual([b, 'gone'].sort())
    expect(server.emails.get(a)?.mailboxIds).toEqual({ h: true })
    expect(server.emails.get(b)?.mailboxIds).toEqual({ a: true })
    await expect(jmap.setSeen([b], true)).rejects.toBeInstanceOf(JmapError)
  })
})

describe('sending', () => {
  test('one request makes the message and submits it, and the server files it in Sent, from the identity, with the Message-ID the inbox chose', async () => {
    const server = new FakeJmapServer()
    const jmap = await opened(server)
    const parent = server.deliver({ messageId: '<q@example.com>', from: 'Dana <dana@example.com>', subject: 'hello' })
    const [identity] = await jmap.identities()
    const sent = await jmap.submit(
      outgoing(identity?.id as string, {
        to: ['dana@example.com'],
        inReplyTo: '<q@example.com>',
        references: ['<q@example.com>'],
        messageId: '<out-1@harborline.example>',
      }),
      {
        drafts: server.folder('drafts'),
        sent: server.folder('sent'),
      },
    )
    expect(server.requests.filter((r) => r.calls.some((c) => c.name === 'EmailSubmission/set'))).toHaveLength(1)
    const made = server.emails.get(sent.emailId)
    expect(made?.mailboxIds).toEqual({ e: true })
    expect(made?.keywords).toEqual({ $seen: true })
    expect(made?.messageId).toBe('<out-1@harborline.example>')
    expect(made?.threadId).toBe(server.emails.get(parent)?.threadId as string)
    expect(sent.threadId).toBe(made?.threadId as string)
    expect(server.submitted).toHaveLength(1)
    expect(server.submitted[0]).toMatchObject({ from: 'test@harborline.example', to: ['dana@example.com'] })
    expect(server.submitted[0]?.raw).toContain('In-Reply-To: <q@example.com>')
    expect(server.submitted[0]?.raw).toContain('From: Test Mailbox <test@harborline.example>')
  })

  test('a submission the server refuses leaves the unsent copy, named in the refusal, and it is removed with the one removal there is', async () => {
    const server = new FakeJmapServer()
    const jmap = await opened(server)
    const [identity] = await jmap.identities()
    server.refuseSubmission = 'forbiddenFrom'
    const error = await jmap
      .submit(outgoing(identity?.id as string), { drafts: server.folder('drafts'), sent: server.folder('sent') })
      .catch((e) => e)
    expect(error).toBeInstanceOf(JmapSubmitRefused)
    expect(server.submitted).toHaveLength(0)
    const copy = (error as JmapSubmitRefused).emailId as string
    expect(server.emails.get(copy)?.mailboxIds).toEqual({ d: true })
    await jmap.removeUnsent(copy)
    expect(server.emails.has(copy)).toBe(false)
  })

  test('an identity that is not the account’s is refused as well, and the key refused is refused before anything is made', async () => {
    const server = new FakeJmapServer()
    const jmap = await opened(server)
    const error = await jmap
      .submit(outgoing('nobody'), { drafts: server.folder('drafts'), sent: server.folder('sent') })
      .catch((e) => e)
    expect(error).toBeInstanceOf(JmapSubmitRefused)
    const another = await opened(server)
    server.refuseKey = true
    const early = await another
      .submit(outgoing('i0'), { drafts: server.folder('drafts'), sent: server.folder('sent') })
      .catch((e) => e)
    expect(early).toBeInstanceOf(JmapAuthError)
    expect(early).not.toBeInstanceOf(JmapOutcomeUnknown)
  })

  test('a connection that drops after the request left, and a server error, are not known to have refused: the message may be out', async () => {
    const server = new FakeJmapServer()
    const jmap = await opened(server)
    const [identity] = await jmap.identities()
    const folders = { drafts: server.folder('drafts'), sent: server.folder('sent') }
    server.loseNextAnswer((methods) => methods.includes('EmailSubmission/set'))
    const lost = await jmap.submit(outgoing(identity?.id as string), folders).catch((e) => e)
    expect(lost).toBeInstanceOf(JmapOutcomeUnknown)
    expect(server.submitted).toHaveLength(1)

    server.failNext(500, (_path, methods) => methods.includes('EmailSubmission/set'))
    const unwell = await (await opened(server))
      .submit(outgoing(identity?.id as string, { messageId: '<out-2@harborline.example>' }), folders)
      .catch((e) => e)
    expect(unwell).toBeInstanceOf(JmapOutcomeUnknown)

    // a refusal in words (4xx) before anything happened is a refusal
    server.failNext(400, (_path, methods) => methods.includes('EmailSubmission/set'))
    const refused = await (await opened(server))
      .submit(outgoing(identity?.id as string, { messageId: '<out-3@harborline.example>' }), folders)
      .catch((e) => e)
    expect(refused).toBeInstanceOf(JmapError)
    expect(refused).not.toBeInstanceOf(JmapOutcomeUnknown)
  })
})

describe('the push subscription', () => {
  test('made, verified with the server’s code, renewed and removed; a wrong code is refused; http is refused by the allow-list before it leaves', async () => {
    const server = new FakeJmapServer()
    const jmap = connect(server)
    const made = await jmap.pushMake({
      url: 'https://inbox-push.northfield.example/jmap/abc?t=1',
      deviceClientId: 'space',
      types: ['Email', 'Mailbox'],
    })
    expect(made.id).toMatch(/^p/)
    const owed = server.owed.shift() as { body: { '@type': string; verificationCode: string } }
    expect(owed.body['@type']).toBe('PushVerification')
    await expect(jmap.pushVerify(made.id, 'wrong')).rejects.toBeInstanceOf(JmapError)
    await jmap.pushVerify(made.id, owed.body.verificationCode)
    expect(server.subscriptions[0]?.verified).toBe(true)
    const renewed = await jmap.pushRenew(made.id, '2026-11-20T00:00:00.000Z')
    expect(renewed.expires).toBe('2026-11-20T00:00:00.000Z')
    expect((await jmap.pushGet()).map((s) => s.id)).toEqual([made.id])
    await jmap.pushRemove(made.id)
    expect(server.subscriptions).toHaveLength(0)
    await expect(jmap.pushMake({ url: 'http://example.com/x', deviceClientId: 's', types: ['Email'] })).rejects.toThrow(
      'may not ask',
    )
  })
})
