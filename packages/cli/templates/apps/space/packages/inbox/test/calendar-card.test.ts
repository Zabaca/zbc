import { describe, expect, test } from 'bun:test'
import { type CalendarSummary, createInstall, parseCalendarSummary, type SignedIn } from '@space/workspace'
import { runCli } from '../scripts/cli'
import { GmailAuthError, GmailError } from '../src/gmail/google'
import { CALENDAR_PASS_FAILURES, CALENDAR_PASS_PER_RUN } from '../src/gmail/mailroom'
import { parseJmapMessage } from '../src/jmap/parse'
import { bundledInstall } from '../src/workspace'
import { asker, harness, pushBody, T0, TEAM } from '../test-support/harness'
import { CLIENT_ID, CLIENT_SECRET, throughSpace } from '../test-support/space-door'

/**
 * What an email's calendar part says, kept when the mail arrives and shown in place of an empty bubble: the real Mailroom, store and arrivals over a real SQLite and a Google that can fail, driven as the space and Claude's script
 * drive them. The calendar parts are written to the documented shapes, not captured from a live mailbox (the hand test reads one real invitation and one real answer); every person and company is invented.
 */

type H = ReturnType<typeof harness>

const OWNER = 'tessa@northfield.example'
const ZONE = 'America/Los_Angeles'

const ics = (method: string, lines: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', `METHOD:${method}`, 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join(
    '\r\n',
  )

/** Ines Okafor accepts Tessa's invitation to the roadmap review on Nov 13, 2026, 10:00 to 10:30 in Los Angeles. */
const ACCEPTED = ics('REPLY', [
  'UID:abc123def456@google.com',
  'DTSTART:20261113T180000Z',
  'DTEND:20261113T183000Z',
  'SUMMARY:Roadmap review',
  `ORGANIZER;CN=Tessa Marlow:mailto:${OWNER}`,
  'ATTENDEE;PARTSTAT=ACCEPTED;CN=Ines Okafor:mailto:ines@example.com',
])
/** Noah Feld invites Tessa. */
const INVITATION = ics('REQUEST', [
  'UID:inv777@google.com',
  'DTSTART;TZID=America/Los_Angeles:20261120T140000',
  'DTEND;TZID=America/Los_Angeles:20261120T150000',
  'SUMMARY:Fernway planning',
  'LOCATION:Room 4',
  'ORGANIZER;CN=Noah Feld:mailto:noah@fernway.example',
  `ATTENDEE;CN=Tessa Marlow:mailto:${OWNER}`,
  'ATTENDEE;CN=Ines Okafor:mailto:ines@example.com',
])

const INES = 'Ines Okafor <ines@example.com>'
const NOAH = 'Noah Feld <noah@fernway.example>'
const bytes = (text: string) => new TextEncoder().encode(text)
/** The calendar file as Gmail keeps it: a named attachment whose bytes are fetched apart. */
const file = (text: string) => [{ name: 'invite.ics', mimeType: 'text/calendar', bytes: bytes(text) }]

async function world(): Promise<H> {
  const h = harness()
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
  return h
}

async function arrive(h: H, spec: Parameters<H['google']['mailbox']['add']>[0]) {
  h.google.mailbox.add({ at: T0, ...spec })
  await h.push({ body: pushBody(OWNER) })
  await h.drain()
}

const stored = (h: H, gmailId: string): string | null =>
  (h.db.query(`SELECT calendar FROM message WHERE gmail_id = ?`).get(gmailId) as { calendar: string | null }).calendar
const summaryOf = (h: H, gmailId: string): CalendarSummary => {
  const found = parseCalendarSummary(stored(h, gmailId))
  if (found === null) throw new Error(`no summary on ${gmailId}: ${stored(h, gmailId)}`)
  return found
}
const attachmentCalls = (h: H): string[] => h.google.calls.filter((c) => c.startsWith('getAttachment'))

const unwrap = <T>(reply: { ok: boolean; value?: T }): T => {
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  return (reply as { value: T }).value
}

