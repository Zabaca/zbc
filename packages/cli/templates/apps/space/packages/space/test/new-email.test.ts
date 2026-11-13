// A new email from scratch, a draft edited at a revision, and a thread called spam or not, in the space. Driven through the real
// router with the stand-in inbox behind the binding. What is asserted is what a person sees (the answers the page is given, what lands in the history) or what is refused: no sign-in is
// refused at every new path, a write is from this host and JSON (or the page's own form), the sender is a mailbox and never an address typed, the inbox's own words come through, a compose key
// makes a send go out at most once, and nothing is retried. The inbox's own side of every rule is packages/inbox/test/space-compose.test.ts.
import { describe, expect, test } from 'bun:test'
import { northfield } from '../../workspace/test/helpers'
import type { ConversationAnswer, WriteOutcome } from '../src/conversation'
import { parseEmail } from '../src/conversation'
import { fixtureViews } from '../src/fixture-views'
import { CHANGED_WORDS, type StandInDraft, standInInbox, standInMeet } from '../src/stand-ins'
import type { ViewAnswer } from '../src/views'
import { NORTHFIELD_TEAM, ago, contact, thread, world } from './world'

const ORIGIN = 'https://space.northfield.example'
const key = (n: number) => `compose-key-${String(n).padStart(8, '0')}`
const FOOT = 'ridgeway'
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
const file = (name = 'quote.pdf') => new File([PDF], name, { type: 'application/pdf' })

async function asOwner(o: { drafts?: StandInDraft[] } = {}) {
  const inbox = standInInbox(
    [
      { ...contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), client: { id: 7, name: 'Harbor Dental' } },
      contact('c-priya', 'Priya Nair', 'priya.n@example.org'),
    ],
    [
      thread('t-dana', ago(100), ['c-dana'], { subject: 'Homepage copy' }),
      thread('t-priya', ago(60), ['c-priya'], { subject: 'Hours question', mailbox: { id: FOOT, name: 'Ridgeway Cycles', address: 'info@ridgewaycycles.example' } }),
      thread('t-news', ago(40), ['c-priya'], { subject: 'Weekly deals', bulk: true }),
      thread('t-text', ago(30), ['c-priya'], { subject: '', kind: 'sms' }),
    ],
    { drafts: o.drafts ?? [], views: fixtureViews(ago(0)), now: () => ago(0) },
  )
  const meet = standInMeet({ direct: [], channels: [] })
  const w = await world(northfield(), NORTHFIELD_TEAM, { inbox: inbox, meet: meet }, undefined, { answerWithinMs: 60, writeWithinMs: 200 })
  const jwt = await w.signIn('tessa@northfield.example')
  const post = (path: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json' }) => w.call(path, { method: 'POST', jwt, headers, body: JSON.stringify(body) })
  const email = async (body: unknown) => (await (await post('/api/email', body)).json()) as WriteOutcome
  const form = (json: unknown, files: File[], headers: Record<string, string> = {}) => {
    const body = new FormData()
    body.set('json', JSON.stringify(json))
    for (const f of files) body.append('file', f, f.name)
    return w.call('/api/email/files', { method: 'POST', jwt, headers: { origin: ORIGIN, 'x-space-write': '1', ...headers }, body })
  }
  const view = async <T>(name: string, body: unknown) => {
    const res = await post(`/api/inbox/${name}`, body)
    expect([name, res.status]).toEqual([name, 200])
    return (await res.json()) as ViewAnswer<T>
  }
  const open = async (k: string) => (await (await w.call(`/api/conversation?key=${encodeURIComponent(k)}`, { jwt })).json()) as ConversationAnswer
  return { w, jwt, inbox, post, email, form, view, open }
}

const business = { kind: 'business', mailboxId: FOOT } as const
const nu = (n: number, extra: Record<string, unknown> = {}) => ({ key: key(n), address: 'new@example.net', subject: 'Your visit', text: 'We are glad you are coming in.', ...extra })

