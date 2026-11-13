// The rules behind the New email box, the draft editor and the spam control, checked on their own: pure functions of literal values, no browser and no Worker.
import { describe, expect, test } from 'bun:test'
import { attached, newCompose, requestFor, typed } from '../src/client/compose'
import { ccChanged, ccTextOf, copiesNow, hasMoved, isDirty, onlyOffPageChanged, parseCc, takesCc } from '../src/client/DraftEdit'
import { suggestionsOf } from '../src/client/NewEmail'
import { AUTOMATIC, addressOf, canChoose, canSendNew, filesAllowed, fromOf, fromOptions, nameIn, whyNotNew } from '../src/client/newmailRules'
import { spamControl, spamNotice } from '../src/client/spam'
import type { PeopleEntry } from '../src/people'

const NORTHFIELD = { id: 'gm-northfield', name: 'northfield', address: 'tessa@northfield.example', connected: true, state: 'live' }
const ASHGROVE = { id: 'gm-ashgrove', name: 'ashgrove', address: 'tessa@ashgrove.example', connected: true, state: 'live' }

const mailboxes = {
  gmailAccounts: [NORTHFIELD],
  mailboxes: [
    { id: 'ridgeway', name: 'Ridgeway Cycles', address: 'info@ridgewaycycles.example' },
    { id: 'shiftlantern', name: 'ShiftLantern', address: 'hello@shiftlantern.example' },
  ],
  capabilities: ['new-email-from-and-files'],
}

describe('the From box', () => {
  test('is Automatic, then each Gmail account that works, then each business mailbox by name and address; an account disconnected or lapsed, or none, is not offered', () => {
    expect(fromOptions(mailboxes).map((o) => o.value)).toEqual(['auto', 'gmail:gm-northfield', 'business:ridgeway', 'business:shiftlantern'])
    expect(fromOptions({ ...mailboxes, gmailAccounts: [{ ...NORTHFIELD, connected: false, state: 'disconnected' }] }).map((o) => o.value)).toEqual(['auto', 'business:ridgeway', 'business:shiftlantern'])
    expect(fromOptions({ ...mailboxes, gmailAccounts: [] }).map((o) => o.value)).toEqual(['auto', 'business:ridgeway', 'business:shiftlantern'])
    expect(fromOptions(null).map((o) => o.value)).toEqual(['auto'])
    expect(fromOptions(mailboxes)[2]?.label).toBe('Ridgeway Cycles (info@ridgewaycycles.example)')
  })

  test('with several accounts each is offered by its label and address, and a lapsed one is left out until it is connected again', () => {
    const several = { ...mailboxes, gmailAccounts: [NORTHFIELD, ASHGROVE, { ...ASHGROVE, id: 'gm-lapsed', name: 'fernway', address: 'tessa.marlow@fernway.example', state: 'lapsed' }] }
    const options = fromOptions(several)
    expect(options.slice(1, 3).map((o) => [o.value, o.label])).toEqual([
      ['gmail:gm-northfield', 'northfield Gmail (tessa@northfield.example)'],
      ['gmail:gm-ashgrove', 'ashgrove Gmail (tessa@ashgrove.example)'],
    ])
    expect(options.map((o) => o.value)).not.toContain('gmail:gm-lapsed')
  })

  test('offers only Automatic from an inbox that does not say it can honour a chosen mailbox and files, as an older inbox, which would ignore both, gives', () => {
    const { capabilities: _, ...older } = mailboxes
    expect(canChoose(mailboxes)).toBe(true)
    expect(canChoose(older)).toBe(false)
    expect(canChoose({ ...mailboxes, capabilities: [] })).toBe(false)
    expect(canChoose({ ...mailboxes, capabilities: ['something-else'] })).toBe(false)
    expect(canChoose(null)).toBe(false)
    expect(fromOptions(older).map((o) => o.value)).toEqual(['auto'])
    expect(fromOptions({ ...mailboxes, capabilities: [] }).map((o) => o.value)).toEqual(['auto'])
  })

  test('means to the inbox: its own rule, a Gmail account or a business mailbox by id; and the sender is never an address', () => {
    expect(fromOf(AUTOMATIC)).toBeUndefined()
    expect(fromOf('gmail:gm-ashgrove')).toEqual({ kind: 'gmail', mailboxId: 'gm-ashgrove' })
    expect(fromOf('business:ridgeway')).toEqual({ kind: 'business', mailboxId: 'ridgeway' })
    for (const o of fromOptions(mailboxes)) expect(JSON.stringify(fromOf(o.value) ?? {})).not.toContain('@')
  })

  test('allows files for a business mailbox only, and not for Automatic, which the box cannot see through', () => {
    expect(['auto', 'gmail:gm-northfield', 'business:ridgeway'].map((c) => filesAllowed(c as never))).toEqual([false, false, true])
  })
})