/** What the space is told of one person's messages. */
async function messagesOf(h: H, address: string, who: SignedIn = asker()) {
  return unwrap(await h.space().messagesWith(who, { address })).messages
}
async function lineOf(h: H, address: string): Promise<string | undefined> {
  const { people } = unwrap(await h.space().people(asker()))
  return people.find((p) => p.addresses.includes(address))?.conversations[0]?.snippet
}

describe('a Gmail email arrives', () => {
  test('an inline calendar part is read as it arrives and kept on the message; the space is told it, and the organizer being the owner is "from you"', async () => {
    const h = await world()
    await arrive(h, {
      id: 'a1',
      threadId: 'ta1',
      from: INES,
      subject: 'Accepted: Roadmap review',
      body: '',
      ics: ACCEPTED,
    })
    expect(summaryOf(h, 'a1')).toMatchObject({
      kind: 'reply',
      answer: 'accepted',
      by: { name: 'Ines Okafor', address: 'ines@example.com' },
      title: 'Roadmap review',
      start: Date.UTC(2026, 10, 13, 18, 0),
      uid: 'abc123def456@google.com',
    })
    // The part was in the message: Gmail was not asked for a file.
    expect(attachmentCalls(h)).toEqual([])
    const [m] = await messagesOf(h, 'ines@example.com')
    expect(m?.text).toBe('')
    expect(m?.calendar).toMatchObject({ kind: 'reply', answer: 'accepted', title: 'Roadmap review', fromYou: true })
  })

  test('an invitation from somebody else shows its title, time, place, organizer and guests, and is not "from you"', async () => {
    const h = await world()
    await arrive(h, {
      id: 'a2',
      threadId: 'ta2',
      from: NOAH,
      subject: 'Invitation: Fernway planning',
      body: 'You are invited.',
      ics: INVITATION,
    })
    const [m] = await messagesOf(h, 'noah@fernway.example')
    expect(m?.text).toBe('You are invited.')
    expect(m?.calendar).toMatchObject({
      kind: 'invitation',
      title: 'Fernway planning',
      // 2pm in Los Angeles on Nov 20, 2026 (standard time).
      start: Date.UTC(2026, 10, 20, 22, 0),
      location: 'Room 4',
      organizer: { name: 'Noah Feld', address: 'noah@fernway.example' },
      fromYou: false,
    })
    expect(m?.calendar?.guests.map((g) => g.address)).toEqual([OWNER, 'ines@example.com'])
  })

  test('a calendar FILE whose bytes Gmail keeps apart is asked for once, for that email only, and read', async () => {
    const h = await world()
    await arrive(h, {
      id: 'a3',
      threadId: 'ta3',
      from: INES,
      subject: 'Angenommen: Roadmap review',
      body: '',
      attachments: file(ACCEPTED),
    })
    expect(attachmentCalls(h)).toEqual(['getAttachment:a3/att-a3-0'])
    expect(summaryOf(h, 'a3')).toMatchObject({ kind: 'reply', answer: 'accepted', title: 'Roadmap review' })
    // An ordinary email with a file that is not a calendar one costs no second call.
    await arrive(h, {
      id: 'a4',
      threadId: 'ta4',
      from: NOAH,
      subject: 'The deck',
      body: 'Attached.',
      attachments: [{ name: 'deck.pdf', mimeType: 'application/pdf', bytes: bytes('%PDF') }],
    })
    expect(attachmentCalls(h)).toHaveLength(1)
    expect(stored(h, 'a4')).toBe('none')
  })

  test('a calendar file whose type is only a file name (application/octet-stream, invite.ics) is read too', async () => {
    const h = await world()
    await arrive(h, {
      id: 'a5',
      threadId: 'ta5',
      from: NOAH,
      subject: 'Meeting',
      body: '',
      attachments: [
        { name: 'Meeting.ICS', mimeType: 'application/octet-stream', bytes: bytes(INVITATION), inline: true },
      ],
    })
    expect(summaryOf(h, 'a5')).toMatchObject({ kind: 'invitation', title: 'Fernway planning' })
  })

  test('the second call failing leaves the email stored without a summary and does not fail the sync', async () => {
    const h = await world()
    h.google.failNext('getAttachment', new GmailError('Gmail is down', 503))
    await arrive(h, {
      id: 'a6',
      threadId: 'ta6',
      from: INES,
      subject: 'Accepted: Roadmap review',
      body: '',
      attachments: file(ACCEPTED),
    })
    await arrive(h, { id: 'a7', threadId: 'ta7', from: NOAH, subject: 'Plain mail', body: 'Hello.' })
    // Stored, not looked at (NULL, so a later pass may read it), and the mail behind it was stored too.
    expect(stored(h, 'a6')).toBeNull()
    expect(stored(h, 'a7')).toBe('none')
    const status = h.db.query(`SELECT last_error, retry_count FROM mailbox WHERE kind = 'gmail'`).get() as {
      last_error: string | null
      retry_count: number
    }
    expect(status).toEqual({ last_error: null, retry_count: 0 })
    const [m] = await messagesOf(h, 'ines@example.com')
    expect(m?.calendar).toBeUndefined()
  })

  test('mail with no calendar part is looked at and holds none; a part with no event, or one that cannot be read, is the email as it always was', async () => {
    const h = await world()
    await arrive(h, { id: 'b1', threadId: 'tb1', from: NOAH, subject: 'Hello', body: 'Hi.' })
    await arrive(h, {
      id: 'b2',
      threadId: 'tb2',
      from: NOAH,
      subject: 'Empty calendar',
      body: 'Hi.',
      ics: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR',
    })
    await arrive(h, {
      id: 'b3',
      threadId: 'tb3',
      from: NOAH,
      subject: 'Garbage',
      body: 'Hi.',
      ics: '\u0000\u0001 not a calendar',
    })
    expect([stored(h, 'b1'), stored(h, 'b2'), stored(h, 'b3')]).toEqual(['none', 'none', 'none'])
    const [m] = await messagesOf(h, 'noah@fernway.example')
    expect(m?.calendar).toBeUndefined()
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE gmail_id IN ('b1', 'b2', 'b3')`).get()).toEqual({ n: 3 })
  })

  test('a person’s own mail is summarised too, though it is never keyed: the summary closes nothing', async () => {
    const h = await world()
    await arrive(h, {
      id: 'c1',
      threadId: 'tc1',
      from: NOAH,
      subject: 'Planning',
      body: 'Agenda: budget.',
      ics: INVITATION,
    })
    await arrive(h, {
      id: 'c2',
      threadId: 'tc2',
      from: NOAH,
      subject: 'Planning (moved)',
      body: 'Agenda: budget.',
      ics: INVITATION,
    })
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE event_key IS NOT NULL`).get()).toEqual({ n: 0 })
    expect(summaryOf(h, 'c1').kind).toBe('invitation')
    expect(summaryOf(h, 'c2').kind).toBe('invitation')
    const open = h.db.query(`SELECT count(*) AS n FROM message WHERE closed_at IS NOT NULL`).get()
    expect(open).toEqual({ n: 0 })
  })

  test('an email with a calendar summary and no words of its own is listed under the line the summary makes, in the company’s clock', async () => {
    const h = await world()
    await arrive(h, {
      id: 'd1',
      threadId: 'td1',
      from: INES,
      subject: 'Accepted: Roadmap review',
      body: '',
      attachments: file(ACCEPTED),
    })
    expect(await lineOf(h, 'ines@example.com')).toBe(
      'Ines Okafor accepted: Roadmap review, Fri, Nov 13, 10:00 AM to 10:30 AM PST',
    )
    // With words of its own the words are the line, as ever.
    await arrive(h, {
      id: 'd2',
      threadId: 'td2',
      from: NOAH,
      subject: 'Invitation',
      body: 'You are invited to plan Fernway.',
      ics: INVITATION,
    })
    expect(await lineOf(h, 'noah@fernway.example')).toBe('You are invited to plan Fernway.')
    expect(ZONE).toBe(bundledInstall.company.timeZone)
  })

  test('the calendar summary is cut from what the page asks of the inbox when the stored column is not a summary', async () => {
    const h = await world()
    await arrive(h, { id: 'e1', threadId: 'te1', from: INES, subject: 'Accepted', body: '', ics: ACCEPTED })
    h.db.run(`UPDATE message SET calendar = '{"kind":"bogus"}' WHERE gmail_id = 'e1'`)
    const [m] = await messagesOf(h, 'ines@example.com')
    expect(m?.calendar).toBeUndefined()
    expect(await lineOf(h, 'ines@example.com')).toBe('')
  })
})

