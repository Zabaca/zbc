import { describe, expect, test } from 'bun:test'
import { CLEF_JUNK_THRESHOLD } from '../src/queue'
import { CLEF_CATEGORIES, classifyMail, SHIFTLANTERN_CATEGORIES } from '../test-support/content'
import { clef, FakeAi } from '../test-support/fake-ai'
import { AGENT, asHttp, harness, RIDGEWAY_ASSISTED, SHIFTLANTERN_ASSISTED } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { decrypt, newDevice } from '../test-support/push-device'
import { JUNK, KEEP, type SampleMail } from '../test-support/shiftlantern-mail'

/**
 * ShiftLantern's own spam questions (ADR-007, decision 24; hello@shiftlantern.example). The worst mistake this check can make is
 * calling a worker's real question spam, so what is held here is that the questions lean to keeping mail and that a worker's
 * message, in English, Spanish or Chinese, written well or badly, is put to the model whole and ends in the Inbox, notifying.
 *
 * ⚠️ WHAT THIS CANNOT SHOW: Clef. The Workers AI binding here is a fake that answers what each test says, so a "judged spam" below
 * is the fake's answer and the tests show the wiring (the right questions, the whole message, what the inbox does with a score),
 * not that the real model scores these messages the way the test says. The same messages are run through the real model by
 * `bun packages/inbox/scripts/measure-spam-questions.ts`, and the runbook's "The spam questions" is where its numbers are read.
 */

type H = ReturnType<typeof harness>

const HELLO = 'hello@shiftlantern.example'
const INFO = 'info@ridgewaycycles.example'

const rows = <T>(h: H, sql: string): T[] => h.db.query(sql).all() as T[]

const checked = () => harness({}, { mailboxes: [RIDGEWAY_ASSISTED, SHIFTLANTERN_ASSISTED] })

