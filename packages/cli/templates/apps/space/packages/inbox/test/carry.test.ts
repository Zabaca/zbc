import { describe, expect, test } from 'bun:test'
import type { OutboxEntry } from '../src/types'
import { everyConversation, harness } from '../test-support/harness'
import fixture from './fixtures/outbox.json'

/**
 * The Outbox carry, run against a fixture shaped like what the old outbox's
 * `list` command printed: an array of
 * `{ id, to, channel, address, subject, why, body, created, sentAt }`. It is NOT
 * run against the live Outbox here (a worktree has no way to reach it); the
 * numbers to compare before and after are the report this returns.
 */

const entries = fixture as OutboxEntry[]
const ACTOR = 'agent:abc123.access'

describe('what the carry makes of the Outbox', () => {
  test('counts in, counts out, and a person with two entries is one contact', () => {
    const h = harness()
    const report = h.inbox.importOutbox(entries, ACTOR)

    expect(report).toEqual({
      received: { total: 6, unsent: 3, sent: 3 },
      created: { drafts: 3, manualSent: 3 },
      skipped: 0,
      markedSent: 0,
      // Dana (two spellings of one address), Marcus (two spellings of one number),
      // Priya (a handle) and the print shop (no address, so the name stands in).
      contactsCreated: 4,
      problems: [],
    })
    expect(report.created.drafts + report.created.manualSent + report.skipped + report.markedSent).toBe(
      report.received.total,
    )

    const contacts = h.inbox.listContacts()
    expect(contacts.map((c) => c.name).sort()).toEqual([
      'Abel at the print shop',
      'Dana Reyes',
      'Marcus Webb',
      'Priya Nair',
    ])
  })

  test('an address becomes an email identity, a phone number a text identity, anything else a manual one', () => {
    const h = harness()
    h.inbox.importOutbox(entries, ACTOR)
    const kinds = Object.fromEntries(
      h.inbox.listContacts().map((c) => [c.name, c.identities.map((i) => `${i.kind}:${i.address}`)]),
    )
    expect(kinds).toEqual({
      'Dana Reyes': ['email:dana@cafe.example'],
      'Marcus Webb': ['sms:+16265550142'],
      'Priya Nair': ['manual:@priya_n'],
      'Abel at the print shop': ['manual:abel at the print shop'],
    })
  })

  test('an unsent entry is a draft that keeps its why and created time', () => {
    const h = harness()
    h.inbox.importOutbox(entries, ACTOR)
    const drafts = h.inbox.listDrafts()
    expect(drafts.map((d) => d.sourceRef).sort()).toEqual([
      'outbox:2026-10-19-dana-card-declined',
      'outbox:2026-10-19-marcus-sms-followup',
      'outbox:2026-10-19-priya-dm',
    ])
    const dana = drafts.find((d) => d.sourceRef === 'outbox:2026-10-19-dana-card-declined')
    expect(dana).toMatchObject({
      status: 'draft',
      subject: 'Your card was declined',
      why: 'Her April payment failed and she may not know.',
      createdAt: '2026-10-19T17:04:11.000Z',
      createdBy: 'outbox',
      conversationId: null,
    })
  })

  test('a sent entry is a manual-sent message with its sent time, filed on that contact’s conversation', () => {
    const h = harness()
    h.inbox.importOutbox(entries, ACTOR)
    const dana = h.inbox.listContacts().find((c) => c.name === 'Dana Reyes')
    const card = h.inbox.getContact(dana?.id ?? '')
    if (!card.ok) throw new Error('no card')
    expect(card.value.conversations).toHaveLength(1)
    const convo = h.inbox.getConversation(card.value.conversations[0]?.id ?? '')
    if (!convo.ok) throw new Error('no conversation')
    expect(convo.value.messages).toHaveLength(1)
    expect(convo.value.messages[0]).toMatchObject({
      status: 'manual-sent',
      sentAt: '2026-10-18T16:02:40.000Z',
      sentBy: null,
      subject: 'Welcome aboard',
      createdAt: '2026-10-18T15:30:00.000Z',
    })
    // Her unsent entry is a draft that is not yet on any conversation.
    expect(convo.value.drafts).toHaveLength(0)
    expect(card.value.drafts).toHaveLength(1)
  })

  test('the queue after the carry: one conversation per contact per channel, newest first', () => {
    const h = harness()
    h.inbox.importOutbox(entries, ACTOR)
    const rows = everyConversation(h.inbox)
    expect(rows.map((r) => [r.contactNames[0], r.kind, r.lastActivityAt])).toEqual([
      ['Dana Reyes', 'email', '2026-10-18T16:02:40.000Z'],
      ['Marcus Webb', 'sms', '2026-10-17T20:15:00.000Z'],
      ['Abel at the print shop', 'manual', '2026-10-16T21:30:00.000Z'],
    ])
  })
})