describe('mail from a business mailbox and the install’s own mail server', () => {
  const invite = (extra: string, bodyType = 'text/plain') => `MIME-Version: 1.0
From: ${NOAH}
Date: Tue, 27 Oct 2026 08:00:02 -0700
Message-ID: <inv-${extra.length}@calendar.example.test>
Subject: Invitation: Fernway planning
To: info@ridgewaycycles.example
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: ${bodyType}; charset="UTF-8"

You are invited to a meeting.
--b1
Content-Type: text/calendar; charset="UTF-8"; method=REQUEST
${extra}
${INVITATION.replaceAll('\r\n', '\n')}
--b1--
`

  test('a calendar part in a business mailbox’s mail is kept on the message as it is filed', async () => {
    const h = harness()
    expect((await h.deliver(invite(''))).entered).toBe('filed')
    const row = h.db
      .query(`SELECT calendar FROM message WHERE mailbox_id IN (SELECT id FROM mailbox WHERE kind = 'cloudflare')`)
      .get() as { calendar: string }
    expect(parseCalendarSummary(row.calendar)).toMatchObject({
      kind: 'invitation',
      title: 'Fernway planning',
      start: Date.UTC(2026, 10, 20, 22, 0),
    })
  })

  test('a calendar file with no declared calendar type, only a name, and mail with none, are handled as they are in Gmail', async () => {
    const h = harness()
    const raw = `MIME-Version: 1.0
From: ${NOAH}
Date: Tue, 27 Oct 2026 08:00:02 -0700
Message-ID: <file1@calendar.example.test>
Subject: The file
To: info@ridgewaycycles.example
Content-Type: multipart/mixed; boundary="b1"

--b1
Content-Type: text/plain; charset="UTF-8"

Attached.
--b1
Content-Type: application/octet-stream; name="invite.ics"
Content-Disposition: attachment; filename="invite.ics"
Content-Transfer-Encoding: base64

${btoa(INVITATION)}
--b1--
`
    expect((await h.deliver(raw)).entered).toBe('filed')
    expect(
      (
        await h.deliver(
          `From: ${NOAH}\nTo: info@ridgewaycycles.example\nSubject: Plain\nMessage-ID: <plain1@x.example>\nContent-Type: text/plain\n\nHello.\n`,
        )
      ).entered,
    ).toBe('filed')
    const rows = h.db.query(`SELECT subject, calendar FROM message ORDER BY rowid`).all() as {
      subject: string
      calendar: string
    }[]
    expect(parseCalendarSummary(rows[0]?.calendar)).toMatchObject({ kind: 'invitation', title: 'Fernway planning' })
    expect(rows[1]).toEqual({ subject: 'Plain', calendar: 'none' })
  })

  test('mail on the install’s own mail server is read through the same parser: its summary is on the message the store is handed', async () => {
    const raw = new TextEncoder().encode(invite('').replaceAll('\n', '\r\n'))
    const parsed = await parseJmapMessage(
      { id: 'j1', threadId: 'jt1', receivedAt: '2026-10-27T15:00:02Z' } as never,
      raw,
      [],
    )
    expect(parsed.calendar).toMatchObject({ kind: 'invitation', title: 'Fernway planning' })
    // A message the bytes of which were not read (too large) has none and is not marked as looked at.
    const unread = await parseJmapMessage(
      { id: 'j2', threadId: 'jt2', receivedAt: '2026-10-27T15:00:02Z' } as never,
      null,
      [],
    )
    expect(unread.calendar).toBeUndefined()
  })
})

