import { describe, expect, test } from 'bun:test'
import { ALLOWED_KINDS, ALLOWED_METHODS, type AllowContext, classify as classifyIn } from '../src/jmap/allow'
import { createJmap } from '../src/jmap/client'
import { FakeJmapServer } from '../test-support/fake-jmap'

/**
 * What the JMAP module may ask of the mail server, pinned as the Gmail module's three changes and the Telegram bridge's calls are: the list is a closed set of request shapes, every request the real client makes is one of
 * them, every shape is used by something, and a shape outside the list is refused before it leaves (so the space can never delete mail on the server, read another account, make a folder, or send by a second route).
 */

/** The folders the shapes below name: the Inbox (a), the Archive (h), Drafts (d), Sent (e), and the unsent copy of a refused submission (e1). */
const CTX: AllowContext = { inbox: 'a', archive: 'h', drafts: 'd', sent: 'e', unsent: 'e1' }
const classify = (name: string, args: Record<string, unknown>, ctx: AllowContext = CTX) => classifyIn(name, args, ctx)

const client = (server = new FakeJmapServer()) =>
  createJmap({
    door: server.door,
    accessId: server.accessId,
    accessSecret: server.accessSecret,
    key: server.key,
    fetch: server.fetch,
  })

describe('the list', () => {
  test('is exactly these kinds, and these JMAP methods', () => {
    expect([...ALLOWED_KINDS]).toEqual([
      'folders',
      'folder-changes',
      'identities',
      'threads',
      'message-list',
      'messages',
      'message-changes',
      'push-get',
      'set-seen',
      'move',
      'make-outgoing',
      'submit',
      'remove-unsent',
      'push-make',
      'push-verify',
      'push-renew',
      'push-remove',
    ])
    expect(([...ALLOWED_METHODS] as string[]).sort()).toEqual(
      (
        [
          'Mailbox/get',
          'Mailbox/changes',
          'Identity/get',
          'Thread/get',
          'Email/query',
          'Email/get',
          'Email/changes',
          'Email/set',
          'EmailSubmission/set',
          'PushSubscription/get',
          'PushSubscription/set',
        ] as string[]
      ).sort(),
    )
  })

  test('the shapes that fit are classified, each as the one kind', () => {
    expect(classify('Mailbox/get', { accountId: 'c', ids: null })).toBe('folders')
    expect(classify('Email/changes', { accountId: 'c', sinceState: 's1', maxChanges: 50 })).toBe('message-changes')
    expect(
      classify('Email/set', {
        accountId: 'c',
        update: { e1: { 'keywords/$seen': true }, e2: { 'keywords/$seen': null } },
      }),
    ).toBe('set-seen')
    expect(
      classify('Email/set', { accountId: 'c', update: { e1: { 'mailboxIds/a': null, 'mailboxIds/h': true } } }),
    ).toBe('move')
    expect(classify('Email/set', { accountId: 'c', destroy: ['e1'] })).toBe('remove-unsent')
    expect(
      classify('Email/set', {
        accountId: 'c',
        create: {
          out: {
            mailboxIds: { d: true },
            keywords: { $seen: true, $draft: true },
            from: [],
            to: [],
            subject: 's',
            messageId: ['a@b'],
            textBody: [],
            bodyValues: {},
          },
        },
      }),
    ).toBe('make-outgoing')
    expect(
      classify('EmailSubmission/set', {
        accountId: 'c',
        create: { send: { identityId: 'i0', emailId: '#out' } },
        onSuccessUpdateEmail: { '#send': { 'mailboxIds/d': null, 'mailboxIds/e': true, 'keywords/$draft': null } },
      }),
    ).toBe('submit')
    expect(
      classify('PushSubscription/set', {
        create: { p: { deviceClientId: 'x', url: 'https://inbox-push.northfield.example/jmap/abc', types: ['Email'] } },
      }),
    ).toBe('push-make')
    expect(classify('PushSubscription/set', { update: { p1: { verificationCode: 'c' } } })).toBe('push-verify')
    expect(classify('PushSubscription/set', { update: { p1: { expires: '2026-11-12T00:00:00Z' } } })).toBe('push-renew')
    expect(classify('PushSubscription/set', { destroy: ['p1'] })).toBe('push-remove')
  })

  test('writes may name only the folders and the one message the module is allowed: moves only between the Inbox and the Archive, a message made only in Drafts, filed only in Sent, and only the refused submission’s copy destroyed', () => {
    const move = (patch: Record<string, unknown>, ctx = CTX) =>
      classify('Email/set', { accountId: 'c', update: { e1: patch } }, ctx)
    // both directions between the Inbox (a) and the Archive (h)
    expect(move({ 'mailboxIds/a': null, 'mailboxIds/h': true })).toBe('move')
    expect(move({ 'mailboxIds/h': null, 'mailboxIds/a': true })).toBe('move')
    // not into or out of any other folder, not one side alone, not both put in or both taken out, not a third
    for (const patch of [
      { 'mailboxIds/a': null, 'mailboxIds/t': true }, // the Trash
      { 'mailboxIds/h': null, 'mailboxIds/j': true }, // the Junk
      { 'mailboxIds/d': null, 'mailboxIds/a': true }, // out of Drafts
      { 'mailboxIds/a': null }, // taken out of the Inbox and put nowhere
      { 'mailboxIds/h': true }, // put in the Archive and left in the Inbox
      { 'mailboxIds/a': true, 'mailboxIds/h': true },
      { 'mailboxIds/a': null, 'mailboxIds/h': null },
      { 'mailboxIds/a': null, 'mailboxIds/h': true, 'mailboxIds/t': true },
    ]) {
      expect(move(patch), JSON.stringify(patch)).toBeNull()
    }
    // a client that has not seen the Inbox and the Archive moves nothing
    expect(move({ 'mailboxIds/a': null, 'mailboxIds/h': true }, { ...CTX, archive: null })).toBeNull()
    expect(move({ 'mailboxIds/a': null, 'mailboxIds/h': true }, { ...CTX, inbox: null })).toBeNull()

    // made in Drafts only
    const made = (mailboxIds: Record<string, unknown>, ctx = CTX) =>
      classify(
        'Email/set',
        { accountId: 'c', create: { out: { mailboxIds, keywords: { $seen: true, $draft: true } } } },
        ctx,
      )
    expect(made({ d: true })).toBe('make-outgoing')
    expect(made({ a: true })).toBeNull() // straight into the Inbox
    expect(made({ e: true })).toBeNull() // straight into Sent
    expect(made({ d: false })).toBeNull()
    expect(made({ d: true }, { ...CTX, drafts: null })).toBeNull()

    // filed in Sent and the draft mark off, and nothing else
    const submit = (after: Record<string, unknown>, ctx = CTX) =>
      classify(
        'EmailSubmission/set',
        {
          accountId: 'c',
          create: { send: { identityId: 'i0', emailId: '#out' } },
          onSuccessUpdateEmail: { '#send': after },
        },
        ctx,
      )
    expect(submit({ 'mailboxIds/d': null, 'mailboxIds/e': true, 'keywords/$draft': null })).toBe('submit')
    expect(submit({ 'mailboxIds/e': true })).toBe('submit')
    expect(submit({ 'mailboxIds/d': null, 'mailboxIds/t': true })).toBeNull() // into the Trash
    expect(submit({ 'mailboxIds/a': true })).toBeNull() // into the Inbox
    expect(submit({ 'mailboxIds/e': null })).toBeNull() // out of Sent
    expect(submit({ 'keywords/$seen': null })).toBeNull()

    // only the unsent copy, by its id
    expect(classify('Email/set', { accountId: 'c', destroy: ['e1'] })).toBe('remove-unsent')
    expect(classify('Email/set', { accountId: 'c', destroy: ['e2'] })).toBeNull()
    expect(classify('Email/set', { accountId: 'c', destroy: ['e1'] }, { ...CTX, unsent: null })).toBeNull()
  })

  test('through the client, the same: a destroy or a move it was not entitled to never leaves, and the unsent copy is removable only after the server refused that submission', async () => {
    const server = new FakeJmapServer()
    const jmap = client(server)
    // before the folders are known, a move names nothing it may
    await expect(jmap.move(['x'], server.folder('inbox'), server.folder('archive'))).rejects.toThrow('may not ask')
    await jmap.folders()
    await expect(jmap.move(['x'], server.folder('inbox'), server.folder('trash'))).rejects.toThrow('may not ask')
    await expect(jmap.move(['x'], server.folder('drafts'), server.folder('archive'))).rejects.toThrow('may not ask')
    await expect(jmap.removeUnsent('anything')).rejects.toThrow('only the unsent copy')
    expect(
      server.requests.flatMap((r) => r.calls).filter((c) => c.args.destroy !== undefined || c.kind === 'move'),
    ).toEqual([])
  })

  test('everything else is refused: deleting, other flags, other folders, folders made, imports, a Bcc, a file, a second route out, an address that is not https', () => {
    const refused: [string, Record<string, unknown>][] = [
      ['Email/set', { accountId: 'c', destroy: ['e1', 'e2'] }],
      ['Email/set', { accountId: 'c', destroy: [] }],
      ['Email/set', { accountId: 'c', update: { e1: { 'keywords/$flagged': true } } }],
      ['Email/set', { accountId: 'c', update: { e1: { 'keywords/$seen': true, 'keywords/$junk': true } } }],
      ['Email/set', { accountId: 'c', update: { e1: { mailboxIds: { a: true } } } }],
      ['Email/set', { accountId: 'c', update: { e1: { 'mailboxIds/a/b': true } } }],
      ['Email/set', { accountId: 'c', update: { e1: { 'keywords/$seen': 'yes' } } }],
      ['Email/set', { accountId: 'c', update: {} }],
      ['Email/set', { accountId: 'c', create: { a: {}, b: {} } }],
      ['Email/set', { accountId: 'c', create: { out: { mailboxIds: { d: true }, bcc: [{ email: 'x@y.z' }] } } }],
      ['Email/set', { accountId: 'c', create: { out: { mailboxIds: { d: true }, attachments: [] } } }],
      ['Email/set', { accountId: 'c', create: { out: { mailboxIds: { d: true }, keywords: { $flagged: true } } } }],
      ['Email/set', { accountId: 'c', create: { out: { mailboxIds: { d: true, e: true } } } }],
      ['Email/set', { accountId: 'c', update: { e1: { 'keywords/$seen': true } }, destroy: ['e1'] }],
      ['Mailbox/set', { accountId: 'c', create: { x: { name: 'Nope' } } }],
      ['Mailbox/get', { accountId: 'c', create: {} }],
      ['Email/import', { accountId: 'c', emails: {} }],
      ['Email/copy', { fromAccountId: 'c', accountId: 'd', create: {} }],
      ['Identity/set', { accountId: 'c', create: {} }],
      ['VacationResponse/set', { accountId: 'c', update: {} }],
      ['SieveScript/set', { accountId: 'c', create: {} }],
      ['Blob/upload', { accountId: 'c' }],
      ['EmailSubmission/set', { accountId: 'c', destroy: ['s1'] }],
      [
        'EmailSubmission/set',
        {
          accountId: 'c',
          create: { a: { identityId: 'i', emailId: 'e', envelope: { mailFrom: { email: 'x@y.z' }, rcptTo: [] } } },
        },
      ],
      [
        'EmailSubmission/set',
        { accountId: 'c', create: { a: { identityId: 'i', emailId: 'e' } }, onSuccessDestroyEmail: ['#a'] },
      ],
      [
        'PushSubscription/set',
        { create: { p: { deviceClientId: 'x', url: 'http://example.com/x', types: ['Email'] } } },
      ],
      [
        'PushSubscription/set',
        { create: { p: { deviceClientId: 'x', url: 'https://example.com/x', types: ['Email'], keys: {} } } },
      ],
      ['PushSubscription/set', { update: { p1: { url: 'https://elsewhere.example/' } } }],
      ['PushSubscription/set', { update: { p1: { verificationCode: 'c' }, p2: { verificationCode: 'd' } } }],
      ['Principal/get', {}],
    ]
    for (const [name, args] of refused) expect(classify(name, args), `${name} ${JSON.stringify(args)}`).toBeNull()
  })
})

