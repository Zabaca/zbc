import { describe, expect, test } from 'bun:test'
import { northfieldSettings as bundledSettings } from '../../../kit/northfield'
import { mailboxFor, parseDeclared } from '../src/cloudflare/declared'
import { bySubject, outsiders, referenceOrder, subjectKey } from '../src/cloudflare/thread'
import { OWNER_EMAIL } from '../test-support/owner'

/** The pure halves of arrival: the threading rules and the declaration of mailboxes. */

describe('the subject threading compares', () => {
  test.each([
    ['Hours question', 'hours question'],
    ['Re: Hours question', 'hours question'],
    ['RE: hours   question', 'hours question'],
    ['Fwd: Re: Fw: Hours question', 'hours question'],
    ['Aw: Hours question', 'hours question'],
    ['  re:Hours question ', 'hours question'],
    ['Reunion plans', 'reunion plans'],
    ['', ''],
  ])('%j is %j', (given, key) => {
    expect(subjectKey(given)).toBe(key)
  })
})

describe('rule 1: the Message-IDs to look for', () => {
  test('the message answered first, then References from the newest back, each once, never the message itself', () => {
    expect(referenceOrder('<me@x>', '<c@x>', ['<a@x>', '<b@x>', '<c@x>'])).toEqual(['<c@x>', '<b@x>', '<a@x>'])
    expect(referenceOrder('<me@x>', null, ['<a@x>', '<me@x>', '<b@x>'])).toEqual(['<b@x>', '<a@x>'])
    expect(referenceOrder(null, null, [])).toEqual([])
  })

  test('a header a stranger made enormous costs a bounded number of reads', () => {
    const many = Array.from({ length: 500 }, (_, n) => `<${n}@x>`)
    expect(referenceOrder(null, null, many)).toHaveLength(25)
    expect(referenceOrder(null, null, many, 3)).toEqual(['<499@x>', '<498@x>', '<497@x>'])
  })
})

describe('rule 2: the same subject with an outside participant in common', () => {
  const ours = (a: string) => a.endsWith('@ridgewaycycles.example')

  test('ours are never outside, whichever way they are spelled', () => {
    expect(outsiders(['Info@RidgewayCycles.example', 'a@x.example.com', 'A@x.example.com', 'b@y.example.org'], ours)).toEqual([
      'a@x.example.com',
      'b@y.example.org',
    ])
  })

  test('the first candidate (newest first) that shares an outside participant', () => {
    const candidates = [
      { id: 'c-new', outside: ['stranger@x.example.com'] },
      { id: 'c-mid', outside: ['ann@x.example.com', 'bob@x.example.com'] },
      { id: 'c-old', outside: ['ann@x.example.com'] },
    ]
    expect(bySubject(['ann@x.example.com'], candidates)).toBe('c-mid')
    expect(bySubject(['stranger@x.example.com', 'ann@x.example.com'], candidates)).toBe('c-new')
  })

  test('two strangers who both wrote the same subject are two conversations', () => {
    expect(bySubject(['priya@example.org'], [{ id: 'c1', outside: ['tessa@northfield.example'] }])).toBeNull()
  })

  test('a message with no outside participant leaves nothing to compare, and starts its own conversation', () => {
    expect(bySubject([], [{ id: 'c1', outside: [] }])).toBeNull()
  })
})

describe('the declared mailboxes', () => {
  const ridgeway = { address: 'info@ridgewaycycles.example', name: 'Ridgeway Cycles' }

  test('a list, or the same list as JSON text, or nothing', () => {
    expect(parseDeclared([ridgeway], OWNER_EMAIL)).toEqual({
      ok: true,
      mailboxes: [{ ...ridgeway, domain: 'ridgewaycycles.example' }],
    })
    expect(parseDeclared(JSON.stringify([ridgeway]), OWNER_EMAIL)).toEqual(parseDeclared([ridgeway], OWNER_EMAIL))
    expect(parseDeclared(undefined, OWNER_EMAIL)).toEqual({ ok: true, mailboxes: [] })
    expect(parseDeclared('', OWNER_EMAIL)).toEqual({ ok: true, mailboxes: [] })
    expect(parseDeclared([], OWNER_EMAIL)).toEqual({ ok: true, mailboxes: [] })
  })

  test('the address is lower-cased, the name trimmed', () => {
    expect(parseDeclared([{ address: 'Info@RidgewayCycles.example', name: ' Ridgeway ' }], OWNER_EMAIL)).toEqual({
      ok: true,
      mailboxes: [{ address: 'info@ridgewaycycles.example', name: 'Ridgeway', domain: 'ridgewaycycles.example' }],
    })
  })

  test.each([
    ['not JSON', '{nope'],
    ['not a list', { address: 'a@x.example.com', name: 'A' }],
    ['no address', [{ name: 'A' }]],
    ['a phone number for an address', [{ address: '+14155550123', name: 'A' }]],
    ['no name', [{ address: 'a@x.example.com' }]],
    ['a blank name', [{ address: 'a@x.example.com', name: '  ' }]],
    ['the Gmail mailbox itself', [{ address: 'tessa@northfield.example', name: 'Tessa' }]],
    ['two mailboxes on one domain', [ridgeway, { address: 'billing@ridgewaycycles.example', name: 'Billing' }]],
    ['an entry that is not an object', ['info@ridgewaycycles.example']],
  ])('%s declares nothing and says why', (_label, value) => {
    const declared = parseDeclared(value, OWNER_EMAIL)
    expect(declared.ok).toBe(false)
    if (!declared.ok) expect(declared.error.length).toBeGreaterThan(10)
  })

  test('a mailbox is found by the domain of the envelope recipient, any address on it', () => {
    const list = [{ ...ridgeway, domain: 'ridgewaycycles.example' }]
    expect(mailboxFor(list, 'info@ridgewaycycles.example')?.name).toBe('Ridgeway Cycles')
    expect(mailboxFor(list, 'Anything@RidgewayCycles.example')?.address).toBe('info@ridgewaycycles.example')
    expect(mailboxFor(list, 'info@northfield.example')).toBeNull()
    expect(mailboxFor(list, 'info@mail.ridgewaycycles.example')).toBeNull()
    expect(mailboxFor(list, 'not an address')).toBeNull()
    expect(mailboxFor([], 'info@ridgewaycycles.example')).toBeNull()
  })

  test('what the install kit writes as the space’s INBOX_MAILBOXES var is valid: Ridgeway’s mailbox on its domain, and ShiftLantern’s and quill.example’s on their own, with no spam check', () => {
    const config = bundledSettings as unknown as {
      vars: { INBOX_MAILBOXES: unknown }
    }
    expect(parseDeclared(config.vars.INBOX_MAILBOXES, OWNER_EMAIL)).toEqual({
      ok: true,
      mailboxes: [
        {
          address: 'info@ridgewaycycles.example',
          name: 'Ridgeway Cycles',
          domain: 'ridgewaycycles.example',
          // Step 3: the assistant runs on Ridgeway's mailbox until Tessa switches it off.
          assistant: true,
        },
        // ShiftLantern's, with no `assistant`: declared without the spam check, which Tessa's switch turns on.
        { address: 'hello@shiftlantern.example', name: 'ShiftLantern', domain: 'shiftlantern.example' },
        // quill.example's (Tessa and Carla's app), also with no `assistant`: it has no persona and no questions, so it never reaches Clef or the draft chat.
        { address: 'hello@quill.example', name: 'quill.example', domain: 'quill.example' },
      ],
    })
  })
})
