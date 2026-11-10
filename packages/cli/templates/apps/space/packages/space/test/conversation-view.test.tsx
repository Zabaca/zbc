// What a person sees when a conversation is open, drawn from the answer the Worker gives the page. The answers are made by the real code over
// stand-in apps (not written by hand), so a change to the merge or the reply rule shows here as what changed on screen.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DocumentSummary } from '@space/workspace'
import { T0, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { type Compose, begin, newCompose, settle, typed } from '../src/client/compose'
import { ConversationView, type ViewProps } from '../src/client/Conversation'
import { type Opened, openConversation } from '../src/conversation'
import type { Scope } from '../src/conversations'
import { type StandInChatMessage, type StandInDraft, type StandInThread, fixtureApps, standInForms, standInInbox, standInMeet } from '../src/stand-ins'
import { requestFor } from '../src/client/compose'
import { NORTHFIELD_TEAM, ago, channel, contact, dm, person, thread, world } from './world'
import { OWNER_SIGNED_IN } from './signed-in'

const install = northfield()
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, install)
const chat = (id: number, at: number, text: string, mine = false): StandInChatMessage => ({ id, at, authorId: mine ? 'p-tessa' : 'p-x', authorName: mine ? 'Tessa' : 'Dana', text, mine })

const dana = person('p-dana', 'Dana Reyes', 'dana@harbor.example')
const priya = person('p-priya', 'Priya Natarajan', 'priya@northfield.example', 'teammate')

const threads: StandInThread[] = [
  thread('t-shared', ago(100), ['c-dana', 'c-marcus'], { subject: 'Homepage copy', unread: true }),
  thread('t-invoice', ago(500), ['c-dana'], { subject: 'Invoice 1042' }),
]
const drafts: StandInDraft[] = [{ id: 'd-1', conversationId: 't-shared', contactId: 'c-dana', subject: 'Re: Homepage copy', text: 'Thank you both.', author: 'claude', at: ago(60) }]

