import { describe, expect, test } from 'bun:test'
import { GmailError } from '../src/gmail/google'
import { harness, pushBody, T0 } from '../test-support/harness'

/**
 * One calendar event updated several times is one conversation in the inbox: Google Calendar mails each update as a
 * thread of its own, and the older ones are closed (in Gmail first) when a newer one of the SAME event arrives in the SAME mailbox. The real Mailroom
 * and store over a real SQLite and a Google that can fail; the iCalendar parts and the links are written to the documented shapes (the hand test checks
 * a real invitation: docs/runbooks/inbox-calendar-updates.md).
 */

type H = ReturnType<typeof harness>

const ics = (uid: string, method = 'REQUEST', extra: string[] = []): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}@google.com`,
    ...extra,
    'SUMMARY:Roadmap @ Fernway',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
const eid = (event: string) => Buffer.from(`${event} tessa@northfield.example`).toString('base64url')
const links = (event: string) =>
  `Yes: https://calendar.google.com/calendar/event?action=RESPOND&eid=${eid(event)}&rst=1&tok=MTIz\nView all event details: https://calendar.google.com/calendar/event?action=VIEW&eid=${eid(event)}&tok=MTIz`

const MINUTE = 60_000
const NOAH = 'Noah Feld <noah@fernway.example>'
/** Google says it made an invitation in the Sender header, whoever the organizer in From is. */
const GOOGLE_SENDER = 'Google Calendar <calendar-notification@google.com>'
const OWNER = 'tessa@northfield.example'

/** A connected, filled account. */
async function world() {
  const h = harness()
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  return h
}

async function arrive(h: H, spec: Parameters<H['google']['mailbox']['add']>[0]) {
  h.google.mailbox.add({ from: NOAH, headers: { Sender: GOOGLE_SENDER }, ...spec })
  await h.push({ body: pushBody('tessa@northfield.example') })
  await h.drain()
}

const conversationOf = (h: H, thread: string) =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(thread) as { id: string }).id
/** Open the way the inbox says it: some message of the conversation is in the Inbox. */
const isOpen = (h: H, thread: string): boolean =>
  (
    h.db
      .query(
        `SELECT count(*) AS n FROM message m JOIN conversation c ON c.id = m.conversation_id
          WHERE c.gmail_thread_id = ? AND m.labels LIKE '%"INBOX"%'`,
      )
      .get(thread) as { n: number }
  ).n > 0
const inGmail = (h: H, id: string): boolean => (h.google.mailbox.messages.get(id)?.labelIds ?? []).includes('INBOX')
const auditOf = (h: H, action: string) =>
  h.db.query(`SELECT actor, subject, after FROM audit WHERE action = ?`).all(action) as {
    actor: string
    subject: string
    after: string
  }[]

