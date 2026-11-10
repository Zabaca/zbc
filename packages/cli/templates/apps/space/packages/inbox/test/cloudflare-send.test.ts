import { describe, expect, test } from 'bun:test'
import {
  bindingSender,
  buildOutgoing,
  EmailRefused,
  messageIdOf,
  refusalOf,
  sentCopy,
  sentCopyKey,
} from '../src/cloudflare/send'
import { MimeError } from '../src/gmail/mime'
import { cloudflareNotifyDecision, messagePayload } from '../src/notify/rule'
import type { CloudflareSendPlan } from '../src/store/mail'
import { belongsToMailbox } from '../src/store/store'
import { FakeEmailBinding } from '../test-support/fake-email'

/**
 * Sending as a Cloudflare mailbox as pure functions: what is handed to the binding (a table test over a plan), what each thing
 * the binding can throw means, and the Message-ID a sent message is filed under. The order around the call is
 * ridgeway-send.test.ts. Nothing here reaches Cloudflare.
 */

const plan = (over: Partial<CloudflareSendPlan> = {}): CloudflareSendPlan => ({
  transport: 'cloudflare',
  id: 'm1',
  rev: 0,
  mailboxId: 'mb1',
  from: 'info@ridgewaycycles.example',
  fromName: 'Ridgeway Cycles',
  to: 'priya@example.org',
  cc: [],
  subject: 'Re: Hours question',
  body: 'Yes, we are open Saturdays.',
  inReplyTo: '<a@mail.example>',
  references: ['<a@mail.example>'],
  at: '2026-10-26T18:00:00.000Z',
  instruction: null,
  ...over,
})

describe('the structured message', () => {
  test('is the mailbox’s own address with its name, to the recipient, plain text, with the threading headers and nothing else', () => {
    expect(buildOutgoing(plan())).toEqual({
      from: 'Ridgeway Cycles <info@ridgewaycycles.example>',
      to: 'priya@example.org',
      cc: [],
      subject: 'Re: Hours question',
      text: 'Yes, we are open Saturdays.',
      headers: { 'In-Reply-To': '<a@mail.example>', References: '<a@mail.example>' },
      attachments: [],
    })
  })

  test('a new email carries no threading headers at all', () => {
    expect(buildOutgoing(plan({ inReplyTo: null, references: [] })).headers).toEqual({})
  })

  test('names the parent too when the answered message had one, and drops the oldest of a chain too long for a header', () => {
    expect(buildOutgoing(plan({ references: ['<p@mail.example>', '<a@mail.example>'] })).headers.References).toBe(
      '<p@mail.example> <a@mail.example>',
    )
    const long = Array.from({ length: 60 }, (_, i) => `<${'x'.repeat(40)}${i}@mail.example>`)
    const out = buildOutgoing(plan({ references: long, inReplyTo: long.at(-1) as string })).headers.References as string
    expect(out.length).toBeLessThanOrEqual(1800)
    expect(out.endsWith(long.at(-1) as string)).toBe(true)
  })

  test('never names a Message-ID or a Date of its own, which Cloudflare refuses whole', () => {
    const names = Object.keys(buildOutgoing(plan()).headers).map((n) => n.toLowerCase())
    expect(names).not.toContain('message-id')
    expect(names).not.toContain('date')
  })

  test('carries the Cc list, and with no name the bare address', () => {
    expect(buildOutgoing(plan({ cc: ['b@example.org'], fromName: '' }))).toMatchObject({
      from: 'info@ridgewaycycles.example',
      cc: ['b@example.org'],
    })
  })

  test.each([
    ['a subject with a line break, which would add a header', { subject: 'Hi\r\nBcc: evil@example.org' }],
    ['a subject with a control character', { subject: 'Hi\u0000there' }],
    ['a recipient with a name around it', { to: 'Priya <priya@example.org>' }],
    ['a recipient with a second address inside', { to: 'a@example.org,b@example.org' }],
    ['a Cc that is not an address', { cc: ['nobody'] }],
    ['a sender that is not a bare address', { from: 'Info <info@ridgewaycycles.example>' }],
    ['a sender name that poses as an address', { fromName: 'boss@example.org' }],
    ['a sender name with a quote', { fromName: 'Ridgeway "Cycles"' }],
    ['a sender name with a control character', { fromName: 'Ridgeway\nCycles' }],
    ['a reply to something that is not a Message-ID', { inReplyTo: 'not an id', references: ['not an id'] }],
  ] as [string, Partial<CloudflareSendPlan>][])('refuses %s', (_name, over) => {
    expect(() => buildOutgoing(plan(over))).toThrow(MimeError)
  })
})

