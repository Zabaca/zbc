// One message being written: its key, what became of it, and the two things it must never do, go out twice or be offered again when the space
// cannot tell whether it went. Pure functions on literal outcomes.
import { describe, expect, test } from 'bun:test'
import { COMPOSE_KEY } from '@space/workspace'
import { begin, canSend, dismissed, isOutcome, mintKey, newCompose, outcomeFromResponse, requestFor, settle, typed } from '../src/client/compose'
import type { WriteOutcome } from '../src/conversation'

let n = 0
const mint = () => `minted-key-${String(++n).padStart(8, '0')}`
const written = (text = 'Hello') => typed(newCompose(mint), text)

describe('the key', () => {
  test('is made once per compose, in the shape the apps take, and a new compose has a new one', () => {
    expect(COMPOSE_KEY.test(mintKey())).toBe(true)
    expect(COMPOSE_KEY.test(mintKey(() => '123e4567-e89b-12d3-a456-426614174000'))).toBe(true)
    expect(mintKey()).not.toBe(mintKey())
    const c = written()
    expect(typed(c, 'More text').key).toBe(c.key) // typing does not make another
    expect(begin(typed(c, 'More')).key).toBe(c.key)
  })

  test('is the same on a second press while the first waits: the message is asked once', () => {
    const c = begin(written())
    expect(c.phase).toBe('sending')
    expect(canSend(c)).toBe(false)
    expect(begin(c)).toBe(c)
    expect(typed(c, 'changed while sending')).toBe(c)
  })

  test('nothing is sent for an empty message', () => {
    expect(canSend(newCompose(mint))).toBe(false)
    expect(canSend(written('   '))).toBe(false)
    expect(begin(written('   ')).phase).toBe('writing')
  })
})

describe('after the answer', () => {
  const outcomes: Record<string, WriteOutcome> = {
    sent: { result: 'done', status: 'sent' },
    sending: { result: 'done', status: 'sending' },
    repeated: { result: 'repeated', earlier: 'sent' },
  }

  test('a message that went is finished: a new compose, a new key, empty, with "Sent."', () => {
    const before = begin(written())
    const after = settle(before, outcomes.sent!, 'email', mint)
    expect(after).toMatchObject({ text: '', phase: 'writing', notice: { tone: 'ok', text: 'Sent.' } })
    expect(after.key).not.toBe(before.key)
  })

  test('Gmail that never said is a success with a warning that says to check Sent, and the next message has its own key', () => {
    const after = settle(begin(written()), outcomes.sending!, 'email', mint)
    expect(after.notice).toEqual({ tone: 'warn', text: 'Gmail did not say whether this went out. Check Sent in your mail before writing it again.' })
    expect(after.phase).toBe('writing')
  })

  test('a repeat shows what happened the first time, and sends nothing', () => {
    expect(settle(begin(written()), { result: 'repeated', earlier: 'sent' }, 'email', mint).notice?.text).toBe('That was already sent the first time. Nothing new went out.')
    expect(settle(begin(written()), { result: 'repeated', earlier: 'sending' }, 'email', mint).notice?.text).toContain('Gmail did not say whether it went out')
    expect(settle(begin(written()), { result: 'repeated', earlier: 'in-progress' }, 'email', mint).notice?.text).toBe('That is still being sent. Nothing new went out.')
  })

  test('a refusal shows the inbox’s own words and gives the message back with the same key, ready to send again', () => {
    const before = begin(written('Keep me'))
    const after = settle(before, { result: 'refused', reason: 'conflict', message: 'A new message arrived in this conversation. Read it, then press Send again.' }, 'email', mint)
    expect(after).toEqual({ key: before.key, text: 'Keep me', phase: 'writing', notice: { tone: 'error', text: 'A new message arrived in this conversation. Read it, then press Send again.' } })
    expect(canSend(after)).toBe(true)
    expect(begin(after).key).toBe(before.key)
  })

  test('a failure that sent nothing is given back the same way', () => {
    const before = begin(written('Keep me'))
    const after = settle(before, { result: 'failed', message: 'Gmail would not take the message.' }, 'email', mint)
    expect([after.key, after.text, after.phase, after.notice?.text]).toEqual([before.key, 'Keep me', 'writing', 'Nothing was sent. Gmail would not take the message.'])
  })

  test('OUTCOME UNKNOWN says where to check, offers no way to send, and a new message needs a new key', () => {
    const before = begin(written('Did it go?'))
    const mail = settle(before, { result: 'outcome-unknown', message: 'x' }, 'email', mint)
    expect(mail.phase).toBe('unknown')
    expect(mail.notice?.text).toContain('Check Sent in your mail before writing it again')
    expect(mail.notice?.text).toContain('will not be sent a second time from here')
    expect(canSend(mail)).toBe(false)
    expect(begin(mail)).toBe(mail)
    expect(typed(mail, 'edit')).toBe(mail)
    expect(settle(before, { result: 'outcome-unknown', message: 'x' }, 'chat', mint).notice?.text).toContain('Check the conversation before writing it again')
    const fresh = dismissed(mint)
    expect(fresh.phase).toBe('writing')
    expect(fresh.key).not.toBe(before.key)
  })
})