describe('a new email: what the page may ask', () => {
  test('goes to the inbox as a new email with the mailbox the person chose, and the answer is a done send', async () => {
    const s = await asOwner()
    expect(await s.email(nu(1, { from: business, name: 'New Person' }))).toEqual({ result: 'done', status: 'sent' })
    expect(s.inbox.sent).toEqual([{ key: key(1), address: 'new@example.net', name: 'New Person', subject: 'Your visit', text: 'We are glad you are coming in.', from: business }])
    // The person the space's check named is the one it handed on.
    expect(s.inbox.asked.askers.at(-1)).toBe('tessa@northfield.example')
  })

  test('with Gmail chosen, or nothing chosen, it says so: nothing is made up for a choice the person did not make', async () => {
    const s = await asOwner()
    await s.email(nu(2, { from: { kind: 'gmail' } }))
    await s.email(nu(3))
    expect(s.inbox.sent.map((x) => ('from' in x ? x.from : 'no from'))).toEqual([{ kind: 'gmail' }, 'no from'])
  })

  test('an address typed with a name around it is the bare address, and a blank name is none', async () => {
    const s = await asOwner()
    await s.email(nu(4, { address: 'New Person <NEW@Example.net>', name: '   ' }))
    expect(s.inbox.sent[0]).toMatchObject({ address: 'new@example.net' })
    expect('name' in (s.inbox.sent[0] as object)).toBe(false)
  })

  test('is refused before the inbox is asked: no address or one that is none, no subject, no words, a mailbox named any way but Gmail or a business mailbox’s id, a key of the wrong shape', async () => {
    const s = await asOwner()
    const bad = [
      nu(5, { address: 'not an address' }),
      nu(5, { address: undefined }),
      nu(5, { subject: undefined }),
      nu(5, { subject: 7 }),
      nu(5, { subject: 'x'.repeat(1001) }),
      nu(5, { text: '   ' }),
      nu(5, { text: undefined }),
      nu(5, { name: 4 }),
      nu(5, { from: 'info@ridgewaycycles.example' }),
      nu(5, { from: { kind: 'business' } }),
      nu(5, { from: { kind: 'business', mailboxId: 'a/b' } }),
      nu(5, { from: { kind: 'business', mailboxId: 12 } }),
      nu(5, { from: { kind: 'address', address: 'boss@example.net' } }),
      nu(5, { from: null }),
      { ...nu(5), key: 'short' },
      { ...nu(5), key: undefined },
    ]
    for (const body of bad) {
      const res = await s.post('/api/email', body)
      expect([body, res.status]).toEqual([body, 400])
    }
    expect(s.inbox.sent).toEqual([])
    expect(s.inbox.asked.sends).toEqual([])
  })

  test('the parser takes the three shapes apart: a draft, a reply and a new email, and a body that names two is none of them', () => {
    expect(parseEmail(nu(6))).toMatchObject({ ok: true, value: { address: 'new@example.net' } })
    expect(parseEmail({ key: key(6), draftId: 'd', rev: 1, through: null })).toMatchObject({ ok: true, value: { draftId: 'd' } })
    expect(parseEmail({ key: key(6), conversationId: 't', through: 1, text: 'x' })).toMatchObject({ ok: true, value: { conversationId: 't' } })
    // A reply that also names an address is a reply: the address is not read, so a person cannot aim a reply anywhere else.
    expect(parseEmail({ key: key(6), conversationId: 't', through: 1, text: 'x', address: 'a@b.example' })).toMatchObject({ ok: true, value: { conversationId: 't' } })
    expect((parseEmail({ key: key(6), conversationId: 't', through: 1, text: 'x', address: 'a@b.example' }) as { value: object }).value).not.toHaveProperty('address')
  })
})