describe('a teammate on a mailbox', () => {
  const ALEX = 'alex@harborline.example'
  const BEA = 'bea@harborline.example'
  const DESK = 'desk@harborline.example'
  const HARBORLINE = createInstall({
    company: {
      id: 'harborline',
      name: 'Harborline Boats',
      domain: 'harborline.example',
      timeZone: 'America/Los_Angeles',
    },
    access: { teamDomain: TEAM },
    formsService: { contact: 'help@harborline.example' },
    space: { host: 'space.harborline.example', sessionDuration: '730h' },
    people: [
      { address: ALEX, name: 'Alex', mailName: 'Alex Rowe', role: 'owner' },
      { address: BEA, name: 'Bea', role: 'member' },
    ],
    businesses: [{ id: 'harborline', name: 'Harborline Boats', mailboxes: [DESK] }],
    cloudflareMailboxes: [{ address: DESK, name: 'Desk', people: [ALEX, BEA] }],
    agent: { path: '/agent/inbox' },
    switches: { claudeScript: true },
  })

  test('sees the same card and the same line as the owner would, and "from you" only for their own address', async () => {
    const h = harness({}, { install: HARBORLINE, mailboxes: [{ address: DESK, name: 'Desk' }] })
    const mail = (organizer: string) => `MIME-Version: 1.0
From: Cora Lund <cora@dock.example>
Date: Tue, 27 Oct 2026 08:00:02 -0700
Message-ID: <desk-${organizer.length}@dock.example>
Subject: Invitation: Dock survey
To: ${DESK}
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: text/calendar; charset="UTF-8"; method=REQUEST

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:dock1@example.com
DTSTART:20261113T180000Z
DTEND:20261113T190000Z
SUMMARY:Dock survey
ORGANIZER;CN=Someone:mailto:${organizer}
END:VEVENT
END:VCALENDAR
--b1--
`
    expect((await h.deliver(mail(BEA), { to: DESK })).entered).toBe('filed')
    const part = h.space({ install: HARBORLINE })
    const as = (who: string) => asker({ email: who }, HARBORLINE)
    const seen = async (who: string) =>
      unwrap(await part.messagesWith(as(who), { address: 'cora@dock.example' })).messages[0]?.calendar
    expect(await seen(BEA)).toMatchObject({ kind: 'invitation', title: 'Dock survey', fromYou: true })
    // The owner is on the Desk too, and Bea is not Alex: the organizer is not "you" to him.
    expect(await seen(ALEX)).toMatchObject({ kind: 'invitation', title: 'Dock survey', fromYou: false })
    const lines = unwrap(await part.people(as(BEA))).people.flatMap((p) => p.conversations.map((c) => c.snippet))
    expect(lines).toEqual(['Invitation: Dock survey, Fri, Nov 13, 10:00 AM to 11:00 AM PST'])
  })
})