describe('what is in the box', () => {
  const email = (over: Partial<{ to: string; subject: string; from: 'auto' | `gmail:${string}` | `business:${string}` }> = {}) => ({ to: 'new@example.net', subject: 'Hello', from: 'auto' as const, ...over })
  const written = (text = 'Hi.') => typed(newCompose(), text)

  test('names the first thing missing, and sends when nothing is', () => {
    expect(whyNotNew(email({ to: '' }), written())).toBe('Say who it is to.')
    expect(whyNotNew(email({ to: 'nobody' }), written())).toBe('That is not an email address.')
    expect(whyNotNew(email({ subject: '  ' }), written())).toBe('Add a subject.')
    expect(whyNotNew(email(), written('   '))).toBe('Write something to say.')
    expect(whyNotNew(email(), written())).toBeNull()
    expect(canSendNew(email(), written())).toBe(true)
    expect(canSendNew(email(), { ...written(), phase: 'sending' })).toBe(false)
    expect(canSendNew(email(), { ...written(), phase: 'unknown' })).toBe(false)
  })

  test('holds files back from Gmail and from Automatic with the reason, and lets a business mailbox carry them within the inbox’s limits', () => {
    const files = [new File([new Uint8Array([1])], 'a.pdf')]
    const withFiles = attached(written(), files)
    expect(whyNotNew(email({ from: 'gmail:gm-northfield' }), withFiles)).toContain('a business mailbox only')
    expect(whyNotNew(email({ from: 'auto' }), withFiles)).toContain('mailbox only')
    expect(whyNotNew(email({ from: 'business:ridgeway' }), withFiles)).toBeNull()
    const empty = attached(written(), [new File([], 'empty.pdf')])
    expect(whyNotNew(email({ from: 'business:ridgeway' }), empty)).toBe('empty.pdf is empty.')
    const many = attached(written(), Array.from({ length: 11 }, (_, n) => new File([new Uint8Array([1])], `f${n}`)))
    expect(whyNotNew(email({ from: 'business:ridgeway' }), many)).toBe('A message carries at most 10 files.')
  })

  test('reads an address as the inbox does, and a name written around it', () => {
    expect(addressOf('Dana <DANA@Harbor.example>')).toBe('dana@harbor.example')
    expect(addressOf('(626) 555-0142')).toBeNull()
    expect(nameIn('Dana Reyes <dana@harbor.example>')).toBe('Dana Reyes')
    expect(nameIn('"Reyes, Dana" <dana@harbor.example>')).toBe('Reyes, Dana')
    expect(nameIn('dana@harbor.example')).toBeNull()
    expect(nameIn('<dana@harbor.example>')).toBeNull()
  })

  test('the request is a new email to the bare address, with the mailbox only when one was chosen', () => {
    expect(requestFor({ via: 'new', address: 'a@b.example', subject: 'Hi' }, 'k'.repeat(20), 'Words')).toEqual({ url: '/api/email', body: { key: 'k'.repeat(20), address: 'a@b.example', subject: 'Hi', text: 'Words' } })
    expect(requestFor({ via: 'new', address: 'a@b.example', subject: 'Hi', name: 'A', from: { kind: 'business', mailboxId: 'ridgeway' } }, 'k'.repeat(20), 'Words').body).toEqual({
      key: 'k'.repeat(20),
      address: 'a@b.example',
      subject: 'Hi',
      text: 'Words',
      name: 'A',
      from: { kind: 'business', mailboxId: 'ridgeway' },
    })
  })
})

describe('the people offered in the To box', () => {
  const entry = (name: string, addresses: string[], over: Partial<PeopleEntry> = {}): PeopleEntry =>
    ({ key: addresses[0] ?? name, conversationKey: null, name, side: 'outside', guest: false, automated: false, addresses, contactIds: [], contact: null, business: '', role: '', sendsFrom: null, client: null, suggestedClient: null, team: null, ...over }) as PeopleEntry

  test('are every address of every person once, by name, and never an automated sender or a person with no address', () => {
    const answer = { entries: [entry('Zed', ['z@x.example']), entry('Ana', ['ana@x.example', 'ana@y.example']), entry('Newsletter', ['news@x.example'], { automated: true }), entry('Chat only', []), entry('Ana again', ['ana@x.example'])], parts: [], automated: 1 }
    expect(suggestionsOf(answer)).toEqual([
      { name: 'Ana', address: 'ana@x.example', sendsFrom: null },
      { name: 'Ana', address: 'ana@y.example', sendsFrom: null },
      { name: 'Zed', address: 'z@x.example', sendsFrom: null },
    ])
    expect(suggestionsOf(null)).toEqual([])
  })

  test('carry the account a new email to them goes from, when the inbox says', () => {
    const answer = { entries: [entry('Arun', ['arun@x.example'], { sendsFrom: { name: 'ashgrove', address: 'tessa@ashgrove.example' } })], parts: [], automated: 0 }
    expect(suggestionsOf(answer)).toEqual([{ name: 'Arun', address: 'arun@x.example', sendsFrom: { name: 'ashgrove', address: 'tessa@ashgrove.example' } }])
  })
})