describe('a new email: the compose key', () => {
  test('a second press with the same key sends nothing new and says the first went', async () => {
    const s = await asOwner()
    expect(await s.email(nu(10, { from: business }))).toEqual({ result: 'done', status: 'sent' })
    expect(await s.email(nu(10, { from: business }))).toEqual({ result: 'repeated', earlier: 'sent' })
    expect(await s.email(nu(10, { from: business }))).toEqual({ result: 'repeated', earlier: 'sent' })
    expect(s.inbox.sent).toHaveLength(1)
  })

  test('a refusal gives the message back with the same key: put right, it sends, and it was never held', async () => {
    const s = await asOwner()
    // The inbox's own refusals, in its words: an em dash, and an address that is ours.
    const dash = await s.email(nu(11, { text: 'Nice \u2014 to meet you.', from: business }))
    expect(dash).toMatchObject({ result: 'refused', reason: 'bad-request', message: expect.stringContaining('em dash') })
    const own = await s.email(nu(11, { address: 'info@ridgewaycycles.example', from: business }))
    expect(own).toMatchObject({ result: 'refused', reason: 'bad-request', message: expect.stringContaining('your own address') })
    expect(s.inbox.sent).toEqual([])
    expect(await s.email(nu(11, { from: business }))).toEqual({ result: 'done', status: 'sent' })
    expect(s.inbox.sent).toHaveLength(1)
  })

  test('a mailbox the inbox does not send from is refused in the inbox’s words, with nothing sent and the key free', async () => {
    const s = await asOwner()
    const refused = await s.email(nu(12, { from: { kind: 'business', mailboxId: 'nobody' } }))
    expect(refused).toMatchObject({ result: 'refused', reason: 'bad-request', message: expect.stringContaining('not one of the business mailboxes') })
    expect(await s.email(nu(12, { from: business }))).toEqual({ result: 'done', status: 'sent' })
  })

  test('when the inbox cannot say whether it went, it is a send to check, held: a repeat is told so and nothing goes again', async () => {
    const s = await asOwner()
    s.inbox.script.send.push('sending')
    expect(await s.email(nu(13))).toEqual({ result: 'done', status: 'sending' })
    expect(await s.email(nu(13))).toEqual({ result: 'repeated', earlier: 'sending' })
    expect(s.inbox.sent).toHaveLength(1)
  })

  test('when the space loses track of it, it is outcome unknown and never retried', async () => {
    const s = await asOwner()
    s.inbox.script.send.push('throw')
    expect(await s.email(nu(14))).toMatchObject({ result: 'outcome-unknown' })
    expect(s.inbox.asked.sends).toHaveLength(1)
  })

  test('a send that went is in the person’s history, closed as the inbox files a sent message, and the person is found by the address it went to', async () => {
    const s = await asOwner()
    await s.email(nu(15, { from: business, name: 'New Person' }))
    const opened = await s.open('new@example.net')
    expect(opened.row).toMatchObject({ type: 'person', name: 'New Person' })
    expect(opened.threads.map((t) => [t.subject, t.open, t.mailbox])).toEqual([['Your visit', false, 'Ridgeway Cycles']])
    expect(opened.sources[0]?.messages.map((m) => m.text)).toEqual(['We are glad you are coming in.'])
  })
})

describe('an inbox that predates what a new email depends on', () => {
  /** An inbox as it was before: its answer lists no capabilities, and it would ignore `from` and `attachments` without a word. */
  const older = async () => {
    const s = await asOwner()
    s.inbox.views.state.capabilities = undefined
    return s
  }

  test('a new email that picks a mailbox, or carries files, is refused in words and the inbox is never asked to send it', async () => {
    const s = await older()
    const picked = (await s.email(nu(50, { from: business }))) as { result: string; message: string }
    expect(picked.result).toBe('failed')
    expect(picked.message).toContain('has not been updated')
    expect(picked.message).toContain('Nothing was sent.')
    const gmail = await s.email(nu(51, { from: { kind: 'gmail' } }))
    expect(gmail).toMatchObject({ result: 'failed' })
    const withFiles = (await (await s.form(nu(52), [file()])).json()) as WriteOutcome
    expect(withFiles).toMatchObject({ result: 'failed', message: expect.stringContaining('has not been updated') })
    expect(s.inbox.asked.sends).toEqual([])
    expect(s.inbox.sent).toEqual([])
  })

  test('a plain new email, with no mailbox chosen and no files, still goes: it needs nothing the older inbox lacks', async () => {
    const s = await older()
    expect(await s.email(nu(53))).toEqual({ result: 'done', status: 'sent' })
    expect(s.inbox.sent).toHaveLength(1)
  })

  test('a reply with files is as it was before: it is not a new email, and the older inbox took it already', async () => {
    const s = await older()
    expect(await s.email({ key: key(54), conversationId: 't-priya', through: 1, text: 'Yes, Sundays.' })).toEqual({ result: 'done', status: 'sent' })
  })

  test('the answer that says so is the one the New email box reads: no capabilities from the older inbox, the capability from the new', async () => {
    const o = await older()
    const got = (await (await o.w.call('/api/inbox/mailboxes', { jwt: o.jwt })).json()) as ViewAnswer<{ capabilities?: string[] }>
    expect(got).toMatchObject({ result: 'ok' })
    expect('capabilities' in (got as { value: object }).value).toBe(false)
    const n = await asOwner()
    const now = (await (await n.w.call('/api/inbox/mailboxes', { jwt: n.jwt })).json()) as ViewAnswer<{ capabilities?: string[] }>
    expect((now as { value: { capabilities?: string[] } }).value.capabilities).toEqual(['new-email-from-and-files'])
  })

  test('an inbox that cannot be asked is not taken to be able: nothing is sent, and the words say it could not be told', async () => {
    const s = await asOwner()
    s.inbox.mailboxes = async () => {
      throw new Error('gone')
    }
    const out = await s.email(nu(55, { from: business }))
    expect(out).toMatchObject({ result: 'failed', message: expect.stringContaining('could not tell whether the inbox can do this') })
    expect(s.inbox.asked.sends).toEqual([])
  })
})