describe('Claude’s script', () => {
  const script = (h: H) => {
    const door = throughSpace(h)
    const io = {
      env: {
        INBOX_URL: bundledInstall.agentDoor()?.url ?? 'no door',
        INBOX_ACCESS_CLIENT_ID: CLIENT_ID,
        INBOX_ACCESS_CLIENT_SECRET: CLIENT_SECRET,
      },
      sopsKey: () => {
        throw new Error('sops must not be called when the env is set')
      },
      readInput: async (spec: string) => spec,
      fetch: (url: string, init: RequestInit) => door.fetch(url, init as never),
    }
    return (...argv: string[]) => runCli(argv, io as never)
  }

  test('prints the one line with a message that has no words, and the queue lists the conversation under it', async () => {
    const h = await world()
    await arrive(h, {
      id: 's1',
      threadId: 'ts1',
      from: INES,
      subject: 'Accepted: Roadmap review',
      body: '',
      attachments: file(ACCEPTED),
    })
    await arrive(h, {
      id: 's2',
      threadId: 'ts2',
      from: NOAH,
      subject: 'Invitation',
      body: 'You are invited to plan Fernway.',
      ics: INVITATION,
    })
    const run = script(h)
    const queue = JSON.parse((await run('queue')).output) as { rows: { subject: string; snippet: string }[] }
    expect(queue.rows.find((r) => r.subject === 'Accepted: Roadmap review')?.snippet).toBe(
      'Ines Okafor accepted: Roadmap review, Fri, Nov 13, 10:00 AM to 10:30 AM PST',
    )
    const conversation = (subject: string) =>
      (
        h.db
          .query(`SELECT c.id FROM conversation c JOIN message m ON m.conversation_id = c.id WHERE m.subject = ?`)
          .get(subject) as { id: string }
      ).id
    const empty = JSON.parse((await run('conversation', conversation('Accepted: Roadmap review'))).output) as {
      messages: { body: string; calendarLine?: string; calendar?: { kind: string } }[]
    }
    expect(empty.messages[0]).toMatchObject({
      body: '',
      calendarLine: 'Ines Okafor accepted: Roadmap review, Fri, Nov 13, 10:00 AM to 10:30 AM PST',
      calendar: { kind: 'reply' },
    })
    // A message with words of its own needs no line.
    const words = JSON.parse((await run('conversation', conversation('Invitation'))).output) as {
      messages: { calendarLine?: string }[]
    }
    expect(words.messages[0]?.calendarLine).toBeUndefined()
  })
})