describe('running it again', () => {
  test('a second run changes nothing and says so', () => {
    const h = harness()
    h.inbox.importOutbox(entries, ACTOR)
    const again = h.inbox.importOutbox(entries, ACTOR)
    expect(again).toMatchObject({
      created: { drafts: 0, manualSent: 0 },
      skipped: 6,
      markedSent: 0,
      contactsCreated: 0,
    })
    expect(h.inbox.listDrafts()).toHaveLength(3)
    expect(h.inbox.listContacts()).toHaveLength(4)
  })

  test('a draft the Outbox has since marked sent is marked sent here, and an edit here survives', () => {
    const h = harness()
    h.inbox.importOutbox(entries, ACTOR)
    const carried = h.inbox.listDrafts().find((d) => d.sourceRef === 'outbox:2026-10-19-dana-card-declined')
    h.inbox.updateDraft(carried?.id ?? '', { rev: carried?.rev ?? 0, body: 'Edited here' }, 'tessa@northfield.example')

    const later = entries.map((e) =>
      e.id === '2026-10-19-dana-card-declined' ? { ...e, sentAt: '2026-10-20T09:00:00.000Z', body: 'Outbox text' } : e,
    )
    const again = h.inbox.importOutbox(later, ACTOR)
    expect(again).toMatchObject({ skipped: 5, markedSent: 1, created: { drafts: 0, manualSent: 0 } })

    expect(h.inbox.listDrafts()).toHaveLength(2)
    const dana = everyConversation(h.inbox).find((r) => r.contactNames[0] === 'Dana Reyes')
    expect(dana?.lastActivityAt).toBe('2026-10-20T09:00:00.000Z')
    const convo = h.inbox.getConversation(dana?.id ?? '')
    if (!convo.ok) throw new Error('no conversation')
    expect(convo.value.messages.map((m) => m.body.slice(0, 11))).toEqual(['Hi Dana,\n\nW', 'Edited here'])
  })

  test('a carried message put back to a draft here is marked sent again while the Outbox says sent', () => {
    const h = harness()
    h.inbox.importOutbox(entries, ACTOR)
    const sent = h.inbox.getConversation(
      everyConversation(h.inbox).find((r) => r.contactNames[0] === 'Marcus Webb')?.id ?? '',
    )
    if (!sent.ok) throw new Error('no conversation')
    h.inbox.unmarkSent(sent.value.messages[0]?.id ?? '', 'tessa@northfield.example')
    const again = h.inbox.importOutbox(entries, ACTOR)
    // It is a draft here again and the Outbox says sent: the carry marks it sent,
    // because the Outbox is still the record Tessa was working in.
    expect(again.markedSent).toBe(1)
  })

  test('a carried draft Tessa deleted stays deleted, and the run says it skipped it', () => {
    const h = harness()
    h.inbox.importOutbox(entries, ACTOR)
    const carried = h.inbox.listDrafts().find((d) => d.sourceRef === 'outbox:2026-10-19-priya-dm')
    expect(h.inbox.deleteDraft(carried?.id ?? '', 'tessa@northfield.example', carried?.rev ?? 0).ok).toBe(true)

    const again = h.inbox.importOutbox(entries, ACTOR)
    expect(again).toMatchObject({ created: { drafts: 0, manualSent: 0 }, skipped: 6, markedSent: 0, problems: [] })
    expect(h.inbox.listDrafts().map((d) => d.sourceRef)).not.toContain('outbox:2026-10-19-priya-dm')
    expect(h.inbox.listDrafts()).toHaveLength(2)

    // Not even when the Outbox has since marked it sent: Tessa deleted it.
    const sentSince = entries.map((e) =>
      e.id === '2026-10-19-priya-dm' ? { ...e, sentAt: '2026-10-20T09:00:00Z' } : e,
    )
    expect(h.inbox.importOutbox(sentSince, ACTOR)).toMatchObject({ skipped: 6, markedSent: 0 })
    expect(everyConversation(h.inbox).map((c) => c.contactNames[0])).not.toContain('Priya Nair')
  })

  test('a carried message deleted after being put back to a draft is remembered too', () => {
    const h = harness()
    h.inbox.importOutbox(entries, ACTOR)
    const convo = h.inbox.getConversation(
      everyConversation(h.inbox).find((r) => r.contactNames[0] === 'Marcus Webb')?.id ?? '',
    )
    if (!convo.ok) throw new Error('no conversation')
    const id = convo.value.messages[0]?.id ?? ''
    h.inbox.unmarkSent(id, 'tessa@northfield.example')
    h.inbox.deleteDraft(id, 'tessa@northfield.example', 0)
    expect(h.inbox.importOutbox(entries, ACTOR)).toMatchObject({ created: { drafts: 0, manualSent: 0 }, markedSent: 0 })
  })

  test('a draft that was never carried leaves nothing behind when deleted', () => {
    const h = harness()
    const d = h.inbox.createDraft({ address: 'dana@example.com', body: 'mine' }, 'tessa@northfield.example')
    if (!d.ok) throw new Error('arrange')
    h.inbox.deleteDraft(d.value.id, 'tessa@northfield.example', d.value.rev)
    // An Outbox entry that happens to share nothing with it is carried normally.
    expect(h.inbox.importOutbox(entries.slice(0, 1), ACTOR).created.drafts).toBe(1)
  })
})

