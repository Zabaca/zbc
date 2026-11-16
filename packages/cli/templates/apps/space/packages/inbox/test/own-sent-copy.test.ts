import { describe, expect, test } from 'bun:test'
import { harness, RIDGEWAY } from '../test-support/harness'

/**
 * A copy of the business's own outgoing mail, blind-copied to its Cloudflare mailbox (a site's confirmation to a customer, so the conversation starts in the
 * space): filed as outgoing, under the customer it was written to, owing no notification, and a Reply goes to the customer, not to the Reply-To the
 * confirmation carried (the owner's own Gmail). Mail from the mailbox's own address to nobody outside is filed as before.
 */

const mail = (o: { from: string; to: string; replyTo?: string; id: string; subject: string }) =>
  [
    `From: ${o.from}`,
    `To: ${o.to}`,
    ...(o.replyTo ? [`Reply-To: ${o.replyTo}`] : []),
    `Subject: ${o.subject}`,
    `Message-ID: <${o.id}@mail.example>`,
    'Date: Mon, 20 Oct 2026 12:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Thanks, we got your request.',
    '',
  ].join('\r\n')

describe('the business’s own sent copy', () => {
  test('is outgoing, under the customer, owes no notification, and a Reply goes to the customer', async () => {
    const h = harness()
    const raw = mail({
      from: `Ridgeway Cycles <${RIDGEWAY.address}>`,
      to: 'Jo Park <jo@home.example>',
      replyTo: 'owner.personal@gmail.example',
      id: 'c1',
      subject: 'Got your request, Jo',
    })
    expect((await h.deliver(raw, { to: RIDGEWAY.address })).entered).toBe('filed')
    const row = h.db
      .query(
        `SELECT m.direction, m.conversation_id, i.address FROM message m JOIN identity i ON i.id = m.identity_id WHERE m.rfc_message_id LIKE '%c1@mail.example%'`,
      )
      .get() as {
      direction: string
      conversation_id: string
      address: string
    }
    expect([row.direction, row.address]).toEqual(['out', 'jo@home.example'])
    expect(
      h.db.query(`SELECT read_at IS NOT NULL AS read FROM message WHERE rfc_message_id LIKE '%c1@mail.example%'`).get(),
    ).toEqual({ read: 1 })
    expect(h.db.query(`SELECT notify FROM message WHERE rfc_message_id LIKE '%c1@mail.example%'`).get()).toEqual({
      notify: null,
    })
    const conversation = (await h.store.call('getConversation', row.conversation_id)) as {
      ok: true
      value: { reply: { to: string } | null }
    }
    expect(conversation.value.reply?.to).toBe('jo@home.example')
    expect(
      h.db
        .query(`SELECT count(*) AS n FROM message WHERE direction = 'in' AND rfc_message_id LIKE '%c1@mail.example%'`)
        .get(),
    ).toEqual({ n: 0 })
  })

  test('mail from the mailbox’s own address to nobody outside is filed as it always was', async () => {
    const h = harness()
    const raw = mail({ from: RIDGEWAY.address, to: RIDGEWAY.address, id: 't1', subject: 'Tripwire' })
    expect((await h.deliver(raw, { to: RIDGEWAY.address })).entered).toBe('filed')
    expect(h.db.query(`SELECT direction FROM message WHERE rfc_message_id LIKE '%t1@mail.example%'`).get()).toEqual({
      direction: 'in',
    })
  })
})