describe('what the page makes of the Worker’s response', () => {
  test('an outcome in a 200 is that outcome', () => {
    expect(outcomeFromResponse({ status: 200, body: { result: 'done', status: 'sent' } })).toEqual({ result: 'done', status: 'sent' })
    expect(outcomeFromResponse({ status: 200, body: { result: 'refused', reason: 'conflict', message: 'Read it first.' } })).toEqual({ result: 'refused', reason: 'conflict', message: 'Read it first.' })
  })

  test('a sign-in that ended, or a request the Worker would not take, sent nothing: the message is given back', () => {
    expect(outcomeFromResponse({ status: 401, body: null })).toMatchObject({ result: 'refused', reason: 'not-signed-in' })
    expect(outcomeFromResponse({ status: 0, type: 'opaqueredirect', body: null })).toMatchObject({ result: 'refused', reason: 'not-signed-in' })
    expect(outcomeFromResponse({ status: 403, body: { error: 'Cross-site request refused' } })).toEqual({ result: 'failed', message: 'Cross-site request refused' })
    expect(outcomeFromResponse({ status: 400, body: { error: 'A reply needs something to say.' } })).toEqual({ result: 'failed', message: 'A reply needs something to say.' })
  })

  test('anything that leaves it unclear whether the Worker sent is UNKNOWN: a dropped connection, a 5xx, a 200 that is not an outcome', () => {
    for (const res of ['network', { status: 500, body: { error: 'Internal error' } }, { status: 502, body: null }, { status: 200, body: { hello: 'world' } }, { status: 200, body: null }] as const) {
      expect([JSON.stringify(res), outcomeFromResponse(res).result]).toEqual([JSON.stringify(res), 'outcome-unknown'])
    }
  })

  test('a body is an outcome only if it is exactly one of the five shapes', () => {
    expect(isOutcome({ result: 'done', status: 'maybe' })).toBe(false)
    expect(isOutcome({ result: 'refused', reason: 'whatever', message: 'x' })).toBe(false)
    expect(isOutcome({ result: 'repeated', earlier: 'later' })).toBe(false)
    expect(isOutcome({ result: 'outcome-unknown', message: 'x' })).toBe(true)
  })
})

describe('the requests', () => {
  test('an email names the thread, how far was read, the key and the text, and copies everyone only on a shared thread', () => {
    expect(requestFor({ via: 'email', conversationId: 't1', through: 3, copyEveryone: false }, 'k', 'Hi')).toEqual({ url: '/api/email', body: { key: 'k', conversationId: 't1', through: 3, text: 'Hi' } })
    expect(requestFor({ via: 'email', conversationId: 't1', through: 3, copyEveryone: true }, 'k', 'Hi').body).toMatchObject({ copyEveryone: true })
  })

  test('a post names its conversation; a draft names itself, its revision and the thread’s position, and carries no text', () => {
    expect(requestFor({ via: 'chat', conversationId: 11 }, 'k', 'Hi')).toEqual({ url: '/api/chat', body: { key: 'k', conversationId: 11, text: 'Hi' } })
    expect(requestFor({ via: 'draft', draftId: 'd1', rev: 4, through: 2 }, 'k', '')).toEqual({ url: '/api/email', body: { key: 'k', draftId: 'd1', rev: 4, through: 2 } })
    expect(requestFor({ via: 'draft', draftId: 'd1', rev: 4, through: null }, 'k', '').body).toMatchObject({ through: null })
  })
})