/** A header value a person's name or subject may be put in, whatever the script: RFC 2047 when it is not plain ASCII. */
const word = (text: string): string =>
  /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`

let seq = 0
const deliver = (h: H, m: SampleMail, to = HELLO) => {
  seq += 1
  const raw = `${[
    `From: ${word(m.name)} <${m.from}>`,
    `To: ${to}`,
    `Subject: ${word(m.subject)}`,
    `Message-ID: <rcs${seq}@example.net>`,
    'Date: Tue, 20 Oct 2026 12:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.body, 'utf8').toString('base64'),
  ].join('\r\n')}\r\n`
  return h.deliver(raw, { from: m.from, to })
}

const queue = async (h: H, filter: 'inbox' | 'bulk') =>
  (await h.request(AGENT, 'GET', `/api/queue?filter=${filter}`)).json.rows as {
    id: string
    subject: string
    spam?: boolean
  }[]
const detail = async (h: H, id: string) => (await h.request(AGENT, 'GET', `/api/conversations/${id}`)).json

const PIXEL_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'

/**
 * Notifications on, as Settings does after the browser subscribed (the Notifications class's `addDevice` as Tessa, which is what the space's entrypoint calls: the owner has
 * no router); what is heard is decrypted with the device's own key.
 */
async function turnOn(h: H) {
  const device = await newDevice()
  const res = asHttp(
    await h.store.call('addDevice', { endpoint: device.endpoint, keys: device.keys }, PIXEL_UA, OWNER_EMAIL),
  )
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return device
}
const heard = async (h: H, device: Awaited<ReturnType<typeof newDevice>>) =>
  Promise.all(h.pushService.to(device.endpoint).map(async (r) => JSON.parse((await decrypt(device, r.body)).text)))

/** The questions Clef was shown on the last call, as text, and the two halves that decide the judgment. */
const shownQuestions = (ai: FakeAi | null | undefined) => {
  const q = ai?.calls.at(-1)?.input.questions as {
    category: { instructions: string; criteria: Record<string, string> }
    junk: { instructions: string; criteria: { true: string; false: string } }
  }
  return { q, text: JSON.stringify(q) }
}

describe('the questions ShiftLantern’s mail is put to', () => {
  test('are about ShiftLantern and its workers, and nothing of Ridgeway’s is in them', async () => {
    const h = checked()
    await deliver(h, KEEP[0] as SampleMail)
    const { q, text } = shownQuestions(h.ai)

    expect(text).toContain('ShiftLantern')
    expect(text).toContain('Oregon')
    expect(text).toContain('Tessa')
    expect(text).not.toMatch(/Ridgeway|Alder Bend|tune-up|wheel build|fitting|customer/i)
    expect(Object.keys(q.category.criteria)).toEqual([...SHIFTLANTERN_CATEGORIES])
  })

  test('Ridgeway’s mail is still put to Ridgeway’s questions, with none of ShiftLantern’s in them', async () => {
    const h = checked()
    await h.deliver(
      'From: Dana <dana@example.net>\r\nTo: x\r\nSubject: Hours\r\nMessage-ID: <f1@example.net>\r\n\r\nWalk-in?',
      {
        from: 'dana@example.net',
        to: INFO,
      },
    )
    const { q, text } = shownQuestions(h.ai)
    expect(text).toContain('Ridgeway Cycles')
    expect(text).not.toContain('ShiftLantern')
    expect(Object.keys(q.category.criteria)).toEqual([...CLEF_CATEGORIES])
  })

  test('lean to keeping mail: a worker is never to be kept out, the doubt goes to the Inbox, and the model is told so twice', async () => {
    const h = checked()
    await deliver(h, KEEP[0] as SampleMail)
    const { q } = shownQuestions(h.ai)

    expect(q.junk.instructions).toContain('Never keep a worker’s message out'.replace('’', "'"))
    expect(q.junk.instructions).toContain('in any language')
    expect(q.junk.instructions).toContain('the answer is no')
    expect(q.junk.criteria.false).toContain('If you cannot tell, answer no.')
    // The side that keeps mail names the people who really write, and the side that drops it names only what a seller sends.
    for (const kept of [
      'last paycheck',
      'being let go',
      'breaks',
      'leave',
      'any language',
      'hard to follow',
      'correction',
      "workers' group",
      'legal aid',
      'union',
      'reporter',
      'researcher',
      'library',
      'lawyer',
    ]) {
      expect(q.junk.criteria.false.toLowerCase(), kept).toContain(kept)
    }
    for (const sold of [
      'SEO',
      'link-building',
      'guest-post',
      'website design',
      'advertising',
      'lead-generation',
      'crypto',
      'phishing',
      'invoices',
      'partnership',
    ]) {
      expect(q.junk.criteria.true, sold).toContain(sold)
    }
    expect(q.junk.criteria.true).toContain('No job and no workplace rule is the subject of it')
    expect(q.junk.criteria.true).not.toMatch(/worker|employee|lawyer|upset|Spanish/i)
    // The kind the worker is filed under is the first the model is shown, and says it holds however the message is written.
    expect(Object.keys(q.category.criteria)[0]).toBe('worker_question')
    expect(q.category.criteria.worker_question).toContain('Tone, length, spelling and language do not matter')
  })

  test('an answer is accepted only in the mailbox’s own kinds: Ridgeway’s “customer” is nothing to ShiftLantern, and the reverse', async () => {
    const mail = { from: 'a <a@example.net>', to: HELLO, subject: 's', body: 'b' }
    const ask = (mailbox: string, kind: string) => classifyMail(new FakeAi().next(clef(0.1, kind)), mail, { mailbox })
    expect((await ask(HELLO, 'worker_question'))?.category).toBe('worker_question')
    expect((await ask(HELLO, 'organization_or_professional'))?.category).toBe('organization_or_professional')
    expect(await ask(HELLO, 'customer')).toBeNull()
    expect(await ask(INFO, 'customer')).toMatchObject({ category: 'customer' })
    expect(await ask(INFO, 'worker_question')).toBeNull()
  })

  test('a mailbox with no questions is not asked, whatever the caller says', async () => {
    const ai = new FakeAi()
    expect(
      await classifyMail(ai, { from: 'a', to: 'b', subject: 's', body: 'b' }, { mailbox: 'hello@example.org' }),
    ).toBeNull()
    expect(ai.calls).toHaveLength(0)
  })
})

describe('a worker’s message', () => {
  test.each(KEEP.map((m) => [m.id, m] as const))(
    '%s is put to the model whole and, judged a person, is in the Inbox and rings once',
    async (_id, m) => {
      const h = checked()
      const device = await turnOn(h)
      h.ai?.next(clef(0.06, 'worker_question'))

      expect((await deliver(h, m)).entered).toBe('filed')

      // Whole: the words as the person wrote them, in whatever script, and their name and subject.
      expect(h.ai?.calls).toHaveLength(1)
      const shown = h.ai?.shown() ?? {}
      expect(shown.body).toBe(m.body)
      expect(shown.subject).toBe(m.subject)
      expect(shown.from).toContain(m.from)
      expect(shown.to).toBe(HELLO)

      const inbox = await queue(h, 'inbox')
      expect(inbox.map((r) => r.subject)).toEqual([m.subject])
      expect(await queue(h, 'bulk')).toEqual([])
      expect(inbox[0]?.spam).toBeFalsy()
      const convo = await detail(h, (inbox[0] as { id: string }).id)
      expect(convo).toMatchObject({ bulk: false, spam: false, reasons: ['Clef: a worker’s question (0.06).'] })

      const seen = await heard(h, device)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ kind: 'message', title: expect.stringContaining('ShiftLantern:') })
      expect(rows(h, `SELECT notify FROM message WHERE direction = 'in'`)).toEqual([{ notify: 'sent' }])
    },
  )

  test('a message the model is not sure of stays in the Inbox, one hundredth under the line, and the line is the shared one', async () => {
    expect(CLEF_JUNK_THRESHOLD).toBe(0.8)
    const h = checked()
    h.ai?.next(clef(0.79, 'vendor_pitch'))
    await deliver(h, KEEP[5] as SampleMail)
    expect((await queue(h, 'inbox')).map((r) => r.subject)).toEqual(['help'])
    expect(await queue(h, 'bulk')).toEqual([])
  })

  test('one the model gets wrong is kept, says why with its score, and is one move back to the Inbox', async () => {
    const h = checked()
    const device = await turnOn(h)
    h.ai?.next(clef(0.93, 'vendor_pitch'))
    const m = KEEP[1] as SampleMail
    await deliver(h, m)

    const bulk = await queue(h, 'bulk')
    expect(bulk.map((r) => r.subject)).toEqual([m.subject])
    expect(bulk[0]?.spam).toBe(true)
    expect(await queue(h, 'inbox')).toEqual([])
    expect(await heard(h, device)).toHaveLength(0)
    // Kept: the conversation and the raw copy are there, the reason line carries the score, and nothing is deleted.
    const id = (bulk[0] as { id: string }).id
    expect(await detail(h, id)).toMatchObject({ bulk: true, spam: true, reasons: ['Clef: selling something (0.93).'] })
    expect(rows<{ n: number }>(h, `SELECT count(*) AS n FROM message WHERE direction = 'in'`)[0]?.n).toBe(1)

    const back = await asHttp(await h.store.call('setSpam', id, false, OWNER_EMAIL))
    expect(back.status, JSON.stringify(back.json)).toBe(200)
    expect((await queue(h, 'inbox')).map((r) => r.subject)).toEqual([m.subject])
    expect(await queue(h, 'bulk')).toEqual([])
  })

  test('a model outage files the worker’s message in the Inbox, not judged, and still rings', async () => {
    const h = checked()
    const device = await turnOn(h)
    h.ai?.next({ kind: 'fail', message: 'AiError: 3040: Capacity temporarily exceeded' })
    await deliver(h, KEEP[2] as SampleMail)
    expect((await queue(h, 'inbox')).map((r) => r.subject)).toEqual([(KEEP[2] as SampleMail).subject])
    expect(rows(h, `SELECT clef_junk FROM message WHERE direction = 'in'`)).toEqual([{ clef_junk: null }])
    expect(await heard(h, device)).toHaveLength(1)
  })
})

describe('mail that is spam', () => {
  test.each(JUNK.map((m) => [m.id, m] as const))(
    '%s, judged a pitch, is Bulk and marked Spam, kept, and rings nobody',
    async (_id, m) => {
      const h = checked()
      const device = await turnOn(h)
      h.ai?.next(
        clef(
          0.96,
          m.id === 'crypto' || m.id === 'phishing' || m.id === 'fake-invoice' ? 'scam_phishing' : 'vendor_pitch',
        ),
      )

      expect((await deliver(h, m)).entered).toBe('filed')

      expect(h.ai?.shown().body).toBe(m.body)
      const bulk = await queue(h, 'bulk')
      expect(bulk.map((r) => r.subject)).toEqual([m.subject])
      expect(bulk[0]?.spam).toBe(true)
      expect(await queue(h, 'inbox')).toEqual([])
      expect(await heard(h, device)).toHaveLength(0)
      expect(rows(h, `SELECT notify FROM message WHERE direction = 'in'`)).toEqual([{ notify: null }])
      expect(rows<{ n: number }>(h, `SELECT count(*) AS n FROM message WHERE direction = 'in'`)[0]?.n).toBe(1)
    },
  )

  test('a sender with a List-Unsubscribe header never reaches the model: Bulk by the rule, as before', async () => {
    const h = checked()
    seq += 1
    const m = JUNK[0] as SampleMail
    await h.deliver(
      `${[
        `From: ${m.name} <${m.from}>`,
        `To: ${HELLO}`,
        `Subject: ${m.subject}`,
        `Message-ID: <rcs${seq}@example.net>`,
        'List-Unsubscribe: <https://example.net/u>',
        '',
        m.body,
      ].join('\r\n')}\r\n`,
      { from: m.from, to: HELLO },
    )
    expect(h.ai?.calls).toHaveLength(0)
    expect((await queue(h, 'bulk')).map((r) => r.subject)).toEqual([m.subject])
  })
})