describe('a new email with files', () => {
  test('goes through the form like a reply with files, and carries them to the inbox from a business mailbox', async () => {
    const s = await asOwner()
    const res = await s.form(nu(20, { from: business }), [file('quote (final).pdf'), file('b.pdf')])
    expect(res.status).toBe(200)
    expect((await res.json()) as WriteOutcome).toEqual({ result: 'done', status: 'sent' })
    const sent = s.inbox.sent[0] as unknown as { attachments: { name: string; bytes: Uint8Array }[] }
    expect(sent.attachments.map((f) => [f.name, f.bytes.length])).toEqual([
      ['quote (final).pdf', PDF.length],
      ['b.pdf', PDF.length],
    ])
  })

  test('from Gmail they are refused in the inbox’s words and nothing is sent; without them the same key sends', async () => {
    const s = await asOwner()
    const refused = (await (await s.form(nu(21, { from: { kind: 'gmail' } }), [file()])).json()) as WriteOutcome
    expect(refused).toMatchObject({ result: 'refused', reason: 'bad-request', message: expect.stringContaining('Ridgeway') })
    expect(s.inbox.sent).toEqual([])
    expect(await s.email(nu(21, { from: { kind: 'gmail' } }))).toEqual({ result: 'done', status: 'sent' })
  })

  test('a repeat with the same key sends nothing new, files or not', async () => {
    const s = await asOwner()
    expect((await (await s.form(nu(22, { from: business }), [file()])).json()) as WriteOutcome).toEqual({ result: 'done', status: 'sent' })
    expect((await (await s.form(nu(22, { from: business }), [file()])).json()) as WriteOutcome).toEqual({ result: 'repeated', earlier: 'sent' })
    expect(s.inbox.sent).toHaveLength(1)
  })

  test('is refused before the inbox is asked: too many files, an empty one, a form that names a draft, another site, or no mark of the page', async () => {
    const s = await asOwner()
    const many = Array.from({ length: 11 }, (_, n) => file(`f${n}.pdf`))
    expect((await s.form(nu(23, { from: business }), many)).status).toBe(400)
    expect((await s.form(nu(23, { from: business }), [new File([], 'empty.pdf')])).status).toBe(400)
    expect((await s.form({ key: key(23), draftId: 'd', rev: 1, through: null }, [file()])).status).toBe(400)
    expect((await s.form(nu(23, { from: business }), [file()], { origin: 'https://evil.example' })).status).toBe(403)
    const bare = new FormData()
    bare.set('json', JSON.stringify(nu(23, { from: business })))
    expect((await s.w.call('/api/email/files', { method: 'POST', jwt: s.jwt, headers: { origin: ORIGIN }, body: bare })).status).toBe(415)
    expect(s.inbox.sent).toEqual([])
  })
})

