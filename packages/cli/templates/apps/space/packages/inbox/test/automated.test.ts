import { describe, expect, test } from 'bun:test'
import {
  isFreeMailAddress,
  isMachineAddressName,
  isNoReplyAddress,
  judgeSender,
  type SenderFacts,
  senderHint,
} from '../src/automated'
import type { SenderJudgment } from '../src/types'

/** The rule that says whether a contact is a person or an automated sender (src/automated.ts), by table. */

const email = (address: string) => ({ kind: 'email' as const, address })
const facts = (over: Partial<SenderFacts> = {}): SenderFacts => ({
  name: 'Dana Reyes',
  clientId: null,
  identities: [email('dana@acme.example')],
  conversations: 2,
  bulkConversations: 0,
  ...over,
})

const UNSUB = 'unsubscribe+9f8e7d6c5b4a3210@bounces.customer.io'

describe('a mailbox nobody reads', () => {
  test.each([
    ['noreply@github.com', true],
    ['no-reply@paddle.example', true],
    ['No-Reply@Paddle.example', true],
    ['donotreply@bank.example', true],
    ['do-not-reply@bank.example', true],
    ['do_not_reply@bank.example', true],
    ['no.reply@bank.example', true],
    ['noreply+abc123@bank.example', true],
    ['notifications@github.example', true],
    ['mailer-daemon@mail.example', true],
    ['postmaster@mail.example', true],
    // People answer from these, so they are not a reason on their own.
    ['hello@orbit.example', false],
    ['help@acme.example', false],
    ['support@acme.example', false],
    ['leads@pinecrest.example', false],
    ['billing@acme.example', false],
    ['replies@acme.example', false],
    ['noreplyto@acme.example', false],
    ['dana@acme.example', false],
    ['@acme.example', false],
    ['not an address', false],
  ])('%s is %p', (address, expected) => {
    expect(isNoReplyAddress(address)).toBe(expected)
  })
})

describe('a free-mail address', () => {
  test.each([
    ['milo_brandt@gmail.com', true],
    ['july_1nine@gmail.com', true],
    ['Carla_Yoon@GMAIL.COM', true],
    ['a@googlemail.com', true],
    ['a@yahoo.com', true],
    ['a@outlook.com', true],
    ['a@hotmail.com', true],
    ['a@icloud.com', true],
    ['a@me.com', true],
    ['a@aol.com', true],
    ['a@proton.me', true],
    ['a@protonmail.com', true],
    ['a@live.com', true],
    ['a@msn.com', true],
    // Only the whole domain: a company's own domain, or a subdomain, is not a free-mail address.
    ['news@mail.gmail.com', false],
    ['news@notgmail.example.com', false],
    ['news@gmail.com.example', false],
    ['dana@acme.example', false],
    ['gmail.com', false],
  ])('%s is %p', (address, expected) => {
    expect(isFreeMailAddress(address)).toBe(expected)
  })
})

describe('a name that is a machine-made address', () => {
  test.each([
    // Two unsubscribe shapes mail services write, and the sample one.
    ['71.q4x8w2n6b0c5t9hd@unsubscribe2.customer.io', true],
    ['0f1e2d3c-4b5a-4697-8a8b-9c0d1e2f3a4b+5c6d7e8f@unsub.beehiiv.com', true],
    [UNSUB, true],
    ['bounces+123456-ab12-dana=acme.example@mail.sendgrid.net', true],
    ['list-manage-3c2b1a0f9e8d7c@mail.example.org', true],
    ['9f8e7d6c5b4a3210@mail.example.com', true],
    ['unsub@news.example.com', true],
    ['abcdefghijklmnop1@example.com', true],
    ['6265550142123@example.com', true],
    // Real people and real mailboxes, however long their address is.
    ['corin.pike.roofing@example.com', false],
    ['leads@mail.pinecrestconstruction.example', false],
    ['leads@pinecrestconstruction.example', false],
    ['maximilian.featherstonehaugh@cholmondeley-and-partners.example', false],
    ['dana_r+acme@gmail.com', false],
    ['dana_1985@gmail.com', false],
    ['l@lumen.example', false],
    ['hello@orbit.example', false],
    // Not an address at all: a name somebody typed, or a display name with brackets.
    ['Dana Reyes of Acme Legal <dana@acme.example>', false],
    ['Maximilian Alexander Featherstonehaugh-Cholmondeley', false],
    ['', false],
  ])('%s is %p', (name, expected) => {
    expect(isMachineAddressName(name)).toBe(expected)
  })
})