describe('the client', () => {
  test('every request it makes is on the list, every kind is used, and nothing outside the methods is called', async () => {
    const server = new FakeJmapServer()
    const jmap = client(server)
    server.deliver({})
    const id = server.deliver({ subject: 'one' })
    const cursor = await jmap.states()
    const folders = await jmap.folders()
    await jmap.identities()
    await jmap.list({ folderIds: [server.folder('inbox'), server.folder('sent')], after: null, position: 0, limit: 10 })
    const email = (await jmap.emails([id]))[0]
    await jmap.emails([id], { structure: true })
    await jmap.thread(email?.threadId as string)
    await jmap.raw(email?.blobId as string)
    server.markSeen(id, false)
    await jmap.changes(cursor, 100)
    await jmap.setSeen([id], true)
    await jmap.move([id], server.folder('inbox'), server.folder('archive'))
    const identity = (await jmap.identities())[0]
    const sent = await jmap.submit(
      {
        from: { name: 'Test', email: 'test@harborline.example' },
        to: ['tessa@northfield.example'],
        cc: [],
        subject: 'hello',
        body: 'hi',
        messageId: '<m1@harborline.example>',
        inReplyTo: null,
        references: [],
        identityId: identity?.id as string,
        at: '2026-11-05T12:00:00.000Z',
      },
      { drafts: server.folder('drafts'), sent: server.folder('sent') },
    )
    server.refuseSubmission = 'forbiddenFrom'
    await jmap
      .submit(
        {
          from: { name: 'Test', email: 'test@harborline.example' },
          to: ['tessa@northfield.example'],
          cc: [],
          subject: 'hello',
          body: 'hi',
          messageId: '<m2@harborline.example>',
          inReplyTo: null,
          references: [],
          identityId: identity?.id as string,
          at: '2026-11-05T12:00:00.000Z',
        },
        { drafts: server.folder('drafts'), sent: server.folder('sent') },
      )
      .catch((error) => (error as { emailId?: string }).emailId)
    const unsent = [...server.emails.values()].find((e) => e.messageId === '<m2@harborline.example>')
    await jmap.removeUnsent(unsent?.id as string)
    expect(sent.emailId).not.toBe('')
    const sub = await jmap.pushMake({
      url: 'https://inbox-push.northfield.example/jmap/abc',
      deviceClientId: 'space',
      types: ['Email', 'Mailbox'],
    })
    await jmap.pushGet()
    await jmap.pushVerify(sub.id, 'vc-wrong').catch(() => undefined)
    await jmap.pushRenew(sub.id, '2026-11-12T00:00:00.000Z')
    await jmap.pushRemove(sub.id)
    expect(folders.list.length).toBe(6)

    const calls = server.requests.flatMap((r) => r.calls)
    expect(calls.length).toBeGreaterThan(20)
    expect(calls.filter((c) => c.kind === null).map((c) => c.name)).toEqual([])
    expect(new Set(calls.map((c) => c.kind))).toEqual(new Set(ALLOWED_KINDS))
    expect(new Set(calls.map((c) => c.name))).toEqual(new Set(ALLOWED_METHODS))
    // beside the API: the session, and downloads of a message's raw bytes at the door's fixed path
    const paths = new Set(server.requests.map((r) => r.path))
    expect(
      [...paths].filter((p) => p !== '/jmap' && p !== '/jmap/session' && !p.startsWith('/jmap/download/')),
    ).toEqual([])
  })

  test('it never follows the hostname the session names: every request goes to the door', async () => {
    const server = new FakeJmapServer()
    const seen: string[] = []
    const jmap = createJmap({
      door: server.door,
      accessId: server.accessId,
      accessSecret: server.accessSecret,
      key: server.key,
      fetch: (url, init) => {
        seen.push(new URL(url).host)
        return server.fetch(url, init)
      },
    })
    await jmap.folders()
    await jmap.raw('blob-none').catch(() => undefined)
    expect(new Set(seen)).toEqual(new Set(['jmap-test.harborline.example']))
  })

  test('the only way a message is removed is the one unsent copy, and the client has one place that asks', () => {
    const source = require('node:fs').readFileSync(new URL('../src/jmap/client.ts', import.meta.url), 'utf8') as string
    expect(source.match(/destroy:/g)?.length).toBe(2)
    expect(source).toContain('destroy: [emailId]')
  })
})
