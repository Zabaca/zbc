import { describe, expect, test } from 'bun:test'
import { everyConversation, harness } from '../test-support/harness'

/**
 * The store over real SQLite: the rules that need a person with more than one
 * address. Nothing in step 1 adds a second identity to a contact (that is merge,
 * step 5), so these tests ARRANGE one with an insert, which is exactly the state
 * a merge will leave. The assertions are all through the store's own methods.
 */

const TESSA = 'tessa@northfield.example'

/**
 * Mark sent is for the channels the inbox cannot send on (a text, a DM): an email is sent
 * with Send since step 4, so these arrangements use texts and a DM handle, which behave the
 * same way for what is tested here (one conversation per contact per channel).
 */
function danaWithTwoAddresses() {
  const h = harness()
  const first = h.inbox.createDraft({ address: '626-555-0100', name: 'Dana', body: 'text one' }, TESSA)
  if (!first.ok) throw new Error('arrange')
  h.db.run(
    `INSERT INTO identity (id, contact_id, kind, address, created_at) VALUES ('arranged-sms', ?, 'sms', '+16265550142', ?)`,
    [first.value.contactId, new Date(0).toISOString()],
  )
  h.db.run(
    `INSERT INTO identity (id, contact_id, kind, address, created_at) VALUES ('arranged-dm', ?, 'manual', '@dana_r', ?)`,
    [first.value.contactId, new Date(0).toISOString()],
  )
  return { h, contactId: first.value.contactId, firstDraft: first.value }
}

describe('a contact with several addresses', () => {
  test('a draft must say which address when the contact has more than one', () => {
    const { h, contactId } = danaWithTwoAddresses()
    const vague = h.inbox.createDraft({ contactId, body: 'which?' }, TESSA)
    expect(vague).toMatchObject({ ok: false, status: 422 })
    const sms = h.inbox.createDraft({ contactId, address: '(626) 555-0142', body: 'text' }, TESSA)
    expect(sms).toMatchObject({ ok: true, value: { kind: 'sms', address: '+16265550142' } })
  })

  test('one conversation per contact per channel, whichever address on that channel it went to', () => {
    const { h, contactId, firstDraft } = danaWithTwoAddresses()
    const second = h.inbox.createDraft({ contactId, address: '+16265550142', body: 'text two' }, TESSA)
    const dm = h.inbox.createDraft({ contactId, address: '@dana_r', body: 'a dm' }, TESSA)
    if (!second.ok || !dm.ok) throw new Error('arrange')
    for (const id of [firstDraft.id, second.value.id, dm.value.id]) {
      expect(h.inbox.markSent(id, undefined, TESSA).ok).toBe(true)
      h.tick()
    }

    const rows = everyConversation(h.inbox)
    expect(rows.map((r) => r.kind).sort()).toEqual(['manual', 'sms'])
    const texts = rows.find((r) => r.kind === 'sms')
    const detail = h.inbox.getConversation(texts?.id ?? '')
    if (!detail.ok) throw new Error('no conversation')
    expect(detail.value.messages.map((m) => m.body)).toEqual(['text one', 'text two'])
    expect(detail.value.addresses.map((a) => a.address)).toEqual(['+16265550100', '+16265550142'])
    expect(detail.value.contacts).toHaveLength(1)
  })

  test('a draft on a conversation with several addresses must say which too', () => {
    const { h, contactId, firstDraft } = danaWithTwoAddresses()
    const second = h.inbox.createDraft({ contactId, address: '+16265550142', body: 'text two' }, TESSA)
    if (!second.ok) throw new Error('arrange')
    h.inbox.markSent(firstDraft.id, undefined, TESSA)
    h.inbox.markSent(second.value.id, undefined, TESSA)
    const conversationId = everyConversation(h.inbox)[0]?.id ?? ''

    expect(h.inbox.createDraft({ conversationId, body: 'which?' }, TESSA)).toMatchObject({ ok: false, status: 422 })
    expect(h.inbox.createDraft({ conversationId, address: '+16265550142', body: 'ok' }, TESSA)).toMatchObject({
      ok: true,
    })
    expect(h.inbox.createDraft({ conversationId, address: '+16265550199', body: 'no' }, TESSA)).toMatchObject({
      ok: false,
      status: 422,
    })
  })
})

describe('the contact list and card', () => {
  test('counts conversations and drafts per contact', () => {
    const h = harness()
    const a = h.inbox.createDraft({ address: '626-555-0100', name: 'Ann', body: 'one' }, TESSA)
    h.inbox.createDraft({ address: '626-555-0100', body: 'two' }, TESSA)
    h.inbox.createDraft({ address: '626-555-0120', name: 'Bob', body: 'one' }, TESSA)
    if (!a.ok) throw new Error('arrange')
    h.inbox.markSent(a.value.id, undefined, TESSA)
    expect(h.inbox.listContacts().map((c) => [c.name, c.conversations, c.drafts])).toEqual([
      ['Ann', 1, 1],
      ['Bob', 0, 1],
    ])
  })

  test('a deleted draft on a conversation leaves its activity time to the messages that are left', () => {
    const h = harness()
    const a = h.inbox.createDraft({ address: '626-555-0100', name: 'Ann', body: 'one' }, TESSA)
    if (!a.ok) throw new Error('arrange')
    h.tick()
    h.inbox.markSent(a.value.id, '2026-10-01T00:00:00Z', TESSA)
    const conversationId = everyConversation(h.inbox)[0]?.id ?? ''
    h.tick()
    const d = h.inbox.createDraft({ conversationId, body: 'follow up' }, TESSA)
    if (!d.ok) throw new Error('arrange')
    expect(everyConversation(h.inbox)[0]?.lastActivityAt).toBe('2026-10-01T00:00:00.000Z')
    h.inbox.deleteDraft(d.value.id, TESSA, d.value.rev)
    expect(everyConversation(h.inbox)[0]).toMatchObject({ drafts: 0, snippet: 'one' })
  })

  test('unmarking the only message leaves a conversation holding just a draft', () => {
    const h = harness()
    const a = h.inbox.createDraft({ address: '626-555-0100', name: 'Ann', body: 'one' }, TESSA)
    if (!a.ok) throw new Error('arrange')
    h.inbox.markSent(a.value.id, undefined, TESSA)
    h.inbox.unmarkSent(a.value.id, TESSA)
    expect(everyConversation(h.inbox)).toEqual([expect.objectContaining({ drafts: 1, snippet: 'one' })])
  })
})

describe('every write is audited with its actor, in the same transaction', () => {
  test('a refused write leaves no audit row and no half-made contact', () => {
    const h = harness()
    const refused = h.inbox.createDraft({ address: 'a@example.com', body: 'x \u2014 y' }, 'agent:tok')
    expect(refused.ok).toBe(false)
    expect(h.inbox.listAudit()).toEqual([])
    expect(h.inbox.listContacts()).toEqual([])
  })

  test('a write that throws midway rolls everything back', () => {
    const h = harness()
    h.db.run(
      `CREATE TRIGGER boom BEFORE INSERT ON audit WHEN NEW.action = 'draft.create' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    )
    expect(() => h.inbox.createDraft({ address: 'a@example.com', body: 'x' }, TESSA)).toThrow()
    expect(h.inbox.listContacts()).toEqual([])
    expect(h.inbox.listDrafts()).toEqual([])
  })
})