describe('editing a draft', () => {
  const draft = (extra: Partial<StandInDraft> = {}): StandInDraft => ({ id: 'd-1', conversationId: 't-dana', contactId: 'c-dana', subject: 'Re: Homepage copy', text: 'Thank you both.', author: 'claude', at: ago(30), ...extra })

  test('saves the subject and the words at the revision shown, and the card is given the draft as it now stands', async () => {
    const s = await asOwner({ drafts: [draft()] })
    const got = await s.view<{ id: string; rev: number; subject: string; text: string }>('draft-edit', { draftId: 'd-1', rev: 1, subject: 'Re: Homepage', text: 'Thanks, all.' })
    expect(got).toMatchObject({ result: 'ok', value: { id: 'd-1', rev: 2, subject: 'Re: Homepage', text: 'Thanks, all.' } })
    expect(s.inbox.asked.edits).toEqual([{ draftId: 'd-1', rev: 1, subject: 'Re: Homepage', text: 'Thanks, all.' }])
    const opened = await s.open('dana@harbor.example')
    expect(opened.drafts[0]).toMatchObject({ rev: 2, subject: 'Re: Homepage', text: 'Thanks, all.' })
  })

  test('a Cc replaces the draft’s list at the revision shown, alone or with the words, and [] takes every address off', async () => {
    const s = await asOwner({ drafts: [draft()] })
    const added = await s.view<{ rev: number; cc: { address: string }[] }>('draft-edit', { draftId: 'd-1', rev: 1, cc: ['ann@example.org', 'bob@example.net'] })
    expect(added).toMatchObject({ result: 'ok', value: { rev: 2 } })
    expect(s.inbox.asked.edits[0]).toEqual({ draftId: 'd-1', rev: 1, cc: ['ann@example.org', 'bob@example.net'] })
    expect((await s.open('dana@harbor.example')).drafts[0]?.cc?.map((c: { address: string }) => c.address)).toEqual(['ann@example.org', 'bob@example.net'])
    expect(await s.view('draft-edit', { draftId: 'd-1', rev: 2, cc: ['nobody'] })).toMatchObject({ result: 'refused', reason: 'bad-request' })
    const cleared = await s.view<{ cc: unknown[] }>('draft-edit', { draftId: 'd-1', rev: 2, cc: [] })
    expect(cleared).toMatchObject({ result: 'ok', value: { cc: [], rev: 3 } })
  })

  test('a draft that changed since is a conflict in the inbox’s words, nothing is saved, and a repeat is the same conflict', async () => {
    const s = await asOwner({ drafts: [draft({ rev: 3 })] })
    const stale = await s.view('draft-edit', { draftId: 'd-1', rev: 1, text: 'Mine.' })
    expect(stale).toEqual({ result: 'refused', reason: 'conflict', message: CHANGED_WORDS })
    expect((await s.open('dana@harbor.example')).drafts[0]).toMatchObject({ rev: 3, text: 'Thank you both.' })
    expect(await s.view('draft-edit', { draftId: 'd-1', rev: 3, text: 'Mine.' })).toMatchObject({ result: 'ok' })
    expect(await s.view('draft-edit', { draftId: 'd-1', rev: 3, text: 'Mine.' })).toMatchObject({ result: 'refused', reason: 'conflict' })
  })

  test('is refused before the inbox is asked: no draft, no revision, nothing to change, words or a subject that are not text, past a draft’s length', async () => {
    const s = await asOwner({ drafts: [draft()] })
    for (const body of [{ rev: 1, text: 'x' }, { draftId: 'a/b', rev: 1, text: 'x' }, { draftId: 'd-1', text: 'x' }, { draftId: 'd-1', rev: '1', text: 'x' }, { draftId: 'd-1', rev: 1 }, { draftId: 'd-1', rev: 1, text: 7 }, { draftId: 'd-1', rev: 1, subject: null }, { draftId: 'd-1', rev: 1, text: 'x'.repeat(100_001) }, { draftId: 'd-1', rev: 1, cc: 'ann@example.org' }, { draftId: 'd-1', rev: 1, cc: [7] }, { draftId: 'd-1', rev: 1, cc: Array.from({ length: 51 }, (_, n) => `p${n}@example.org`) }]) {
      const res = await s.post('/api/inbox/draft-edit', body)
      expect([body, res.status]).toEqual([body, 400])
    }
    expect(s.inbox.asked.edits).toEqual([])
  })

  test('the inbox’s own refusals come through: a body left empty, a message that is not there, a stuck send', async () => {
    const s = await asOwner({ drafts: [draft(), draft({ id: 'd-s', stuck: true, author: 'outbox' })] })
    expect(await s.view('draft-edit', { draftId: 'd-1', rev: 1, text: '   ' })).toMatchObject({ result: 'refused', reason: 'bad-request', message: 'A draft needs a body.' })
    expect(await s.view('draft-edit', { draftId: 'nope', rev: 1, text: 'x' })).toMatchObject({ result: 'refused', reason: 'not-found' })
    expect(await s.view('draft-edit', { draftId: 'd-s', rev: 1, text: 'x' })).toMatchObject({ result: 'refused', reason: 'conflict' })
  })

  test('is never retried: an inbox that does not answer is an outcome unknown, asked once', async () => {
    const s = await asOwner({ drafts: [draft()] })
    s.inbox.editDraft = async () => {
      throw new Error('gone')
    }
    expect(await s.view('draft-edit', { draftId: 'd-1', rev: 1, text: 'x' })).toMatchObject({ result: 'outcome-unknown' })
  })

  test('names who is copied only when asked, takes it only as yes or no, and an edit of nothing at all is refused', async () => {
    const s = await asOwner({ drafts: [draft()] })
    for (const body of [{ draftId: 'd-1', rev: 1, copyEveryone: 'yes' }, { draftId: 'd-1', rev: 1 }]) {
      const res = await s.post('/api/inbox/draft-edit', body)
      expect([body, res.status]).toEqual([body, 400])
    }
    expect(await s.view('draft-edit', { draftId: 'd-1', rev: 1, copyEveryone: true })).toMatchObject({ result: 'ok' })
    expect(s.inbox.asked.edits).toEqual([{ draftId: 'd-1', rev: 1, copyEveryone: true }])
  })

  test('the card is given why it was drafted, who changed it, and whether it can copy everyone', async () => {
    const s = await asOwner({ drafts: [draft({ why: 'Dana asked.', editedBy: 'assistant' })] })
    const d = (await s.open('dana@harbor.example')).drafts[0]
    expect(d).toMatchObject({ why: 'Dana asked.', editedBy: 'assistant', canCopyEveryone: true })
  })

  test('nothing is sent by it: the draft is still waiting, and sending it names the new revision', async () => {
    const s = await asOwner({ drafts: [draft()] })
    await s.view('draft-edit', { draftId: 'd-1', rev: 1, text: 'Changed.' })
    expect(s.inbox.sent).toEqual([])
    const opened = await s.open('dana@harbor.example')
    const d = opened.drafts[0]
    expect(d).toBeDefined()
    expect(await s.email({ key: key(30), draftId: d?.id, rev: 1, through: d?.through })).toMatchObject({ result: 'refused', reason: 'conflict' })
    expect(await s.email({ key: key(31), draftId: d?.id, rev: d?.rev, through: d?.through })).toEqual({ result: 'done', status: 'sent' })
  })
})

