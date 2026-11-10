import { describe, expect, test } from 'bun:test'
import {
  MAX_BODY,
  MAX_TITLE,
  messagePayload,
  NO_SUBJECT,
  type NotifyInput,
  notifyDecision,
  summaryPayload,
  testPayload,
} from '../src/notify/rule'
import type { SenderJudgment } from '../src/types'

/**
 * Which mail notifies, as a table, and what a
 * notification says. The rule is pure; the store asking it only for what the sync stores is test/notify-app.test.ts.
 */

const NOW = new Date('2026-10-21T12:00:00.000Z')
const PERSON: SenderJudgment = { automated: false, rule: 'none', reason: '' }
const CLIENT_PERSON: SenderJudgment = { automated: false, rule: 'client', reason: '' }
const NO_REPLY: SenderJudgment = { automated: true, rule: 'no-reply', reason: '' }

/** The rule's inputs with Bulk's facts and the sender as values; `decide` hands them over as the thunks the rule asks. */
type Plain = Omit<NotifyInput, 'conversation' | 'sender'> & {
  conversation: ReturnType<NotifyInput['conversation']>
  sender: SenderJudgment
}
const base: Plain = {
  labels: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
  from: 'marta@tamarackprint.test',
  own: new Set(['tessa@northfield.example']),
  conversation: { newestInbound: { labels: ['INBOX', 'UNREAD'], listUnsubscribe: false }, clientIds: [] },
  sender: PERSON,
  receivedAt: '2026-10-21T11:59:00.000Z',
  now: NOW,
}
const decide = (change: Partial<Plain>) => {
  const m = { ...base, ...change }
  return notifyDecision({ ...m, conversation: () => m.conversation, sender: () => m.sender })
}
const updates = { newestInbound: { labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'], listUnsubscribe: false } }

describe('which mail notifies', () => {
  test('a person writing, unread, in the Inbox, within the hour: yes', () => {
    expect(decide({})).toEqual({ notify: true })
  })

  const table: [string, Partial<Plain>, string][] = [
    [
      'anything Gmail marks Sent (Tessa from Gmail or the inbox, Claude on his word)',
      { labels: ['SENT', 'INBOX', 'UNREAD'] },
      'sent',
    ],
    [
      'from the mailbox’s own address (a note to self), whoever sent it',
      { from: 'tessa@northfield.example' },
      'own-address',
    ],
    [
      'not in Gmail’s Inbox (a filter archived it on arrival)',
      { labels: ['UNREAD', 'CATEGORY_PERSONAL'] },
      'not-in-inbox',
    ],
    ['already read in Gmail by the time the inbox has it', { labels: ['INBOX'] }, 'read'],
    ['Bulk: its newest inbound message is in Updates', { conversation: { ...updates, clientIds: [] } }, 'bulk'],
    [
      'Bulk: a List-Unsubscribe header',
      { conversation: { newestInbound: { labels: ['INBOX'], listUnsubscribe: true }, clientIds: [] } },
      'bulk',
    ],
    ['an automated sender (a no-reply mailbox)', { sender: NO_REPLY }, 'automated'],
    ['found more than an hour after Gmail received it', { receivedAt: '2026-10-21T10:59:59.000Z' }, 'stale'],
    ['a received time that is not a time', { receivedAt: 'garbage' }, 'stale'],
  ]
  for (const [what, change, reason] of table) {
    test(`no: ${what}`, () => {
      expect(decide(change)).toEqual({ notify: false, reason: reason as never })
    })
  }

  test('the store-wide checks (Bulk, the sender) are asked only when the cheap ones pass', () => {
    const asked: string[] = []
    const lazy = {
      conversation: () => {
        asked.push('conversation')
        return base.conversation
      },
      sender: () => {
        asked.push('sender')
        return PERSON
      },
    }
    for (const cheap of [
      { labels: ['SENT'] },
      { from: 'tessa@northfield.example' },
      { labels: ['UNREAD'] },
      { labels: ['INBOX'] },
      { receivedAt: '2026-10-21T10:00:00.000Z' },
    ]) {
      notifyDecision({ ...base, ...cheap, ...lazy })
    }
    expect(asked).toEqual([])
    expect(notifyDecision({ ...base, ...lazy })).toEqual({ notify: true })
    expect(asked).toEqual(['conversation', 'sender'])
  })

  test('exactly an hour old still notifies; the window is inclusive', () => {
    expect(decide({ receivedAt: '2026-10-21T11:00:00.000Z' })).toEqual({ notify: true })
  })

  test("a Client's person always counts: in Updates, it notifies, because the Bulk rule exempts their conversation", () => {
    expect(decide({ conversation: { ...updates, clientIds: [7] }, sender: CLIENT_PERSON })).toEqual({ notify: true })
  })

  test("a Client's person whose address looks automated is still a person: the contacts' rule says so, and so does this", () => {
    // judgeSender answers `client` for anyone under a Client; the rule takes the judgment as given.
    expect(decide({ sender: CLIENT_PERSON, from: 'notifications@client.test' })).toEqual({ notify: true })
  })

  test("a Client does not override Gmail's own Inbox, being read, or being ours", () => {
    const client = { conversation: { ...updates, clientIds: [7] }, sender: CLIENT_PERSON }
    expect(decide({ ...client, labels: ['UNREAD'] })).toEqual({ notify: false, reason: 'not-in-inbox' })
    expect(decide({ ...client, labels: ['INBOX'] })).toEqual({ notify: false, reason: 'read' })
    expect(decide({ ...client, from: 'tessa@northfield.example' })).toEqual({ notify: false, reason: 'own-address' })
  })
})

describe('what a notification says', () => {
  const m = {
    conversationId: 'c1',
    messageId: 'm1',
    name: 'Marta Vidal',
    address: 'marta@tamarackprint.test',
    subject: 'Re: Changes to the site',
    receivedAt: '2026-10-21T11:59:00.000Z',
  }

  test('the sender over the subject, and the ids a tap needs (the sender’s address in the spelling the space opens a conversation by), and nothing else', () => {
    expect(messagePayload(m)).toEqual({
      v: 1,
      kind: 'message',
      conversationId: 'c1',
      person: 'marta@tamarackprint.test',
      messageId: 'm1',
      title: 'Marta Vidal',
      body: 'Re: Changes to the site',
      at: '2026-10-21T11:59:00.000Z',
    })
  })

  test('a contact with no name is shown by its address; a message with no subject says so', () => {
    expect(messagePayload({ ...m, name: '  ', subject: ' ' })).toMatchObject({
      title: 'marta@tamarackprint.test',
      body: NO_SUBJECT,
    })
  })

  test('long names and subjects are cut to one line of 80 and 200 characters', () => {
    const p = messagePayload({ ...m, name: 'N'.repeat(300), subject: `line one\n\n${'S'.repeat(400)}` })
    expect(p.title.length).toBe(MAX_TITLE)
    expect(p.body.length).toBe(MAX_BODY)
    expect(p.body.startsWith('line one S')).toBe(true)
    expect(p.title.endsWith('…')).toBe(true)
  })

  test('the test notification names no conversation and says it is the space’s, so a tap opens the Conversations list', () => {
    expect(testPayload(new Date('2026-10-21T12:00:00Z'), 'Northfield Works')).toMatchObject({
      kind: 'test',
      conversationId: null,
      v: 1,
      title: 'Northfield Works Space',
    })
  })
})

describe('more than three at once are one notification', () => {
  const m = (id: string, name: string, address = `${id}@person.test`) => ({
    messageId: id,
    name,
    address,
    receivedAt: '2026-10-21T11:59:00.000Z',
  })
  const now = new Date('2026-10-21T12:00:00.000Z')

  test('how many, from whom by first name, each sender once, and the rest counted; the tap opens the Inbox', () => {
    const p = summaryPayload(
      [
        m('a', 'Marta Vidal'),
        m('b', 'Corin Pike'),
        m('c', 'Marta Vidal'),
        m('d', 'Dana Smith'),
        m('e', 'Eve Jones'),
        m('f', ''),
      ],
      now,
    )
    expect(p).toEqual({
      v: 1,
      kind: 'summary',
      conversationId: null,
      messageId: 'summary-a',
      title: '6 new messages',
      body: 'From Marta, Corin and 3 others',
      at: '2026-10-21T12:00:00.000Z',
    })
  })

  test('two senders are both named; one other is "1 other"; one sender alone is named alone', () => {
    expect(summaryPayload([m('a', 'Marta B'), m('b', 'Corin L'), m('c', 'Marta B'), m('d', 'Corin L')], now).body).toBe(
      'From Marta and Corin',
    )
    expect(summaryPayload([m('a', 'Ann'), m('b', 'Bob'), m('c', 'Cy'), m('d', 'Ann')], now).body).toBe(
      'From Ann, Bob and 1 other',
    )
    expect(summaryPayload([m('a', 'Ann'), m('b', 'Ann'), m('c', 'Ann'), m('d', 'Ann')], now).body).toBe('From Ann')
  })
})