describe('person or automated sender', () => {
  const cases: [string, SenderFacts, boolean, string, SenderJudgment['rule']][] = [
    ['an ordinary person', facts(), false, 'no rule', 'none'],
    ['someone with no conversations yet', facts({ conversations: 0 }), false, 'no rule', 'none'],
    [
      'a contact under a Client, whatever else it looks like',
      facts({ clientId: 1 }),
      false,
      'Under a Client',
      'client',
    ],
    [
      'a Client contact named by a machine-made address',
      facts({ clientId: 1, name: UNSUB, identities: [email(UNSUB)] }),
      false,
      'Under a Client',
      'client',
    ],
    [
      'a Client contact on a no-reply mailbox whose mail is all Bulk',
      facts({ clientId: 3, identities: [email('noreply@acme.example')], conversations: 4, bulkConversations: 4 }),
      false,
      'Under a Client',
      'client',
    ],
    [
      "Pinecrest's leads@ address with real conversations",
      facts({ name: 'leads@pinecrest.example', identities: [email('leads@pinecrest.example')], conversations: 5 }),
      false,
      'no rule',
      'none',
    ],
    [
      'a name that is a machine-made address',
      facts({ name: UNSUB, identities: [email(UNSUB)] }),
      true,
      'machine-made address',
      'name',
    ],
    [
      'a short address as a name is only a name',
      facts({ name: 'l@lumen.example', identities: [email('l@lumen.example')] }),
      false,
      'no rule',
      'none',
    ],
    [
      'a no-reply mailbox',
      facts({ name: 'GitHub', identities: [email('notifications@github.example')] }),
      true,
      'only address, notifications@github.example',
      'no-reply',
    ],
    [
      'every address a no-reply mailbox',
      facts({ identities: [email('noreply@a.example'), email('no-reply@b.example')] }),
      true,
      'such as noreply@a.example',
      'no-reply',
    ],
    [
      'a no-reply mailbox and a person at the same contact',
      facts({ identities: [email('noreply@a.example'), email('dana@a.example')] }),
      false,
      'no rule',
      'none',
    ],
    [
      'a no-reply-looking handle that is not an email address',
      facts({ identities: [{ kind: 'manual', address: 'noreply' }] }),
      false,
      'no rule',
      'none',
    ],
    [
      'a phone number',
      facts({ identities: [{ kind: 'sms', address: '+16265550142' }], conversations: 0 }),
      false,
      'no rule',
      'none',
    ],
    [
      'hello@ with Bulk conversations only',
      facts({ name: 'Orbit Team', identities: [email('hello@orbit.example')], conversations: 2, bulkConversations: 2 }),
      true,
      'All 2 of its conversations are Bulk',
      'bulk',
    ],
    [
      'a single Bulk conversation',
      facts({ conversations: 1, bulkConversations: 1 }),
      true,
      'only conversation is Bulk',
      'bulk',
    ],
    [
      'a person at gmail.com whose only conversation landed in Bulk',
      facts({
        name: 'milo_brandt@gmail.com',
        identities: [email('milo_brandt@gmail.com')],
        conversations: 1,
        bulkConversations: 1,
      }),
      false,
      'no rule',
      'none',
    ],
    [
      'a named person at gmail.com whose conversations are all Bulk',
      facts({
        name: 'Carla Yang',
        identities: [email('carla_yoon@gmail.com')],
        conversations: 3,
        bulkConversations: 3,
      }),
      false,
      'no rule',
      'none',
    ],
    [
      'a contact with a work address and a free-mail one, all Bulk',
      facts({
        identities: [email('dana@acme.example'), email('d.r@icloud.com')],
        conversations: 2,
        bulkConversations: 2,
      }),
      false,
      'no rule',
      'none',
    ],
    [
      'a free-mail address in a different case',
      facts({ identities: [email('July_1Nine@Gmail.com')], conversations: 1, bulkConversations: 1 }),
      false,
      'no rule',
      'none',
    ],
    [
      'a company mailbox on a subdomain of gmail.com is not free-mail',
      facts({ identities: [email('news@mail.gmail.com')], conversations: 2, bulkConversations: 2 }),
      true,
      'All 2 of its conversations are Bulk',
      'bulk',
    ],
    [
      'a gmail.com contact named by a machine-made address is still caught by the name rule',
      facts({
        name: '9f8e7d6c5b4a3210@mail.example.com',
        identities: [email('milo_b@gmail.com')],
        conversations: 1,
        bulkConversations: 1,
      }),
      true,
      'machine-made address',
      'name',
    ],
    [
      'a gmail.com noreply mailbox is still caught by the no-reply rule',
      facts({ name: 'Somebody', identities: [email('no-reply@gmail.com')], conversations: 1, bulkConversations: 1 }),
      true,
      'no-reply mailbox',
      'no-reply',
    ],
    [
      'a handle that merely looks like a free-mail address is not one, so Bulk still decides',
      facts({ identities: [{ kind: 'sms', address: 'x@gmail.com' }], conversations: 1, bulkConversations: 1 }),
      true,
      'only conversation is Bulk',
      'bulk',
    ],
    [
      'hello@ with one conversation that is not Bulk',
      facts({ name: 'Orbit Team', identities: [email('hello@orbit.example')], conversations: 3, bulkConversations: 2 }),
      false,
      'no rule',
      'none',
    ],
  ]

  test.each(cases)('%s', (_what, input, automated, reason, rule) => {
    const verdict = judgeSender(input)
    expect(verdict.automated).toBe(automated)
    expect(verdict.reason).toContain(reason)
    expect(verdict.rule).toBe(rule)
  })

  test('every verdict says why, in a sentence with no em dash', () => {
    for (const [, input] of cases) {
      const { reason } = judgeSender(input)
      expect(reason.length).toBeGreaterThan(10)
      expect(reason).toMatch(/\.$/)
      expect(reason).not.toContain('\u2014')
    }
  })
})