async function open(key: string, over: { drafts?: StandInDraft[]; chatDown?: boolean; forms?: ReturnType<typeof standInForms>; scope?: Scope } = {}): Promise<Extract<Opened, { ok: true }>['value']> {
  const inbox = standInInbox([{ ...contact('c-dana', 'Dana Reyes', 'dana@harbor.example'), client: { id: 7, name: 'Harbor Dental' } }, contact('c-marcus', 'Marcus Chen', 'marcus@harbor.example'), contact('c-pri', 'Priya', 'priya@northfield.example')], [...threads, thread('t-pri', ago(40), ['c-pri'], { subject: 'Payroll' })], { drafts: over.drafts ?? drafts })
  const meet = standInMeet(
    { direct: [dm(11, dana, ago(10), 1), dm(12, priya, ago(30))], channels: [channel(21, 'launch', ago(5), 2)] },
    { history: { 11: [chat(1, ago(200), 'Hello Tessa'), chat(2, ago(10), 'Can we talk Thursday?')], 12: [chat(3, ago(30), 'Lunch?')], 21: [chat(4, ago(5), 'Staging is up')] } },
  )
  if (over.chatDown) meet.history = async () => ({ ok: false, kind: 'failed', reason: 'broken', message: 'down' })
  const opened = await openConversation({ apps: { inbox, meet, ...(over.forms && { forms: over.forms }) }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, key, over.scope)
  if (!opened.ok) throw new Error(opened.message)
  return opened.value
}

const idle = (over: Partial<ViewProps> & Pick<ViewProps, 'answer'>): ViewProps => ({
  me: ME,
  now: T0,
  sources: over.answer.sources,
  loadingEarlier: false,
  onEarlier: () => undefined,
  way: 'email',
  onWay: () => undefined,
  threadId: null,
  onThread: () => undefined,
  compose: newCompose(),
  onText: () => undefined,
  onSend: () => undefined,
  onSendAndClose: () => undefined,
  onClose: () => undefined,
  onReopen: () => undefined,
  reopen: null,
  changing: false,
  changed: null,
  onDismiss: () => undefined,
  drafts: {},
  onSendDraft: () => undefined,
  onDismissDraft: () => undefined,
  onDraftChanged: () => undefined,
  profileOpen: false,
  onProfile: () => undefined,
  onBack: () => undefined,
  timeZone: 'UTC',
  ...over,
})
const view = (over: Partial<ViewProps> & Pick<ViewProps, 'answer'>) => renderToStaticMarkup(<ConversationView {...idle(over)} />)
const entriesIn = (html: string) => [...html.matchAll(/data-testid="entry" data-kind="(\w+)">.*?<div class="msg-text">([^<]*)<\/div>/gs)].map((m) => `${m[1]}: ${m[2]}`)

describe('the history', () => {
  test('a person’s emails and direct messages read as one conversation, each email under its subject, "with" the others on a shared thread', async () => {
    const html = view({ answer: await open('dana@harbor.example') })
    expect(entriesIn(html).map((e) => e.split(':')[0])).toEqual(['email', 'chat', 'email', 'chat'])
    expect(html).toContain('Email: Homepage copy, with Marcus Chen')
    expect(html).toContain('Email: Invoice 1042')
    expect(html).toContain('Direct message')
    expect(html.indexOf('Email: Invoice 1042')).toBeLessThan(html.indexOf('Email: Homepage copy'))
  })

  test('an email cut at the inbox’s cap says so and sends no one to the inbox, whose page is going', async () => {
    const answer = await open('dana@harbor.example')
    const sources = answer.sources.map((src) => (src.kind === 'mail' ? { ...src, messages: src.messages.map((m) => ({ ...m, textCut: true })) } : src))
    const html = view({ answer, sources })
    expect(html).toContain('longer than the inbox keeps')
    expect(html).not.toContain('Read all of it in the inbox')
  })

  test('the header names the person and their business; a channel is its name with a hash', async () => {
    const html = view({ answer: await open('dana@harbor.example') })
    expect(html).toContain('<h2 data-testid="convo-title">Dana Reyes</h2>')
    expect(html).toContain('Harbor Dental')
    expect(view({ answer: await open('chat:channel:21') })).toContain('<h2 data-testid="convo-title"># launch</h2>')
  })

  test('a part that did not answer is said, while the other’s history shows', async () => {
    const html = view({ answer: await open('dana@harbor.example', { chatDown: true }) })
    expect(html).toContain('Chat had a problem and could not answer just now, so its messages are missing here.')
    expect(html).toContain('Email: Homepage copy')
    expect(html).not.toContain('data-kind="chat"')
  })

  test('older messages are one button when there are more, and not otherwise', async () => {
    const answer = await open('dana@harbor.example')
    expect(view({ answer })).not.toContain('data-testid="earlier"')
    const more = answer.sources.map((s) => ({ ...s, more: true }))
    expect(view({ answer, sources: more })).toContain('data-testid="earlier"')
    expect(view({ answer, sources: more, loadingEarlier: true })).toContain('Loading')
  })
})

describe('the reply', () => {
  test('to an outside person is an email in a thread, and a shared thread says it goes to all of them', async () => {
    const html = view({ answer: await open('dana@harbor.example') })
    expect(html).toContain('data-testid="composer" data-way="email"')
    expect(html).toContain('Reply all to Dana Reyes and Marcus Chen')
    expect(html).toContain('data-all="true"')
    expect(html).toContain('Send to all')
    expect(html).toContain('In: Homepage copy')
    expect(html).toContain('In: Invoice 1042') // the thread is the person’s to choose
    expect(html).toContain('data-testid="way-chat"') // and a direct message is one tap away, for someone who has both
  })

  test('in a thread of one it is an email to that person and sends to them alone', async () => {
    const html = view({ answer: await open('dana@harbor.example'), threadId: 't-invoice' })
    expect(html).toContain('Email to Dana Reyes')
    expect(html).toContain('data-all="false"')
    expect(html).toContain('Send email')
  })

  test('to a teammate is a direct message, with no email choice', async () => {
    const listed = await open('priya@northfield.example')
    const html = view({ answer: listed, way: 'chat' })
    expect(html).toContain('data-testid="composer" data-way="chat"')
    expect(html).toContain('Direct message to Priya')
    expect(html).not.toContain('data-testid="thread-select"')
  })

  test('in a channel is a post', async () => {
    const html = view({ answer: await open('chat:channel:21'), way: 'chat' })
    expect(html).toContain('Post in #launch')
    expect(html).not.toContain('data-testid="way-email"')
  })

  test('a refusal is shown in the inbox’s words, with the message still there and Send ready', async () => {
    const answer = await open('dana@harbor.example')
    const before = begin(typed(newCompose(), 'Thanks both.'))
    const refused = settle(before, { result: 'refused', reason: 'conflict', message: 'A new message arrived in this conversation. Read it, then press Send again.' }, 'email')
    const html = view({ answer, compose: refused })
    expect(html).toContain('A new message arrived in this conversation. Read it, then press Send again.')
    expect(html).toContain('data-tone="error"')
    expect(html).toContain('>Thanks both.</textarea>')
    expect(html).not.toMatch(/disabled=""[^>]*data-testid="send"/)
    expect(html).toMatch(/data-testid="send"/)
  })

  test('OUTCOME UNKNOWN says to check Sent and offers no Send, only another message', async () => {
    const answer = await open('dana@harbor.example')
    const before = begin(typed(newCompose(), 'Did it go?'))
    const lost = settle(before, { result: 'outcome-unknown', message: 'x' }, 'email')
    const html = view({ answer, compose: lost })
    expect(html).toContain('Check Sent in your mail before writing it again')
    expect(html).toContain('data-testid="write-another"')
    expect(html).not.toContain('data-testid="send"')
    expect(html).toContain('readOnly')
  })

  test('a repeated send shows what happened the first time', async () => {
    const html = view({ answer: await open('dana@harbor.example'), compose: settle(begin(typed(newCompose(), 'x')), { result: 'repeated', earlier: 'sent' }, 'email') })
    expect(html).toContain('That was already sent the first time. Nothing new went out.')
  })

  test('while it is being sent the box waits', async () => {
    const compose: Compose = begin(typed(newCompose(), 'x'))
    const html = view({ answer: await open('dana@harbor.example'), compose })
    expect(html).toMatch(/disabled=""[^>]*data-testid="send"/)
    expect(html).toContain('Sending')
  })

  test('a person who can only be texted says so in place of a box', async () => {
    const inbox = standInInbox([contact('c-text', '(626) 555-0142')], [thread('t-sms', ago(5), ['c-text'], { kind: 'sms', subject: '' })])
    const opened = await openConversation({ apps: { inbox, meet: standInMeet({ direct: [], channels: [] }) }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, 'mail:c-text')
    if (!opened.ok) throw new Error(opened.message)
    const html = view({ answer: opened.value })
    expect(html).toContain('data-testid="composer-none"')
    expect(html).toContain('cannot be answered from the space')
    expect(html).toContain('Text messages')
  })
})

describe('the draft waiting', () => {
  test('is in place with who wrote it, what it says, a way to send it as it stands and a way to edit it here', async () => {
    const html = view({ answer: await open('dana@harbor.example') })
    expect(html).toContain('data-testid="draft" data-draft="d-1"')
    expect(html).toContain('Draft from Claude')
    expect(html).toContain('Thank you both.')
    expect(html).toContain('data-testid="send-draft"')
    expect(html).toContain('Send as it stands')
    // Editing is in the space now: a button on the card, and no link out to the inbox.
    expect(html).toContain('data-testid="edit-draft"')
    expect(html).not.toContain('Edit in the inbox')
    expect(html).not.toContain('inbox.northfield.example')
  })

  test('is not on a conversation it does not belong to', async () => {
    expect(view({ answer: await open('priya@northfield.example') })).not.toContain('data-testid="draft"')
  })

  test('one Gmail never confirmed is shown with no way to send it', async () => {
    const stuck: StandInDraft = { id: 'd-s', conversationId: 't-shared', contactId: 'c-dana', subject: 'Re', text: 'Maybe.', author: 'outbox', stuck: true, at: ago(9) }
    const html = view({ answer: await open('dana@harbor.example', { drafts: [stuck] }) })
    expect(html).toContain('Not confirmed as sent')
    expect(html).toContain('Gmail did not say whether this went out, so it has not been sent again. Check Gmail Sent, then say which it was.')
    expect(html).not.toContain('data-testid="send-draft"')
  })

  test('a refused send of it says why on the card and can be pressed again; an unknown one cannot', async () => {
    const answer = await open('dana@harbor.example')
    const begun = begin({ ...newCompose(), text: 'Thank you both.' })
    const refused = settle(begun, { result: 'refused', reason: 'conflict', message: 'A new message arrived in this conversation. Read it, then press Send again.' }, 'email')
    const again = view({ answer, drafts: { 'd-1': refused } })
    expect(again).toContain('A new message arrived in this conversation')
    expect(again).toContain('data-testid="send-draft"')
    const lost = settle(begun, { result: 'outcome-unknown', message: 'x' }, 'email')
    expect(view({ answer, drafts: { 'd-1': lost } })).not.toContain('data-testid="send-draft"')
  })
})

describe('the profile', () => {
  test('beside it, for an outsider: their business, addresses and whether a direct message is open', async () => {
    const html = view({ answer: await open('dana@harbor.example') })
    expect(html).toContain('data-testid="profile" data-kind="outside"')
    expect(html).toContain('Harbor Dental')
    expect(html).toContain('dana@harbor.example')
    expect(html).toContain('A direct message is open')
    expect(html).not.toContain('Notes') // the People fields are a later step
  })

  test('for a teammate it is the company layer’s person; for a channel its kind and size', async () => {
    const team = view({ answer: await open('priya@northfield.example') })
    expect(team).toContain('data-kind="team"')
    expect(team).toContain('Teammate')
    const room = view({ answer: await open('chat:channel:21') })
    expect(room).toContain('Open channel')
    expect(room).toContain('4 people')
  })

  test('on a phone it is one tap away: a button over the conversation, and a way back from it', async () => {
    const answer = await open('dana@harbor.example')
    expect(view({ answer })).toContain('data-testid="open-profile"')
    expect(view({ answer })).toContain('class="e-convo"')
    const showing = view({ answer, profileOpen: true })
    expect(showing).toContain('class="e-convo away"')
    expect(showing).toContain('class="e-profile open"')
    expect(showing).toContain('data-testid="close-profile"')
  })

  test('the way back to the list is a link, which a phone shows over the conversation, to the tab the conversation is in', async () => {
    expect(view({ answer: await open('dana@harbor.example') })).toContain('href="/inbox" data-testid="back"')
    const inbox = view({ scope: 'mail', answer: await open('dana@harbor.example', { scope: 'mail' }) })
    expect(inbox).toContain('href="/inbox" data-testid="back"')
    expect(inbox).toContain('Inbox</a>')
    const meet = view({ scope: 'chat', answer: await open('chat:channel:21', { scope: 'chat' }) })
    expect(meet).toContain('href="/meet" data-testid="back"')
    expect(meet).toContain('Meet</a>')
  })

  test('Send for signature is the Inbox’s: a document goes to a person’s email, so Meet’s conversation has no such button', async () => {
    expect(view({ scope: 'mail', answer: await open('dana@harbor.example', { scope: 'mail' }) })).toContain('data-testid="send-for-signature"')
    expect(view({ scope: 'chat', answer: await open('dana@harbor.example', { scope: 'chat' }) })).not.toContain('data-testid="send-for-signature"')
    expect(view({ scope: 'chat', answer: await open('chat:channel:21', { scope: 'chat' }) })).not.toContain('data-testid="send-for-signature"')
  })

  test('the Inbox’s conversation is the person’s emails with the email reply and no direct message to write; Meet’s is the direct message with no email', async () => {
    const mail = view({ scope: 'mail', answer: await open('dana@harbor.example', { scope: 'mail' }) })
    expect(mail).toContain('data-way="email"')
    expect(mail).not.toContain('data-testid="way-chat"')
    expect(mail).not.toContain('Can we talk Thursday?')
    expect(mail).toContain('Homepage copy')
    const meet = view({ scope: 'chat', way: 'chat', answer: await open('dana@harbor.example', { scope: 'chat' }) })
    expect(meet).toContain('data-way="chat"')
    expect(meet).not.toContain('data-testid="way-email"')
    expect(meet).toContain('Can we talk Thursday?')
    expect(meet).not.toContain('Homepage copy')
    expect(meet).not.toContain('data-testid="close-conversation"')
  })
})

describe('the fixtures a local page is photographed with', () => {
  test('open every kind of conversation the list shows', async () => {
    const { inbox, meet } = fixtureApps(T0)
    for (const key of ['dana@harbordental.example', 'lena@fischerbakery.example', 'priya@northfield.example', 'chat:channel:21', 'mail:c-text']) {
      const opened = await openConversation({ apps: { inbox, meet }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50 }, key)
      expect([key, opened.ok]).toEqual([key, true])
    }
  })
})

describe('a draft that copies other people', () => {
  const marcus = { name: 'Marcus Chen', address: 'marcus@harbor.example' }
  const withCc = (cc: StandInDraft['cc']): StandInDraft[] => [{ id: 'd-cc', conversationId: 't-shared', contactId: 'c-dana', subject: 'Re: Homepage copy', text: 'Thank you both.', author: 'claude', at: ago(60), cc }]

  test('is shown with its To and every Cc by name and address, and what a send as it stands reaches is exactly what was shown', async () => {
    const inbox = standInInbox(
      [{ ...contact('c-dana', 'Dana Reyes', 'dana@harbor.example') }, contact('c-marcus', 'Marcus Chen', 'marcus@harbor.example')],
      threads,
      { drafts: withCc([marcus]) },
    )
    const meet = standInMeet({ direct: [], channels: [] })
    const w = await world(install, NORTHFIELD_TEAM, { inbox: inbox, meet: meet }, undefined, { answerWithinMs: 50, writeWithinMs: 200 })
    const jwt = await w.signIn('tessa@northfield.example')
    const answer = (await (await w.call('/api/conversation?key=dana%40harbor.example', { jwt })).json()) as Awaited<ReturnType<typeof open>>
    const html = view({ answer })
    expect(html).toContain('data-testid="draft-to"')
    expect(html).toContain('To Dana Reyes &lt;dana@harbor.example&gt;')
    expect(html).toContain('Cc Marcus Chen &lt;marcus@harbor.example&gt;')
    expect(html).toContain('data-testid="send-draft"')

    const draft = answer.drafts[0]!
    const r = requestFor({ via: 'draft', draftId: draft.id, rev: draft.rev, through: draft.through }, 'compose-key-00000001', '')
    const res = await w.call(r.url, { method: 'POST', jwt, headers: { origin: 'https://space.northfield.example', 'content-type': 'application/json' }, body: JSON.stringify(r.body) })
    expect(await res.json()).toEqual({ result: 'done', status: 'sent' })
    // Everyone the send reached is on the card the person pressed Send on.
    expect(inbox.reached).toHaveLength(1)
    for (const address of [inbox.reached[0]!.to, ...inbox.reached[0]!.cc]) expect(html).toContain(address)
  })

  test('FAIL-SAFE: a draft whose answer does not say who it copies is not sent from the space, only edited in the inbox', async () => {
    const answer = await open('dana@harbor.example', { drafts: withCc(null) })
    expect(answer.drafts[0]).toMatchObject({ cc: null, sendable: false })
    const html = view({ answer })
    expect(html).not.toContain('data-testid="send-draft"')
    expect(html).toContain('The inbox did not say who this draft copies, so the space will not send it')
    expect(html).toContain('data-testid="edit-draft"')
  })

  test('a draft that copies no one shows only its To', async () => {
    const html = view({ answer: await open('dana@harbor.example', { drafts: withCc([]) }) })
    expect(html).toContain('To Dana Reyes')
    expect(html).not.toContain('data-testid="draft-cc"')
  })
})

// ── Documents ───────────────────────────────────────────────────────────────────────────────────────────────────────

const doc = (id: string, title: string, state: DocumentSummary['state'], made: number, over: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id,
  title,
  state,
  createdAt: made,
  sentAt: state === 'draft' ? null : made + 60_000,
  completedAt: null,
  signers: 2,
  signed: 0,
  notSigned: ['Dana Reyes', 'Marcus Chen'],
  conversation: { app: 'inbox', id: 'c-dana' },
  ...over,
})
const cardsIn = (html: string) => [...html.matchAll(/data-testid="document-card" data-state="(\w+)" data-doc="([^"]+)"/g)].map((m) => `${m[2]}: ${m[1]}`)

describe('documents sent from the conversation, as cards', () => {
  test('a document out for signature is a card with its title, its state and a button that opens it in Forms', async () => {
    const forms = standInForms([doc('e-photo', 'Photo release', 'sent', ago(180), { signed: 1 })])
    const html = view({ answer: await open('dana@harbor.example', { forms }) })
    expect(cardsIn(html)).toEqual(['e-photo: sent'])
    expect(html).toContain('Photo release')
    expect(html).toContain('Out for signature, 1 of 2 signed')
    expect(html).toContain('href="/forms/envelopes/e-photo"')
    expect(html).toContain('Open in Forms')
    expect(html).not.toContain('The signed copy is back')
  })

  test('a completed one says the signed copy is back and opens that copy’s page', async () => {
    const forms = standInForms([doc('e-agreement', 'Website agreement', 'completed', ago(1000), { signed: 2, completedAt: ago(20), notSigned: [] })])
    const html = view({ answer: await open('dana@harbor.example', { forms }) })
    expect(cardsIn(html)).toEqual(['e-agreement: completed'])
    expect(html).toContain('Signed and back')
    expect(html).toContain('The signed copy is back')
    expect(html).toContain('Open the signed copy')
    expect(html).toContain('href="/forms/envelopes/e-agreement"')
  })

  test('a card sits among the messages by time, the finished one below what came before it', async () => {
    const forms = standInForms([doc('e-agreement', 'Website agreement', 'completed', ago(1000), { signed: 2, completedAt: ago(20), notSigned: [] })])
    const html = view({ answer: await open('dana@harbor.example', { forms }) })
    // Dana's last direct message is 10 minutes ago, the signed copy came back 20 minutes ago: it is above that message and below the shared thread (100 minutes).
    expect(html.indexOf('Homepage copy')).toBeLessThan(html.indexOf('data-testid="document-card"'))
    expect(html.indexOf('data-testid="document-card"')).toBeLessThan(html.indexOf('Can we talk Thursday?'))
  })

  test('a card is in the conversation it carries and not another', async () => {
    const forms = standInForms([doc('e-photo', 'Photo release', 'sent', ago(180))])
    expect(cardsIn(view({ answer: await open('dana@harbor.example', { forms }) }))).toEqual(['e-photo: sent'])
    expect(cardsIn(view({ answer: await open('priya@northfield.example', { forms }) }))).toEqual([])
    expect(cardsIn(view({ answer: await open('chat:channel:21', { forms }) }))).toEqual([])
  })

  test('nothing a document holds is on the page: no name of one who has not signed, no address, no answer', async () => {
    const forms = standInForms([doc('e-intake', 'Customer details', 'sent', ago(180), { notSigned: ['Dana Reyes', 'Marcus Chen'] })])
    const html = view({ answer: await open('chat:channel:21', { forms: standInForms([doc('e-room', 'Room doc', 'sent', ago(60), { conversation: { app: 'meet', id: '21' } })]) }) })
    expect(cardsIn(html)).toEqual(['e-room: sent'])
    const card = /<div class="card doc[^"]*" data-testid="document-card".*?(?=<div class="trow-wrap"|<\/div><div class="composer|$)/s.exec(view({ answer: await open('dana@harbor.example', { forms }) }))![0]
    expect(card).toContain('Customer details')
    expect(card).not.toContain('Marcus Chen')
    expect(card).not.toContain('@')
  })

  test('forms that did not answer is a line over the history, which is shown as it is', async () => {
    const forms = standInForms([])
    forms.documentsIn = async () => {
      throw new Error('down')
    }
    const html = view({ answer: await open('dana@harbor.example', { forms }) })
    expect(html).toContain('data-part="documents"')
    expect(html).toContain('Forms could not be reached just now, so the documents sent from here are not shown.')
    expect(entriesIn(html).length).toBe(4)
  })

  test('Send for signature is a link to Forms’ Send screen carrying the conversation, on a person’s conversation and on a channel’s', async () => {
    const forms = standInForms([])
    const person = view({ answer: await open('dana@harbor.example', { forms }) })
    expect(person).toContain('data-testid="send-for-signature"')
    expect(person).toContain('href="/forms/send?from=dana%40harbor.example"')
    expect(view({ answer: await open('chat:channel:21', { forms }) })).toContain('href="/forms/send?from=chat%3Achannel%3A21"')
  })
})