describe('the draft editor', () => {
  const draft = { subject: 'Re: Hi', text: 'Thank you.', rev: 4, cc: [{ name: 'Marcus', address: 'marcus@x.example' }], copiesEveryone: true }
  test('is changed by words, not by the spaces the inbox trims away, and by who is copied', () => {
    expect(copiesNow(draft)).toBe(true)
    // Only the inbox says whether the draft copies everyone: a Cc somebody typed does not tick the box.
    expect(copiesNow({ copiesEveryone: false })).toBe(false)
    expect(isDirty(draft, 'Re: Hi', 'Thank you.', false)).toBe(true)
    expect(isDirty(draft, 'Re: Hi', 'Thank you.', true)).toBe(false)
    expect(isDirty(draft, 'Re: Hi', 'Thank you.')).toBe(false)
    expect(isDirty(draft, ' Re: Hi ', 'Thank you.\n\n')).toBe(false)
    expect(isDirty(draft, 'Re: Hi', 'Thank you!')).toBe(true)
    expect(isDirty(draft, 'Re: Hello', 'Thank you.')).toBe(true)
  })

  test('the Cc box reads addresses however they are separated, once each, and Name <address> as the address; it changes the draft only when the people differ', () => {
    expect(ccTextOf(draft)).toBe('marcus@x.example')
    expect(ccTextOf({ cc: null })).toBe('')
    expect(parseCc('a@x.example, B@y.example;c@z.example\nd@x.example  e@x.example')).toEqual(['a@x.example', 'B@y.example', 'c@z.example', 'd@x.example', 'e@x.example'])
    expect(parseCc('Ann Lee <ann@x.example>, ann@X.example, , ')).toEqual(['ann@x.example'])
    expect(parseCc('   ')).toEqual([])
    expect(ccChanged(draft, 'marcus@x.example')).toBe(false)
    expect(ccChanged(draft, ' MARCUS@x.example, ')).toBe(false)
    expect(ccChanged(draft, 'marcus@x.example, ann@x.example')).toBe(true)
    expect(ccChanged(draft, '')).toBe(true)
    expect(ccChanged({ cc: [] }, '')).toBe(false)
    expect(isDirty(draft, 'Re: Hi', 'Thank you.', true, 'marcus@x.example')).toBe(false)
    expect(isDirty(draft, 'Re: Hi', 'Thank you.', true, 'marcus@x.example, ann@x.example')).toBe(true)
    expect(isDirty(draft, 'Re: Hi', 'Thank you.', true, '')).toBe(true)
  })

  test('offers a Cc box on an email draft whose Cc the inbox told us, and on no other', () => {
    expect(takesCc({ kind: 'email', cc: [] })).toBe(true)
    expect(takesCc({ kind: 'email', cc: null })).toBe(false)
    expect(takesCc({ kind: 'sms', cc: [] })).toBe(false)
    expect(takesCc({ kind: 'manual', cc: [] })).toBe(false)
    expect(takesCc({ kind: 'telegram', cc: [] })).toBe(false)
    expect(takesCc({ kind: null, cc: [] })).toBe(false)
  })

  test('says when the words are the same and only who is copied or why it was drafted changed, as the inbox’s conflict does', () => {
    expect(onlyOffPageChanged('Claude', draft, ' Re: Hi', 'Thank you.\n')).toBe('The words are the same; Claude changed who is copied, or why it was drafted.')
    expect(onlyOffPageChanged('Claude', draft, 'Re: Hi', 'Other.')).toBeNull()
  })

  test('has moved on when the card’s revision is not the one the words were written over', () => {
    expect(hasMoved(draft, 4)).toBe(false)
    expect(hasMoved(draft, 3)).toBe(true)
  })
})

describe('the spam control', () => {
  test('is where the inbox says its own page draws it: Mark as spam, Move to the Inbox for one in Bulk, and none where the inbox does not say (a text, a Client’s person’s Inbox thread, an inbox that predates it)', () => {
    expect(spamControl({ canMarkSpam: true, bulk: false })).toMatchObject({ label: 'Mark as spam', spam: true })
    expect(spamControl({ canMarkSpam: true, bulk: true })).toMatchObject({ label: 'Move to the Inbox', spam: false })
    expect(spamControl({ canMarkSpam: false, bulk: false })).toBeNull()
    expect(spamControl({ canMarkSpam: false, bulk: true })).toBeNull()
  })

  test('the notice says where the thread went, and says so when the inbox’s rules kept it where it was', () => {
    const base = { conversationId: 't', reasons: [] as string[] }
    expect(spamNotice({ ...base, spam: true, bulk: true }, 'Quote')).toEqual({ tone: 'ok', text: '“Quote” is in Bulk now: kept apart from people, never deleted.' })
    expect(spamNotice({ ...base, spam: false, bulk: false }, '')).toEqual({ tone: 'ok', text: 'The thread is back in the Inbox.' })
    expect(spamNotice({ ...base, spam: true, bulk: false, reasons: ['Kept in the Inbox: a Client’s contact is on it.'] }, 'Quote')).toEqual({
      tone: 'warn',
      text: '“Quote” was called spam, but it stays in the Inbox. Kept in the Inbox: a Client’s contact is on it.',
    })
    expect(spamNotice({ ...base, spam: false, bulk: true, reasons: ['Bulk mail: it carries a List-Unsubscribe header.'] }, 'Deals').text).toContain('still in Bulk')
  })
})