describe('marking a thread as spam, or not', () => {
  test('moves a thread of a mailbox to Bulk and back, and the answer says where it stands and why', async () => {
    const s = await asOwner()
    const spam = await s.view<{ conversationId: string; spam: boolean; bulk: boolean; reasons: string[] }>('spam', { conversationId: 't-dana', spam: true })
    // Dana's person is a Client's: the inbox keeps her thread in the Inbox and says so.
    expect(spam).toMatchObject({ result: 'ok', value: { conversationId: 't-dana', spam: true, bulk: false } })
    const priya = await s.view<{ bulk: boolean; reasons: string[] }>('spam', { conversationId: 't-priya', spam: true })
    expect(priya).toMatchObject({ result: 'ok', value: { spam: true, bulk: true } })
    expect((await s.open('priya.n@example.org')).threads.find((t) => t.conversationId === 't-priya')?.bulk).toBe(true)
    expect(await s.view('spam', { conversationId: 't-priya', spam: false })).toMatchObject({ result: 'ok', value: { spam: false, bulk: false } })
    expect((await s.open('priya.n@example.org')).threads.find((t) => t.conversationId === 't-priya')?.bulk).toBe(false)
    expect(s.inbox.asked.spam).toEqual([
      { conversationId: 't-dana', spam: true },
      { conversationId: 't-priya', spam: true },
      { conversationId: 't-priya', spam: false },
    ])
  })

  test('is refused before the inbox is asked: no conversation, no boolean (an empty body can never mean either), a boolean in words', async () => {
    const s = await asOwner()
    for (const body of [{ spam: true }, { conversationId: 't-priya' }, { conversationId: 't-priya', spam: 'true' }, { conversationId: 't-priya', spam: 1 }, { conversationId: 'a/b', spam: true }, {}]) {
      const res = await s.post('/api/inbox/spam', body)
      expect([body, res.status]).toEqual([body, 400])
    }
    expect(s.inbox.asked.spam).toEqual([])
  })

  test('the inbox’s own refusals come through: a conversation that is not there, and one in no mailbox', async () => {
    const s = await asOwner()
    expect(await s.view('spam', { conversationId: 'nope', spam: true })).toMatchObject({ result: 'refused', reason: 'not-found' })
    expect(await s.view('spam', { conversationId: 't-text', spam: true })).toMatchObject({ result: 'refused', reason: 'bad-request' })
  })

  test('is never retried: an inbox that does not answer is an outcome unknown', async () => {
    const s = await asOwner()
    s.inbox.setSpam = async () => {
      throw new Error('gone')
    }
    expect(await s.view('spam', { conversationId: 't-priya', spam: true })).toMatchObject({ result: 'outcome-unknown' })
  })
})