describe('entries it cannot carry are reported, never dropped quietly', () => {
  test('each problem is named by entry, and the rest still go', () => {
    const h = harness()
    const report = h.inbox.importOutbox(
      [
        { id: 'ok-1', to: 'Dana', address: 'dana@example.com', body: 'fine' },
        { id: 'no-body', to: 'Dana', address: 'dana@example.com', body: '  ' },
        { id: 'no-one', to: '', address: '', body: 'hello' },
        { id: 'bad-sent', to: 'Dana', address: 'dana@example.com', body: 'x', sentAt: 'last tuesday' },
        { id: 'bad-created', to: 'Dana', address: 'dana@example.com', body: 'x', created: 'whenever' },
        { id: '', to: 'Dana', address: 'dana@example.com', body: 'x' },
      ],
      ACTOR,
    )
    expect(report.created.drafts).toBe(1)
    expect(report.problems.map((p) => p.id)).toEqual(['no-body', 'no-one', 'bad-sent', 'bad-created', '(no id)'])
    expect(report.received.total).toBe(6)
    expect(h.inbox.listDrafts()).toHaveLength(1)
  })

  test('an entry that is not an object is a problem, not a crash', () => {
    const h = harness()
    const report = h.inbox.importOutbox(
      [null, 'text', 5, ['a'], { id: 'ok', to: 'Dana', address: 'dana@example.com', body: 'fine' }],
      ACTOR,
    )
    expect(report.received).toEqual({ total: 5, unsent: 5, sent: 0 })
    expect(report.created.drafts).toBe(1)
    expect(report.problems).toEqual([
      { id: '(entry 0)', reason: 'The entry is not an object.' },
      { id: '(entry 1)', reason: 'The entry is not an object.' },
      { id: '(entry 2)', reason: 'The entry is not an object.' },
      { id: '(entry 3)', reason: 'The entry is not an object.' },
    ])
  })

  test('a timestamp that is not a full ISO one is a problem, whatever Date makes of it', () => {
    const h = harness()
    const base = { to: 'Dana', address: 'dana@example.com', body: 'x' }
    const report = h.inbox.importOutbox(
      [
        { ...base, id: 'one', sentAt: '1' },
        { ...base, id: 'date-only', created: '2026-10-19' },
        { ...base, id: 'no-zone', sentAt: '2026-10-19T10:00:00' },
        { ...base, id: 'fine', sentAt: '2026-10-19T10:00:00+02:00' },
      ],
      ACTOR,
    )
    expect(report.problems.map((p) => p.id)).toEqual(['one', 'date-only', 'no-zone'])
    expect(report.created.manualSent).toBe(1)
    const sent = everyConversation(h.inbox)[0]
    expect(sent?.lastActivityAt).toBe('2026-10-19T08:00:00.000Z')
  })

  test('the same id twice in one run is carried once', () => {
    const h = harness()
    const twice = [
      { id: 'dup', to: 'Dana', address: 'dana@example.com', body: 'one' },
      { id: 'dup', to: 'Dana', address: 'dana@example.com', body: 'one' },
    ]
    expect(h.inbox.importOutbox(twice, ACTOR)).toMatchObject({ created: { drafts: 1 }, skipped: 1 })
  })

  test('the carry is audited with its actor', () => {
    const h = harness()
    h.inbox.importOutbox(entries.slice(0, 1), ACTOR)
    const carried = h.inbox.listAudit().filter((a) => a.action === 'outbox.carry')
    expect(carried).toHaveLength(1)
    expect(carried[0]).toMatchObject({
      actor: ACTOR,
      after: { sourceRef: 'outbox:2026-10-19-dana-card-declined', status: 'draft' },
    })
  })
})