describe('what the binding’s answer means', () => {
  test.each([
    ['E_RECIPIENT_NOT_ALLOWED', 422],
    ['E_RECIPIENT_SUPPRESSED', 422],
    ['E_VALIDATION_ERROR', 422],
    ['E_FIELD_MISSING', 422],
    ['E_TOO_MANY_RECIPIENTS', 422],
    ['E_CONTENT_TOO_LARGE', 422],
    ['E_SENDER_NOT_VERIFIED', 502],
    ['E_SENDER_DOMAIN_NOT_AVAILABLE', 502],
    ['E_ACCOUNT_SUSPENDED', 502],
    ['E_RATE_LIMIT_EXCEEDED', 502],
    ['E_DAILY_LIMIT_EXCEEDED', 502],
    ['E_HEADER_NOT_ALLOWED', 502],
    ['E_HEADERS_TOO_MANY', 502],
  ])('%s is a refusal that says nothing went out, answered %d', (code, status) => {
    const refused = refusalOf(Object.assign(new Error('No.'), { code }))
    expect(refused).toBeInstanceOf(EmailRefused)
    expect(refused).toMatchObject({ code, status })
    expect(refused?.message).toContain(code)
  })

  test.each([
    ['a delivery failure, which may have been handed on', Object.assign(new Error('x'), { code: 'E_DELIVERY_FAILED' })],
    ['an internal error', Object.assign(new Error('x'), { code: 'E_INTERNAL_SERVER_ERROR' })],
    ['a code nobody documented', Object.assign(new Error('x'), { code: 'E_NEW' })],
    ['an inherited name that is not a code', Object.assign(new Error('x'), { code: 'toString' })],
    ['an error with no code', new Error('connection reset')],
    ['something that is not an error', 'the connection dropped'],
    ['nothing', undefined],
  ])('%s is NOT a refusal: it may have gone out', (_name, error) => {
    expect(refusalOf(error)).toBeNull()
  })

  test('the binding sender hands over the structured form, leaving out an empty Cc and empty headers, and answers the id', async () => {
    const binding = new FakeEmailBinding()
    const sender = bindingSender(binding as unknown as SendEmail)
    const answer = await sender.send({
      from: 'Ridgeway Cycles <info@ridgewaycycles.example>',
      to: 'priya@example.org',
      cc: [],
      subject: 'Hi',
      text: 'Hello.',
      headers: {},
      attachments: [],
    })
    expect(answer).toEqual({ messageId: 'cf-1@ridgewaycycles.example' })
    expect(binding.handed[0]).toEqual({
      from: 'Ridgeway Cycles <info@ridgewaycycles.example>',
      to: 'priya@example.org',
      subject: 'Hi',
      text: 'Hello.',
    })
    await sender.send({
      from: 'info@ridgewaycycles.example',
      to: 'priya@example.org',
      cc: ['b@example.org'],
      subject: 'Hi',
      text: 'Hello.',
      headers: { 'In-Reply-To': '<a@x.y>' },
      attachments: [],
    })
    expect(binding.handed[1]).toMatchObject({ cc: ['b@example.org'], headers: { 'In-Reply-To': '<a@x.y>' } })
  })

  test('an answer with no id is still an acceptance, filed with no Message-ID; a throw is never one', async () => {
    const binding = new FakeEmailBinding()
    const sender = bindingSender(binding as unknown as SendEmail)
    const message = {
      from: 'i@f.example',
      to: 'p@e.example',
      cc: [],
      subject: 'Hi',
      text: 'Hello.',
      headers: {},
      attachments: [],
    }
    binding.always({ kind: 'accept', messageId: null })
    expect(await sender.send(message)).toEqual({ messageId: null })
    binding.always({ kind: 'throw', code: 'E_RECIPIENT_NOT_ALLOWED' })
    await expect(sender.send(message)).rejects.toBeInstanceOf(EmailRefused)
    binding.always({ kind: 'throw', code: 'E_DELIVERY_FAILED' })
    await expect(sender.send(message)).rejects.not.toBeInstanceOf(EmailRefused)
  })
})