describe('a newer update of a calendar event closes the older ones', () => {
  test('three updates of one meeting leave the latest open, in the inbox and in Gmail, closed by the calendar and saying why', async () => {
    const h = await world()
    await arrive(h, {
      id: 'e1',
      threadId: 't1',
      subject: 'Invitation: Roadmap @ Fernway @ Thu Dec 3, 2026 8am',
      ics: ics('evt1'),
      at: T0,
    })
    expect(isOpen(h, 't1')).toBe(true)
    await arrive(h, {
      id: 'e2',
      threadId: 't2',
      subject: 'Updated invitation: Roadmap @ Fernway @ Thu Dec 3, 2026 7am',
      ics: ics('evt1'),
      at: T0 + MINUTE,
    })
    expect(isOpen(h, 't1')).toBe(false)
    await arrive(h, {
      id: 'e3',
      threadId: 't3',
      subject: 'Updated invitation: Roadmap @ Fernway @ Thu Dec 3, 2026 6:45am',
      ics: ics('evt1'),
      at: T0 + 2 * MINUTE,
    })

    expect([isOpen(h, 't1'), isOpen(h, 't2'), isOpen(h, 't3')]).toEqual([false, false, true])
    // Gmail was asked first: its threads are archived, the newest is still in the Inbox.
    expect([inGmail(h, 'e1'), inGmail(h, 'e2'), inGmail(h, 'e3')]).toEqual([false, false, true])
    // Who closed it, and why.
    const closedBy = h.db.query(`SELECT DISTINCT closed_by FROM message WHERE gmail_id IN ('e1', 'e2')`).all()
    expect(closedBy).toEqual([{ closed_by: 'calendar' }])
    const replaced = auditOf(h, 'conversation.replaced')
    expect(replaced.map((r) => r.subject)).toEqual([
      `conversation:${conversationOf(h, 't1')}`,
      `conversation:${conversationOf(h, 't2')}`,
    ])
    expect(JSON.parse(replaced[1]?.after ?? '{}')).toEqual({
      replacedBy: conversationOf(h, 't3'),
      eventKey: 'google:evt1',
    })
    expect(replaced.every((r) => r.actor === 'calendar')).toBe(true)
  })

  test('with no iCalendar part the event is read from the RSVP links in the body', async () => {
    const h = await world()
    await arrive(h, {
      id: 'a1',
      threadId: 'ta1',
      subject: 'Invitation: Standup @ 8am',
      body: links('event002'),
      at: T0,
    })
    await arrive(h, {
      id: 'a2',
      threadId: 'ta2',
      subject: 'Updated invitation: Standup @ 7am',
      body: links('event002'),
      at: T0 + MINUTE,
    })
    expect([isOpen(h, 'ta1'), isOpen(h, 'ta2')]).toEqual([false, true])
  })

  test('a cancellation closes the older ones and stays itself', async () => {
    const h = await world()
    await arrive(h, { id: 'c1', threadId: 'tc1', subject: 'Invitation: Offsite', ics: ics('evt3'), at: T0 })
    await arrive(h, {
      id: 'c2',
      threadId: 'tc2',
      subject: 'Canceled event: Offsite',
      ics: ics('evt3', 'CANCEL'),
      at: T0 + MINUTE,
    })
    expect([isOpen(h, 'tc1'), isOpen(h, 'tc2')]).toEqual([false, true])
  })

  test('a different event, a reply to an invitation, and a one-off invitation are left alone', async () => {
    const h = await world()
    await arrive(h, { id: 'o1', threadId: 'to1', subject: 'Invitation: Lunch', ics: ics('evt4'), at: T0 })
    await arrive(h, { id: 'o2', threadId: 'to2', subject: 'Invitation: Dinner', ics: ics('evt5'), at: T0 + MINUTE })
    await arrive(h, {
      id: 'o3',
      threadId: 'to3',
      subject: 'Accepted: Lunch',
      ics: ics('evt4', 'REPLY'),
      at: T0 + 2 * MINUTE,
    })
    expect([isOpen(h, 'to1'), isOpen(h, 'to2'), isOpen(h, 'to3')]).toEqual([true, true, true])
  })

  test('one occurrence of a repeating event does not replace the other occurrences', async () => {
    const h = await world()
    await arrive(h, {
      id: 'r1',
      threadId: 'tr1',
      subject: 'Invitation: Weekly',
      ics: ics('evt6', 'REQUEST', ['RECURRENCE-ID:20261203T160000Z']),
      at: T0,
    })
    await arrive(h, {
      id: 'r2',
      threadId: 'tr2',
      subject: 'Updated: Weekly',
      ics: ics('evt6', 'REQUEST', ['RECURRENCE-ID:20261112T160000Z']),
      at: T0 + MINUTE,
    })
    expect([isOpen(h, 'tr1'), isOpen(h, 'tr2')]).toEqual([true, true])
  })

  test('an older conversation Tessa replied to, or has a draft on, or a person wrote in, stays open', async () => {
    const h = await world()
    await arrive(h, { id: 'k1', threadId: 'tk1', subject: 'Invitation: Review', ics: ics('evt7'), at: T0 })
    // Tessa replied on the first thread.
    await arrive(h, {
      id: 'k1s',
      threadId: 'tk1',
      labels: ['SENT'],
      from: 'Tessa Marlow <tessa@northfield.example>',
      to: NOAH,
      subject: 'Re: Invitation: Review',
      body: 'I will be 10 minutes late.',
      at: T0 + MINUTE,
    })
    await arrive(h, {
      id: 'k2',
      threadId: 'tk2',
      subject: 'Updated invitation: Review',
      ics: ics('evt7'),
      at: T0 + 2 * MINUTE,
    })
    expect([isOpen(h, 'tk1'), isOpen(h, 'tk2')]).toEqual([true, true])

    // A person wrote in an older thread (no event key on their message).
    await arrive(h, {
      id: 'p1',
      threadId: 'tp1',
      subject: 'Invitation: Planning',
      ics: ics('evt8'),
      at: T0 + 3 * MINUTE,
    })
    await arrive(h, {
      id: 'p1r',
      threadId: 'tp1',
      from: 'Dana Smith <dana@example.com>',
      subject: 'Re: Invitation: Planning',
      body: 'Can we move it a day?',
      at: T0 + 4 * MINUTE,
    })
    await arrive(h, {
      id: 'p2',
      threadId: 'tp2',
      subject: 'Updated invitation: Planning',
      ics: ics('evt8'),
      at: T0 + 5 * MINUTE,
    })
    expect([isOpen(h, 'tp1'), isOpen(h, 'tp2')]).toEqual([true, true])
  })

  test('an older one already archived is not touched, and Gmail is not asked about it', async () => {
    const h = await world()
    await arrive(h, { id: 'x1', threadId: 'tx1', subject: 'Invitation: Sync', ics: ics('evt9'), at: T0 })
    // Tessa archived it himself in Gmail.
    h.google.mailbox.label('x1', { remove: ['INBOX'] })
    await h.push({ body: pushBody('tessa@northfield.example') })
    await h.drain()
    expect(isOpen(h, 'tx1')).toBe(false)
    const before = h.google.calls.length
    await arrive(h, {
      id: 'x2',
      threadId: 'tx2',
      subject: 'Updated invitation: Sync',
      ics: ics('evt9'),
      at: T0 + MINUTE,
    })
    expect(isOpen(h, 'tx2')).toBe(true)
    expect(auditOf(h, 'conversation.replaced')).toEqual([])
    expect(h.google.calls.slice(before).filter((c) => c.startsWith('thread-close'))).toEqual([])
  })

  test('mail that arrives out of order (the older update stored last) is the one that is closed', async () => {
    const h = await world()
    await arrive(h, {
      id: 'y2',
      threadId: 'ty2',
      subject: 'Updated invitation: Demo @ 7am',
      ics: ics('evt10'),
      at: T0 + MINUTE,
    })
    await arrive(h, { id: 'y1', threadId: 'ty1', subject: 'Invitation: Demo @ 8am', ics: ics('evt10'), at: T0 })
    expect([isOpen(h, 'ty1'), isOpen(h, 'ty2')]).toEqual([false, true])
  })

  test('Gmail refusing the close leaves it open and is not asked again for an hour; the ones behind it are closed meanwhile', async () => {
    const h = await world()
    await arrive(h, { id: 'f1', threadId: 'tf1', subject: 'Invitation: Retro', ics: ics('evt11'), at: T0 })
    await arrive(h, { id: 'g1', threadId: 'tg1', subject: 'Invitation: Demo', ics: ics('evt12'), at: T0 })
    h.google.failNext('thread-close', new GmailError('Gmail is down', 500))
    await arrive(h, {
      id: 'f2',
      threadId: 'tf2',
      subject: 'Updated invitation: Retro',
      ics: ics('evt11'),
      at: T0 + MINUTE,
    })
    await arrive(h, {
      id: 'g2',
      threadId: 'tg2',
      subject: 'Updated invitation: Demo',
      ics: ics('evt12'),
      at: T0 + MINUTE,
    })
    // The first close was refused, the second went through in the same run.
    expect([isOpen(h, 'tf1'), isOpen(h, 'tg1')]).toEqual([true, false])
    expect(inGmail(h, 'f1')).toBe(true)

    const closes = () => h.google.calls.filter((c) => c === 'thread-close:tf1').length
    const asked = closes()
    await h.mailroom.runAlarm()
    expect(closes()).toBe(asked)
    expect(isOpen(h, 'tf1')).toBe(true)
    h.tick(61 * 60_000)
    await h.mailroom.runAlarm()
    expect([isOpen(h, 'tf1'), isOpen(h, 'tf2')]).toEqual([false, true])
  })

  test('a reopened conversation stays open: the next runs do not close it or archive it again', async () => {
    const h = await world()
    await arrive(h, { id: 'e1', threadId: 't1', subject: 'Invitation: Infra', ics: ics('evt20'), at: T0 })
    await arrive(h, {
      id: 'e2',
      threadId: 't2',
      subject: 'Updated invitation: Infra',
      ics: ics('evt20'),
      at: T0 + MINUTE,
    })
    expect(isOpen(h, 't1')).toBe(false)

    const reopened = await h.mailroom.changeConversation(conversationOf(h, 't1'), 'reopen', OWNER, null)
    expect(reopened.ok).toBe(true)
    expect([isOpen(h, 't1'), inGmail(h, 'e1')]).toEqual([true, true])
    const closes = h.google.calls.filter((c) => c.startsWith('thread-close')).length
    await h.mailroom.runAlarm()
    await arrive(h, {
      id: 'e3',
      threadId: 't3',
      subject: 'Updated invitation: Infra again',
      ics: ics('evt20'),
      at: T0 + 2 * MINUTE,
    })
    await h.mailroom.runAlarm()
    // The newer update closes the one still standing, never the one a person reopened.
    expect([isOpen(h, 't1'), inGmail(h, 'e1'), isOpen(h, 't2'), isOpen(h, 't3')]).toEqual([true, true, false, true])
    expect(h.google.calls.filter((c) => c.startsWith('thread-close')).length).toBe(closes + 1)
    expect(auditOf(h, 'conversation.replaced')).toHaveLength(2)
  })

  test('a forward from a person, even carrying the invitation, is neither closed nor closes anything', async () => {
    const h = await world()
    const body = `Can you make this one?\n\n${links('event021')}`
    // The forward comes first and a real update after it, then the real invitation comes after a second forward.
    await arrive(h, {
      id: 'w1',
      threadId: 'tw1',
      from: 'Anna Cole <anna@client.example>',
      headers: {},
      subject: 'Fwd: Invitation: Infra',
      body,
      ics: ics('event021'),
      at: T0,
    })
    await arrive(h, { id: 'w2', threadId: 'tw2', subject: 'Invitation: Infra', ics: ics('event021'), at: T0 + MINUTE })
    await arrive(h, {
      id: 'w3',
      threadId: 'tw3',
      from: 'Anna Cole <anna@client.example>',
      headers: {},
      subject: 'Fwd: Invitation: Infra',
      body,
      ics: ics('event021'),
      at: T0 + 2 * MINUTE,
    })
    expect([isOpen(h, 'tw1'), isOpen(h, 'tw2'), isOpen(h, 'tw3')]).toEqual([true, true, true])
    expect(auditOf(h, 'conversation.replaced')).toEqual([])
  })

  test('a person’s own invitation with an agenda they typed (not Google’s) is not keyed', async () => {
    const h = await world()
    const outlook = {
      from: 'Pat Lin <pat@outlook.example>',
      headers: {},
      body: 'Agenda: 1. budget 2. hiring',
      ics: ics('outlookuid1'),
    }
    await arrive(h, { id: 'ol1', threadId: 'tol1', subject: 'Planning', ...outlook, at: T0 })
    await arrive(h, { id: 'ol2', threadId: 'tol2', subject: 'Planning (moved)', ...outlook, at: T0 + MINUTE })
    expect([isOpen(h, 'tol1'), isOpen(h, 'tol2')]).toEqual([true, true])
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE event_key IS NOT NULL`).get()).toEqual({ n: 0 })
  })

  test('a group’s relay ("Notetaker via Engineering") is keyed when it has a List-Id, and a person’s forward of it, an edited-subject forward and a pasted link are not', async () => {
    const h = await world()
    const relay = {
      from: "'Notetaker' via Engineering <engineering@fernway.example>",
      headers: { Sender: 'engineering+bnc123@fernway.example', 'List-Id': 'Engineering <engineering.fernway.example>' },
    }
    await arrive(h, {
      id: 'v1',
      threadId: 'tv1',
      subject: 'Invitation: Infra',
      body: links('event040'),
      ...relay,
      at: T0,
    })
    await arrive(h, {
      id: 'v2',
      threadId: 'tv2',
      subject: 'Updated invitation: Infra',
      body: links('event040'),
      ...relay,
      at: T0 + MINUTE,
    })
    expect([isOpen(h, 'tv1'), isOpen(h, 'tv2')]).toEqual([false, true])

    // The same body with no mark of the calendar or a group on it: a person's forward, in any language, or a new email with the link pasted in.
    const person = { from: 'Anna Cole <anna@client.example>', headers: {} }
    await arrive(h, {
      id: 'u1',
      threadId: 'tu1',
      subject: 'Infra on Thursday',
      body: `FYI\n${links('event041')}`,
      ...person,
      at: T0,
    })
    await arrive(h, {
      id: 'u2',
      threadId: 'tu2',
      subject: 'WG: Einladung: Infra',
      body: `Von: Noah\nGesendet: Montag\n${links('event041')}`,
      ...person,
      at: T0 + MINUTE,
    })
    await arrive(h, {
      id: 'u3',
      threadId: 'tu3',
      subject: 'TR: Invitation: Infra',
      body: `De : Noah\n${links('event041')}`,
      ...person,
      at: T0 + 2 * MINUTE,
    })
    expect([isOpen(h, 'tu1'), isOpen(h, 'tu2'), isOpen(h, 'tu3')]).toEqual([true, true, true])
    expect(
      h.db.query(`SELECT count(*) AS n FROM message WHERE event_key IS NOT NULL AND gmail_id LIKE 'u%'`).get(),
    ).toEqual({ n: 0 })
  })

  test('an old replaced entry does not protect a thread for ever: reopened in Gmail it stays, but new mail in it is replaced like any other', async () => {
    const h = await world()
    // s1 is replaced by s2.
    await arrive(h, { id: 's1', threadId: 't1', subject: 'Invitation: Infra', ics: ics('evt50'), at: T0 })
    await arrive(h, {
      id: 's2',
      threadId: 't2',
      subject: 'Updated invitation: Infra',
      ics: ics('evt50'),
      at: T0 + MINUTE,
    })
    expect(isOpen(h, 't1')).toBe(false)
    // Tessa reopens s1 in Gmail's own app (no entry of ours): it stays open through the next runs.
    h.google.mailbox.label('s1', { add: ['INBOX'] })
    await h.push({ body: pushBody('tessa@northfield.example') })
    await h.drain()
    await h.mailroom.runAlarm()
    expect(isOpen(h, 't1')).toBe(true)
    h.tick()
    // s3 arrives IN s1's thread: new event mail, so t1 now holds the newest update, and the older t2 is the one replaced.
    await arrive(h, {
      id: 's3',
      threadId: 't1',
      subject: 'Updated invitation: Infra (again)',
      ics: ics('evt50'),
      at: T0 + 2 * MINUTE,
    })
    expect([isOpen(h, 't1'), isOpen(h, 't2')]).toEqual([true, false])
    // s4 in a new thread replaces t1 although t1 was closed by the sweep once.
    await arrive(h, {
      id: 's4',
      threadId: 't4',
      subject: 'Updated invitation: Infra (last)',
      ics: ics('evt50'),
      at: T0 + 3 * MINUTE,
    })
    expect([isOpen(h, 't1'), isOpen(h, 't2'), isOpen(h, 't4')]).toEqual([false, false, true])
  })

  test('a newer update in Spam or the Trash replaces nothing', async () => {
    const h = await world()
    await arrive(h, { id: 'z1', threadId: 'tz1', subject: 'Invitation: Sync', ics: ics('evt30'), at: T0 })
    await arrive(h, {
      id: 'z2',
      threadId: 'tz2',
      subject: 'Updated invitation: Sync',
      ics: ics('evt30'),
      at: T0 + MINUTE,
    })
    // z2 is then thrown away, and z1 is open again as if no sweep had closed it.
    h.db.run(`UPDATE message SET labels = '["TRASH"]' WHERE gmail_id = 'z2'`)
    h.db.run(`UPDATE message SET labels = '["INBOX"]', closed_at = NULL, closed_by = NULL WHERE gmail_id = 'z1'`)
    h.db.run(`DELETE FROM audit WHERE action = 'conversation.replaced'`)
    expect(h.inbox.supersededEvents()).toEqual([])
    // Nor does one that Clef judged unsolicited.
    h.db.run(`UPDATE message SET labels = '["INBOX"]', clef_junk = 0.95 WHERE gmail_id = 'z2'`)
    expect(h.inbox.supersededEvents()).toEqual([])
    h.db.run(`UPDATE message SET clef_junk = 0.1 WHERE gmail_id = 'z2'`)
    expect(h.inbox.supersededEvents()).toHaveLength(1)
  })
})

describe('mail stored before the event key existed', () => {
  /** Stored as an older build stored it: no key and no look on any message, the one-time pass not yet run, and no sweep has closed anything. */
  async function oldStore(h: H, ids = ['b1', 'b2']) {
    h.db.run(`UPDATE message SET event_key = NULL, event_kind = NULL`)
    h.db.run(`DELETE FROM setting WHERE key = 'calendar_event_keys_backfilled'`)
    h.db.run(
      `DELETE FROM audit WHERE action IN ('conversation.replaced', 'conversation.close', 'message.event-keys-backfilled')`,
    )
    for (const id of ids) h.google.mailbox.label(id, { add: ['INBOX'] })
    h.db.run(`UPDATE message SET labels = '["INBOX"]', closed_at = NULL, closed_by = NULL`)
  }

  test('the one-time pass reads each candidate again from Gmail for the headers the store never kept, and the same run closes the older conversation; a second run reads nothing', async () => {
    const h = await world()
    await arrive(h, { id: 'b1', threadId: 'tb1', subject: 'Invitation: Infra @ 8am', body: links('event012'), at: T0 })
    await arrive(h, {
      id: 'b2',
      threadId: 'tb2',
      subject: 'Updated invitation: Infra @ 7am',
      body: links('event012'),
      at: T0 + MINUTE,
    })
    // A message that has a link in its text and is a person's: looked at, found not to be calendar mail.
    h.google.mailbox.add({
      id: 'p1',
      threadId: 'tp1',
      from: 'Dana Smith <dana@example.com>',
      subject: 'Which link?',
      body: `This one? ${links('event012')}`,
      at: T0,
    })
    await h.push({ body: pushBody('tessa@northfield.example') })
    await h.drain()
    await oldStore(h)
    expect(h.inbox.calendarPassDone()).toBe(false)
    expect(h.inbox.supersededEvents()).toEqual([])

    const reads = () => h.google.calls.filter((c) => c.startsWith('getMessage')).length
    const before = reads()
    await h.mailroom.runAlarm()
    expect(reads() - before).toBe(3)
    expect(
      h.db
        .query(
          `SELECT gmail_id, event_key, event_kind FROM message WHERE gmail_id IN ('b1', 'b2', 'p1') ORDER BY gmail_id`,
        )
        .all(),
    ).toEqual([
      { gmail_id: 'b1', event_key: 'google:event012', event_kind: 'update' },
      { gmail_id: 'b2', event_key: 'google:event012', event_kind: 'update' },
      { gmail_id: 'p1', event_key: null, event_kind: 'none' },
    ])
    expect([isOpen(h, 'tb1'), isOpen(h, 'tb2'), isOpen(h, 'tp1')]).toEqual([false, true, true])
    expect(h.inbox.calendarPassDone()).toBe(true)
    expect(auditOf(h, 'message.event-keys-backfilled')).toHaveLength(1)

    await h.mailroom.runAlarm()
    expect(reads() - before).toBe(3)
  })

  test('a message Gmail will not give is logged and marked looked at, so it cannot stall the pass; the rest are read', async () => {
    const h = await world()
    await arrive(h, { id: 'b1', threadId: 'tb1', subject: 'Invitation: Infra @ 8am', body: links('event012'), at: T0 })
    await arrive(h, {
      id: 'b2',
      threadId: 'tb2',
      subject: 'Updated invitation: Infra @ 7am',
      body: links('event012'),
      at: T0 + MINUTE,
    })
    await arrive(h, {
      id: 'b3',
      threadId: 'tb3',
      subject: 'Updated invitation: Infra @ 6am',
      body: links('event012'),
      at: T0 + 2 * MINUTE,
    })
    await oldStore(h, ['b1', 'b2', 'b3'])
    h.google.failNext('getMessage', new GmailError('Gmail cannot read this one', 500))
    await h.mailroom.runAlarm()
    // The first in line failed and is left as not calendar mail; the others were read, the pass is done, and the older of those two is closed.
    expect(h.db.query(`SELECT gmail_id, event_kind FROM message ORDER BY gmail_id`).all()).toEqual([
      { gmail_id: 'b1', event_kind: 'none' },
      { gmail_id: 'b2', event_kind: 'update' },
      { gmail_id: 'b3', event_kind: 'update' },
    ])
    expect(h.inbox.calendarPassDone()).toBe(true)
    expect([isOpen(h, 'tb1'), isOpen(h, 'tb2'), isOpen(h, 'tb3')]).toEqual([true, false, true])
    const reads = h.google.calls.filter((c) => c.startsWith('getMessage')).length
    await h.mailroom.runAlarm()
    expect(h.google.calls.filter((c) => c.startsWith('getMessage')).length).toBe(reads)
  })

  test('Gmail failing three in a row is Gmail down, not three bad messages: the run ends, the third is not marked, and the next run reads it', async () => {
    const h = await world()
    await arrive(h, { id: 'b1', threadId: 'tb1', subject: 'Invitation: Infra @ 8am', body: links('event012'), at: T0 })
    await arrive(h, {
      id: 'b2',
      threadId: 'tb2',
      subject: 'Updated invitation: Infra @ 7am',
      body: links('event012'),
      at: T0 + MINUTE,
    })
    await arrive(h, {
      id: 'b3',
      threadId: 'tb3',
      subject: 'Updated invitation: Infra @ 6am',
      body: links('event012'),
      at: T0 + 2 * MINUTE,
    })
    await oldStore(h, ['b1', 'b2', 'b3'])
    h.google.failNext('getMessage', new GmailError('Gmail is down', 503), 3)
    await h.mailroom.runAlarm()
    expect(h.inbox.calendarPassDone()).toBe(false)
    expect(h.db.query(`SELECT gmail_id FROM message WHERE event_kind IS NULL`).all()).toEqual([{ gmail_id: 'b3' }])
    await h.mailroom.runAlarm()
    expect(h.inbox.calendarPassDone()).toBe(true)
    expect(h.db.query(`SELECT event_key FROM message WHERE gmail_id = 'b3'`).get()).toEqual({
      event_key: 'google:event012',
    })
  })
})

describe('a Cloudflare mailbox', () => {
  const invite = (id: string, subject: string, uid: string, method = 'REQUEST') => `MIME-Version: 1.0
From: Noah Feld <noah@fernway.example>
Sender: Google Calendar <calendar-notification@google.com>
Date: Tue, 27 Oct 2026 08:00:02 -0700
Message-ID: <${id}@calendar.example.test>
Subject: ${subject}
To: info@ridgewaycycles.example
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: text/plain; charset="UTF-8"

You are invited to a meeting.
--b1
Content-Type: text/calendar; charset="UTF-8"; method=${method}

BEGIN:VCALENDAR
VERSION:2.0
METHOD:${method}
BEGIN:VEVENT
UID:${uid}@google.com
SUMMARY:Budget review
END:VEVENT
END:VCALENDAR
--b1--
`
  const closedStates = (h: H): boolean[] =>
    (
      h.db
        .query(
          `SELECT min(m.closed_at IS NOT NULL) AS closed FROM conversation c JOIN message m ON m.conversation_id = c.id GROUP BY c.id ORDER BY c.rowid`,
        )
        .all() as { closed: number }[]
    ).map((r) => r.closed === 1)

  test('the older update is closed in the inbox alone when the newer arrives, and the newer stays open', async () => {
    const h = harness()
    await h.deliver(invite('one', 'Invitation: Budget review @ 8am', 'event0010'))
    await h.deliver(invite('two', 'Updated invitation: Budget review @ 7am', 'event0010'))
    await h.deliver(invite('three', 'Invitation: Something else', 'event0011'))
    expect(closedStates(h)).toEqual([true, false, false])
    expect(auditOf(h, 'conversation.replaced')).toHaveLength(1)
    expect(h.db.query(`SELECT DISTINCT closed_by FROM message WHERE closed_by IS NOT NULL`).all()).toEqual([
      { closed_by: 'calendar' },
    ])
  })

  test('a conversation reopened after it was replaced stays open, on later arrivals and when the sweep is asked again', async () => {
    const h = harness()
    await h.deliver(invite('one', 'Invitation: Budget review', 'event0020'))
    await h.deliver(invite('two', 'Updated invitation: Budget review', 'event0020'))
    expect(closedStates(h)).toEqual([true, false])
    const first = (h.db.query(`SELECT id FROM conversation ORDER BY rowid`).get() as { id: string }).id
    expect((await h.mailroom.changeConversation(first, 'reopen', OWNER, null)).ok).toBe(true)
    expect(closedStates(h)).toEqual([false, false])
    await h.deliver(invite('three', 'Updated invitation: Budget review again', 'event0020'))
    expect(h.inbox.closeSupersededLocal()).toBe(0)
    // The second was never reopened, so the third replaces it; the first stays as the person left it.
    expect(closedStates(h)).toEqual([false, true, false])
  })

  test('a cancellation closes the older ones', async () => {
    const h = harness()
    await h.deliver(invite('one', 'Invitation: Budget review', 'event0012'))
    await h.deliver(invite('two', 'Canceled event: Budget review', 'event0012', 'CANCEL'))
    expect(closedStates(h)).toEqual([true, false])
  })
})