describe('what every new write has to be', () => {
  test('from this host, as JSON: another site’s origin, no origin, a body that is not JSON and a read are all refused, and the inbox hears of none', async () => {
    const s = await asOwner()
    for (const path of ['/api/inbox/draft-edit', '/api/inbox/spam']) {
      const body = JSON.stringify(path.endsWith('spam') ? { conversationId: 't-priya', spam: true } : { draftId: 'd-1', rev: 1, text: 'x' })
      const call = (headers: Record<string, string>, b = body, method = 'POST') => s.w.call(path, { method, jwt: s.jwt, headers, body: method === 'POST' ? b : undefined })
      expect([path, (await call({ 'content-type': 'application/json' })).status]).toEqual([path, 403])
      expect([path, (await call({ origin: 'https://evil.example', 'content-type': 'application/json' })).status]).toEqual([path, 403])
      expect([path, (await call({ origin: ORIGIN, 'content-type': 'text/plain' })).status]).toEqual([path, 415])
      expect([path, (await call({ origin: ORIGIN, 'content-type': 'application/json' }, 'not json')).status]).toEqual([path, 400])
      // A GET is a read of something that is not one: there is no such view.
      expect([path, (await call({}, '', 'GET')).status]).toEqual([path, 404])
      expect([path, (await call({ origin: ORIGIN }, '', 'PUT')).status]).toEqual([path, 405])
    }
    expect(s.inbox.asked.edits).toEqual([])
    expect(s.inbox.asked.spam).toEqual([])
  })

  test('another company’s person is refused at every new write, and nothing is asked of the inbox', async () => {
    const s = await asOwner()
    const stranger = await s.w.signIn('lane@pinecrest.test')
    for (const path of ['/api/email', '/api/inbox/draft-edit', '/api/inbox/spam']) {
      const res = await s.w.call(path, { method: 'POST', jwt: stranger, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(nu(40)) })
      expect([path, res.status]).toEqual([path, 403])
    }
    const form = new FormData()
    form.set('json', JSON.stringify(nu(40)))
    expect((await s.w.call('/api/email/files', { method: 'POST', jwt: stranger, headers: { origin: ORIGIN, 'x-space-write': '1' }, body: form })).status).toBe(403)
    expect(s.inbox.asked.sends).toEqual([])
    expect(s.inbox.asked.edits).toEqual([])
    expect(s.inbox.asked.spam).toEqual([])
  })
})