describe('the Message-ID a sent message is filed under', () => {
  test.each([
    ['cf-1@ridgewaycycles.example', '<cf-1@ridgewaycycles.example>'],
    ['<cf-1@ridgewaycycles.example>', '<cf-1@ridgewaycycles.example>'],
    ['  abc123  ', '<abc123>'],
    ['', null],
    ['   ', null],
    [null, null],
    ['two words', null],
    ['<>', null],
    ['a<b', null],
  ])('%j is %j', (reported, filed) => {
    expect(messageIdOf(reported)).toBe(filed)
  })
})

describe('the copy kept when Cloudflare accepts', () => {
  test('is the request exactly as handed over and the id Cloudflare reported, under out/ beside the received mail', () => {
    const request = buildOutgoing(plan())
    expect(sentCopyKey('m1')).toBe('out/m1')
    expect(
      JSON.parse(
        sentCopy({
          id: 'm1',
          request,
          reportedId: 'cf-1@x.y',
          sentAt: '2026-10-26T18:00:00.000Z',
          sentBy: 'tessa@northfield.example',
        }),
      ),
    ).toEqual({
      kind: 'sent-through-cloudflare',
      id: 'm1',
      sentAt: '2026-10-26T18:00:00.000Z',
      sentBy: 'tessa@northfield.example',
      reportedMessageId: 'cf-1@x.y',
      request,
    })
  })
})

describe('the notification rule for a Ridgeway arrival', () => {
  const now = new Date('2026-10-26T18:30:00.000Z')
  const ask = (over: Partial<Parameters<typeof cloudflareNotifyDecision>[0]> = {}) =>
    cloudflareNotifyDecision({
      bulk: false,
      own: false,
      open: true,
      unread: true,
      receivedAt: '2026-10-26T18:00:00.000Z',
      now,
      ...over,
    })
  test('notifies for Inbox mail within the hour, whether or not anything judged it', () => {
    expect(ask()).toEqual({ notify: true })
  })
  test('does not for the mailbox’s own address or its domain, for mail past the hour, for a conversation already read or closed, or for Bulk', () => {
    expect(ask({ own: true, receivedAt: '2026-10-26T18:29:00.000Z' })).toEqual({ notify: false, reason: 'own-address' })
    expect(ask({ receivedAt: '2026-10-26T17:00:00.000Z' })).toEqual({ notify: false, reason: 'stale' })
    expect(ask({ unread: false })).toEqual({ notify: false, reason: 'read' })
    expect(ask({ open: false })).toEqual({ notify: false, reason: 'closed' })
    expect(ask({ bulk: true })).toEqual({ notify: false, reason: 'bulk' })
  })
  test('the notification names the mailbox with the sender, and the subject, and nothing else', () => {
    const payload = messagePayload({
      conversationId: 'c1',
      messageId: 'm1',
      name: 'Priya N',
      address: 'priya@example.org',
      subject: 'Hours question',
      receivedAt: '2026-10-26T18:00:00.000Z',
      mailbox: 'Ridgeway Cycles',
    })
    expect(payload).toMatchObject({ title: 'Ridgeway Cycles: Priya N', body: 'Hours question', kind: 'message' })
    expect(
      messagePayload({
        conversationId: 'c1',
        messageId: 'm1',
        name: '',
        address: 'p@e.example',
        subject: 's',
        receivedAt: 'x',
      }).title,
    ).toBe('p@e.example')
  })
})

describe('whose address is the mailbox’s own', () => {
  const sender = {
    id: 'mb1',
    address: 'info@ridgewaycycles.example',
    name: 'Ridgeway Cycles',
    domain: 'ridgewaycycles.example',
  }
  test.each([
    ['info@ridgewaycycles.example', true],
    ['inbox-test@ridgewaycycles.example', true],
    ['anyone@ridgewaycycles.example', true],
    ['tessa@northfield.example', false],
    ['priya@ridgewaycycles.example.example.org', false],
    ['priya@sub.ridgewaycycles.example', false],
    ['info@xridgewaycycles.example', false],
  ])('%s is ours: %j', (address, ours) => {
    expect(belongsToMailbox(sender, address)).toBe(ours)
  })
})