describe('the one-time pass over mail stored before the summary existed', () => {
  /** Stored as an older build stored it: no summary and no look on any message, and the pass not yet run. */
  function oldStore(h: H) {
    h.db.run(`UPDATE message SET calendar = NULL`)
    h.db.run(`DELETE FROM setting WHERE key = 'calendar_summaries_backfilled'`)
    h.db.run(`DELETE FROM audit WHERE action = 'message.calendar-summaries-backfilled'`)
  }
  const reads = (h: H) => h.google.calls.filter((c) => c.startsWith('getMessage')).length
  const lookedAt = (h: H) =>
    (
      h.db.query(`SELECT gmail_id, calendar IS NOT NULL AS looked FROM message ORDER BY gmail_id`).all() as {
        gmail_id: string
        looked: number
      }[]
    ).map((r) => [r.gmail_id, r.looked === 1])

  test('reads candidates only (a calendar file in the list, an event key, or no words), once each: a person’s mail with words and no file is never read again, and a second run reads nothing', async () => {
    const h = await world()
    await arrive(h, {
      id: 'p1',
      threadId: 'tp1',
      from: INES,
      subject: 'Angenommen: Roadmap review',
      body: '',
      attachments: file(ACCEPTED),
    })
    await arrive(h, {
      id: 'p2',
      threadId: 'tp2',
      from: NOAH,
      subject: 'Invitation',
      body: 'You are invited to plan Fernway.',
      ics: INVITATION,
      headers: { Sender: 'Google Calendar <calendar-notification@google.com>' },
    })
    await arrive(h, { id: 'p3', threadId: 'tp3', from: INES, subject: 'Nothing in it', body: '' })
    await arrive(h, { id: 'p4', threadId: 'tp4', from: NOAH, subject: 'Lunch?', body: 'Are you free on Friday?' })
    await arrive(h, {
      id: 'p5',
      threadId: 'tp5',
      from: NOAH,
      subject: 'The deck',
      body: 'Attached.',
      attachments: [{ name: 'deck.pdf', mimeType: 'application/pdf', bytes: bytes('%PDF') }],
    })
    oldStore(h)
    expect(h.inbox.calendarSummariesDone()).toBe(false)
    expect(
      h.inbox.calendarSummaryCandidates(h.inbox.mailboxRowAt(OWNER)?.id as string, 100).map((c) => c.gmailId),
    ).toEqual(['p1', 'p2', 'p3'])

    const before = reads(h)
    await h.mailroom.runAlarm()
    // Three candidates read; the words-only mail and the PDF were never asked for.
    expect(reads(h) - before).toBe(3)
    expect(lookedAt(h)).toEqual([
      ['p1', true],
      ['p2', true],
      ['p3', true],
      ['p4', false],
      ['p5', false],
    ])
    expect(summaryOf(h, 'p1')).toMatchObject({ kind: 'reply', answer: 'accepted' })
    expect(summaryOf(h, 'p2')).toMatchObject({ kind: 'invitation' })
    expect(stored(h, 'p3')).toBe('none')
    expect(h.inbox.calendarSummariesDone()).toBe(true)
    expect(
      h.db.query(`SELECT count(*) AS n FROM audit WHERE action = 'message.calendar-summaries-backfilled'`).get(),
    ).toEqual({ n: 1 })

    await h.mailroom.runAlarm()
    expect(reads(h) - before).toBe(3)
    // The card is there the moment the conversation opens, and the list says it.
    expect((await messagesOf(h, 'ines@example.com'))[0]?.calendar).toMatchObject({ kind: 'reply', answer: 'accepted' })
    const { people } = unwrap(await h.space().people(asker()))
    const listed = people.flatMap((p) => p.conversations).find((c) => c.subject === 'Angenommen: Roadmap review')
    expect(listed?.snippet).toBe('Ines Okafor accepted: Roadmap review, Fri, Nov 13, 10:00 AM to 10:30 AM PST')
  })

  test('at most 100 a run, with the alarm asked for again while more are left', async () => {
    const h = await world()
    for (let i = 0; i < CALENDAR_PASS_PER_RUN + 5; i += 1) {
      await arrive(h, {
        id: `q${String(i).padStart(3, '0')}`,
        threadId: `tq${i}`,
        from: INES,
        subject: `Reply ${i}`,
        body: '',
        ics: ACCEPTED,
      })
    }
    oldStore(h)
    const before = reads(h)
    const alarms = h.alarms.length
    await h.mailroom.runAlarm()
    expect(reads(h) - before).toBe(CALENDAR_PASS_PER_RUN)
    expect(h.inbox.calendarSummariesDone()).toBe(false)
    expect(h.alarms.length).toBeGreaterThan(alarms)
    await h.mailroom.runAlarm()
    expect(reads(h) - before).toBe(CALENDAR_PASS_PER_RUN + 5)
    expect(h.inbox.calendarSummariesDone()).toBe(true)
  })

  test('a message Gmail will not give is logged and marked looked at, so it cannot stall the pass; the rest are read', async () => {
    const h = await world()
    await arrive(h, { id: 'r1', threadId: 'tr1', from: INES, subject: 'One', body: '', ics: ACCEPTED })
    await arrive(h, { id: 'r2', threadId: 'tr2', from: INES, subject: 'Two', body: '', ics: ACCEPTED })
    oldStore(h)
    h.google.failNext('getMessage', new GmailError('Gmail cannot read this one', 500))
    await h.mailroom.runAlarm()
    expect(stored(h, 'r1')).toBe('none')
    expect(summaryOf(h, 'r2').kind).toBe('reply')
    expect(h.inbox.calendarSummariesDone()).toBe(true)
  })

  test('Gmail failing three in a row is Gmail down, not three bad messages: the run ends, the third is not marked, and the next run reads it', async () => {
    const h = await world()
    for (const id of ['t1', 't2', 't3'])
      await arrive(h, { id, threadId: `t-${id}`, from: INES, subject: id, body: '', ics: ACCEPTED })
    oldStore(h)
    h.google.failNext('getMessage', new GmailError('Gmail is down', 503), CALENDAR_PASS_FAILURES)
    await h.mailroom.runAlarm()
    expect(h.inbox.calendarSummariesDone()).toBe(false)
    expect(h.db.query(`SELECT gmail_id FROM message WHERE calendar IS NULL`).all()).toEqual([{ gmail_id: 't3' }])
    await h.mailroom.runAlarm()
    expect(h.inbox.calendarSummariesDone()).toBe(true)
    expect(summaryOf(h, 't3').kind).toBe('reply')
  })

  test('a file Gmail keeps apart is asked for in the pass', async () => {
    const h = await world()
    await arrive(h, {
      id: 'u1',
      threadId: 'tu1',
      from: INES,
      subject: 'Angenommen',
      body: '',
      attachments: file(ACCEPTED),
    })
    oldStore(h)
    const asked = attachmentCalls(h).length
    await h.mailroom.runAlarm()
    expect(attachmentCalls(h).length).toBe(asked + 1)
    expect(summaryOf(h, 'u1')).toMatchObject({ kind: 'reply', answer: 'accepted' })
    expect(h.inbox.calendarSummariesDone()).toBe(true)
  })

  test('an account whose grant Gmail ended is left for later: nothing is read for it, the pass is not done while it has mail left, and it goes on once the account is connected again', async () => {
    const h = await world()
    await arrive(h, {
      id: 'w1',
      threadId: 'tw1',
      from: INES,
      subject: 'Angenommen',
      body: '',
      attachments: file(ACCEPTED),
    })
    oldStore(h)
    const id = h.inbox.mailboxRowAt(OWNER)?.id as string
    h.inbox.markGrantLapsed(id)
    const before = reads(h)
    await h.mailroom.runAlarm()
    expect(reads(h)).toBe(before)
    expect(stored(h, 'w1')).toBeNull()
    expect(h.inbox.calendarSummariesDone()).toBe(false)
    expect((await h.connect()).ok).toBe(true)
    await h.drain()
    await h.mailroom.runAlarm()
    expect(summaryOf(h, 'w1').kind).toBe('reply')
    expect(h.inbox.calendarSummariesDone()).toBe(true)
  })

  test('Google ending the grant mid-pass ends the run and leaves the rest', async () => {
    const h = await world()
    await arrive(h, { id: 'x1', threadId: 'tx1', from: INES, subject: 'One', body: '', ics: ACCEPTED })
    await arrive(h, { id: 'x2', threadId: 'tx2', from: INES, subject: 'Two', body: '', ics: ACCEPTED })
    oldStore(h)
    h.google.failNext('getMessage', new GmailAuthError('Google ended the grant'))
    await h.mailroom.runAlarm()
    expect(h.inbox.calendarSummariesDone()).toBe(false)
    expect(h.db.query(`SELECT count(*) AS n FROM message WHERE calendar IS NULL`).get()).toEqual({ n: 2 })
  })

  test('mail on a business mailbox or the mail server is not passed over: only Gmail mail is a candidate', async () => {
    const h = await world()
    expect(
      (
        await h.deliver(
          `From: ${NOAH}\nTo: info@ridgewaycycles.example\nSubject: Old\nMessage-ID: <old1@x.example>\nContent-Type: text/plain\n\n\n`,
        )
      ).entered,
    ).toBe('filed')
    oldStore(h)
    const ridgeway = h.db.query(`SELECT id FROM mailbox WHERE kind = 'cloudflare'`).get() as { id: string }
    expect(h.inbox.calendarSummaryCandidates(ridgeway.id, 100)).toEqual([])
  })

  test('new mail is notified BEFORE the pass runs, so the pass never delays a bell', async () => {
    const h = await world()
    await arrive(h, { id: 'v1', threadId: 'tv1', from: INES, subject: 'Old one', body: '', ics: ACCEPTED })
    oldStore(h)
    const order: string[] = []
    const notify = h.mailroom as unknown as { notify: () => Promise<void> }
    const original = notify.notify.bind(h.mailroom)
    notify.notify = async () => {
      order.push('notify')
      await original()
    }
    h.google.mailbox.add({ id: 'v2', threadId: 'tv2', from: NOAH, subject: 'New mail', body: 'Hello', at: T0 })
    const asked = h.google.calls.length
    await h.push({ body: pushBody(OWNER) })
    await h.drain()
    const calls = h.google.calls.slice(asked)
    // The new message was fetched (and notified) in the sync; the old one was read again by the pass after it.
    expect(order[0]).toBe('notify')
    expect(calls.filter((c) => c.startsWith('getMessage'))).toEqual(['getMessage:v2', 'getMessage:v1'])
    expect(summaryOf(h, 'v1').kind).toBe('reply')
  })
})