describe('what a person may do about a call', () => {
  const judged = (over: Partial<SenderFacts>) => judgeSender(facts(over))
  const byName = judged({ name: UNSUB, identities: [email(UNSUB)] })
  const noReply = judged({ identities: [email('noreply@a.example')] })
  const bulk = judged({ conversations: 2, bulkConversations: 2 })

  test('a person needs nothing', () => {
    expect(senderHint(judged({}), false)).toBeNull()
    expect(senderHint(judged({}), true)).toBeNull()
    expect(senderHint(judged({ clientId: 1 }), true)).toBeNull()
  })

  test('the name rule is undone by renaming, and a suggested Client may be linked', () => {
    expect(senderHint(byName, false)).toContain('Rename it')
    expect(senderHint(byName, false)).not.toContain('Link')
    expect(senderHint(byName, true)).toContain('Rename it')
    expect(senderHint(byName, true)).toContain('Link it to its Client')
  })

  test('no-reply and Bulk offer no hand fix, except Link when the inbox suggests a Client', () => {
    for (const verdict of [noReply, bulk]) {
      expect(senderHint(verdict, false)).toBeNull()
      expect(senderHint(verdict, true)).toContain('Link it to its Client')
      expect(senderHint(verdict, true)).not.toContain('Rename')
    }
  })
})
