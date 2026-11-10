// What a person sees on Today, drawn from the answer the Worker gives the page. The answers are made by the real `today()` over stand-in apps (not
// written by hand), so a change to the sections shows here as what changed on screen. Links are asserted as the addresses a person's click goes to.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DocumentSummary, MeetLiveCall } from '@space/workspace'
import { T0, northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { TodayScreen, type TodayProps } from '../src/client/Today'
import { callHref, clockIn, documentPath, noticesFor, outLine, peopleWords, summaryLine } from '../src/client/day'
import { agoWords } from '../src/client/format'
import { inboxPath, meetPath } from '../src/client/route'
import { type StandInContact, type StandInDraft, type StandInThread, standInForms, standInInbox, standInMeet } from '../src/stand-ins'
import { type Meeting, type TodayAnswer } from '../src/today-shape'
import { today } from '../src/today'
import { ago, contact, dm, person, thread } from './world'
import { OWNER_SIGNED_IN } from './signed-in'

const install = northfield()
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, install)
const MIN = 60_000

const doc = (id: string, title: string, state: DocumentSummary['state'], over: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id,
  title,
  state,
  createdAt: T0 - 3 * 24 * 60 * MIN,
  sentAt: state === 'draft' ? null : T0 - 3 * 24 * 60 * MIN,
  completedAt: null,
  signers: 1,
  signed: 0,
  notSigned: [],
  ...over,
})

interface Given {
  contacts?: StandInContact[]
  threads?: StandInThread[]
  drafts?: StandInDraft[]
  direct?: Parameters<typeof standInMeet>[0]['direct']
  calls?: MeetLiveCall[]
  documents?: DocumentSummary[]
  down?: ('mail' | 'chat' | 'documents')[]
  refuse?: 'chat' | 'mail'
}

async function answerFor(given: Given = {}): Promise<TodayAnswer> {
  const inbox = standInInbox(given.contacts ?? [], given.threads ?? [], { drafts: given.drafts })
  const meet = standInMeet({ direct: given.direct ?? [], channels: [] }, { calls: given.calls })
  const forms = standInForms(given.documents ?? [])
  const boom = async () => {
    throw new Error('down')
  }
  if (given.down?.includes('mail')) {
    inbox.people = boom
    inbox.drafts = boom
  }
  if (given.down?.includes('chat')) {
    meet.conversations = boom
    meet.liveCalls = boom
  }
  if (given.down?.includes('documents')) forms.documents = boom
  if (given.refuse === 'mail') {
    inbox.people = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'This is not open to you.' })
    inbox.drafts = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'This is not open to you.' })
  }
  if (given.refuse === 'chat') {
    meet.conversations = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'This is not open to you.' })
    meet.liveCalls = async () => ({ ok: false, kind: 'refused', reason: 'not-admitted', message: 'This is not open to you.' })
  }
  return today({ apps: { inbox, meet, forms }, install, signedIn: OWNER_SIGNED_IN, self: ['tessa@northfield.example'], answerWithinMs: 50, now: () => T0 })
}

const screen = (answer: TodayAnswer | null, over: Partial<TodayProps> = {}) =>
  renderToStaticMarkup(<TodayScreen me={ME} now={T0} answer={answer} loading={false} problem={null} go={() => undefined} {...over} />)

/** The rows of one section, as {href, text, ...}. */
function section(html: string, id: string) {
  const sec = new RegExp(`<section class="tsec" data-section="${id}".*?</section>`, 's').exec(html)?.[0] ?? ''
  return [...sec.matchAll(/<a class="trow"[^>]*href="([^"]+)"[^>]*data-testid="([^"]+)"[^>]*>(.*?)<\/a>/gs)].map((m) => ({
    href: (m[1] as string).replace(/&amp;/g, '&'),
    kind: m[2] as string,
    text: (m[3] as string).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    html: m[0] as string,
  }))
}

const dana = contact('c-dana', 'Dana Reyes', 'dana@harbor.example')
const busy: Given = {
  contacts: [{ ...dana, client: { id: 7, name: 'Harbor Dental' } }],
  threads: [thread('t1', ago(14), ['c-dana'], { subject: 'Re: Homepage copy', snippet: 'Can the hours say Saturdays until two?', direction: 'in', unread: true })],
  drafts: [{ id: 'd1', conversationId: 't1', contactId: 'c-dana', subject: 'Re: Homepage copy', text: 'Yes.', author: 'claude', at: ago(10) }],
  direct: [dm(11, person('p-pri', 'Priya Natarajan', 'priya@northfield.example', 'teammate'), ago(3), 2, 'Staging is up')],
  calls: [{ name: 'k7m2qx9frtn4w6hbc8jd', startedAt: T0 - 18 * MIN, present: 2, why: 'started' }],
  documents: [
    doc('e-draft', 'Website agreement', 'draft', { notSigned: ['Rosa Whitfield'], createdAt: T0 - 60 * MIN }),
    doc('e-out', 'Photo release', 'sent', { signers: 2, signed: 0, notSigned: ['Dana Reyes', 'Marcus Chen'], sentAt: T0 - 5 * 60 * MIN }),
    doc('e-back', 'Hosting renewal', 'completed', { signers: 2, signed: 2, completedAt: T0 - 70 * MIN }),
  ],
}

describe('the sections, in the order Tessa sees them', () => {
  test('Happening now, Waiting on you, Drafts not sent, Waiting on others, Signed and back, then the meetings line', async () => {
    const html = screen(await answerFor(busy))
    const order = [...html.matchAll(/data-section="([a-z-]+)"/g)].map((m) => m[1])
    expect(order).toEqual(['now', 'waiting-on-you', 'drafts', 'waiting-on-others', 'signed-back', 'meetings'])
  })

  test('a call in progress is a row that says how many are in it and joins on the space’s address (a path that needs no sign-in), in a tab of its own', async () => {
    const html = screen(await answerFor(busy))
    const [call] = section(html, 'now')
    expect(call?.href).toBe('https://space.northfield.example/r/k7m2qx9frtn4w6hbc8jd')
    expect(call?.html).toContain('target="_blank"')
    expect(call?.html).toContain('rel="noopener"')
    expect(call?.text).toContain('Call in progress')
    expect(call?.text).toContain('2 people are in it')
    expect(call?.text).toContain('made 18 minutes ago')
    expect(call?.text).toContain('Join')
    // The space's own address, on the /r/ prefix that needs no sign-in (a guest can open it), and never meet's old host.
    expect(call?.href).toMatch(/^https:\/\/space\.northfield\.example\/r\//)
    expect(call?.href).not.toContain('meet.northfield.example')
  })

  test('mail waiting on you opens its conversation, names the person and their business, the subject and the last words, and says it needs a reply and is unread', async () => {
    const html = screen(await answerFor(busy))
    const rows = section(html, 'waiting-on-you')
    const mail = rows.find((r) => r.kind === 'waiting-mail')
    expect(mail?.href).toBe(inboxPath('dana@harbor.example'))
    expect(mail?.text).toContain('Dana Reyes')
    expect(mail?.text).toContain('Harbor Dental')
    expect(mail?.text).toContain('Re: Homepage copy Can the hours say Saturdays until two?')
    expect(mail?.text).toContain('Can the hours say Saturdays until two?')
    expect(mail?.text).toContain('Needs reply')
    expect(mail?.text).toContain('Unread')
    expect(mail?.text).toContain('14m')
    const chat = rows.find((r) => r.kind === 'waiting-chat')
    expect(chat?.href).toBe(meetPath('priya@northfield.example'))
    expect(chat?.text).toContain('Priya Natarajan')
    expect(chat?.text).toContain('2 new')
  })

  test('an email draft says who it is to and who wrote it; a draft document opens in Forms and says who it is for', async () => {
    const rows = section(screen(await answerFor(busy)), 'drafts')
    const email = rows.find((r) => r.kind === 'draft-email')
    expect(email?.href).toBe(inboxPath('dana@harbor.example'))
    expect(email?.text).toContain('Reply to Dana Reyes')
    expect(email?.text).toContain('Suggested by Claude')
    const document = rows.find((r) => r.kind === 'draft-document')
    expect(document?.href).toBe('/forms/envelopes/e-draft')
    expect(document?.text).toContain('Website agreement')
    expect(document?.text).toContain('For Rosa Whitfield, not sent')
  })

  test('a document waiting on others says who has not signed, how long ago it went out and how many have; a signed one says it is back', async () => {
    const html = screen(await answerFor(busy))
    const [out] = section(html, 'waiting-on-others')
    expect(out?.href).toBe(documentPath('e-out'))
    expect(out?.text).toContain('Photo release')
    expect(out?.text).toContain('Dana Reyes and Marcus Chen have not signed, sent 5 hours ago')
    expect(out?.text).toContain('0 of 2 signed')
    const [back] = section(html, 'signed-back')
    expect(back?.href).toBe(documentPath('e-back'))
    expect(back?.text).toContain('Signed by all 2, back 1 hour ago')
    expect(back?.text).toContain('Signed')
  })

  test('a signed document sent from a conversation opens that conversation, in the page; with no conversation to find it opens in Forms', async () => {
    const from = { ...busy, documents: [doc('e-back', 'Hosting renewal', 'completed', { signers: 2, signed: 2, completedAt: T0 - 70 * MIN, conversation: { app: 'inbox' as const, id: 'c-dana' } }), doc('e-forms', 'Terms update', 'completed', { completedAt: T0 - 80 * MIN })] }
    const html = screen(await answerFor(from))
    const rows = section(html, 'signed-back')
    expect(rows.map((r) => r.href)).toEqual(['/inbox/dana%40harbor.example', documentPath('e-forms')])
    expect(rows[0]!.html).toContain('data-where="Inbox"')
    expect(rows[1]!.html).toContain('data-where="Forms"')
  })

  test('a document is opened in Forms inside the space, never on forms.northfield.example, and by a full load (forms asks again for its own sign-in)', async () => {
    const html = screen(await answerFor(busy))
    for (const id of ['waiting-on-others', 'signed-back', 'drafts']) {
      for (const row of section(html, id).filter((r) => r.href.startsWith('/forms'))) {
        expect(row.href).not.toContain('forms.northfield.example')
        expect(row.html).not.toContain('onclick')
      }
    }
    expect(html).not.toContain('forms.northfield.example')
  })

  test('Waiting on you says what it leaves out by the tab it is in, each linking there; a tab with none left is not named', async () => {
    const a = await answerFor(busy)
    const more = (left: { inbox: number; meet: number }) => screen({ ...a, waitingOnYou: { ...a.waitingOnYou, total: a.waitingOnYou.rows.length + left.inbox + left.meet }, waitingOnYouLeft: left })
    const both = /<section class="tsec" data-section="waiting-on-you".*?<\/section>/s.exec(more({ inbox: 3, meet: 2 }))?.[0] ?? ''
    expect(both).toContain('<a href="/inbox">3 more in Inbox</a>')
    expect(both).toContain('<a href="/meet">2 more in Meet</a>')
    const onlyMeet = /<section class="tsec" data-section="waiting-on-you".*?<\/section>/s.exec(more({ inbox: 0, meet: 2 }))?.[0] ?? ''
    expect(onlyMeet).toContain('2 more in Meet')
    expect(onlyMeet).not.toContain('more in Inbox')
    expect(/<section class="tsec" data-section="waiting-on-you".*?<\/section>/s.exec(more({ inbox: 0, meet: 0 }))?.[0]).not.toContain('data-testid="more"')
  })

  test('each row says where it goes: Inbox, Forms or Meet', async () => {
    const html = screen(await answerFor(busy))
    expect([...html.matchAll(/data-where="([A-Za-z]+)"/g)].map((m) => m[1]).sort()).toEqual(['Forms', 'Forms', 'Forms', 'Inbox', 'Inbox', 'Meet', 'Meet'])
  })
})

describe('the summary line, and what it never claims', () => {
  test('counts what is waiting, and nothing needs you only when every part answered and there is nothing', async () => {
    expect(summaryLine(await answerFor(busy))).toBe('1 call in progress, 2 waiting on you, 2 drafts not sent, 1 waiting on others.')
    expect(summaryLine(await answerFor())).toBe('Nothing needs you right now.')
    expect(screen(await answerFor())).toContain('Nothing needs you right now.')
  })

  test('a part that did not answer leaves "nothing needs you" unsaid, with or without rows from the others', async () => {
    const empty = await answerFor({ down: ['mail'] })
    expect(summaryLine(empty)).toBe('Nothing to show from the parts that answered.')
    expect(summaryLine(empty)).not.toContain('Nothing needs you')
    const some = await answerFor({ ...busy, down: ['documents'] })
    expect(summaryLine(some)).toContain('Some of it could not be reached.')
  })

  test('a part that says no is not trouble: a teammate the inbox does not admit still gets "Nothing needs you", beside the quiet line that says why', async () => {
    const a = await answerFor({ refuse: 'mail' })
    expect(a.sources.filter((x) => x.part === 'mail').every((x) => x.state === 'not-open-to-you')).toBe(true)
    expect(summaryLine(a)).toBe('Nothing needs you right now.')
    const html = screen(a)
    expect(html).toContain('Nothing needs you right now.')
    expect(html).toContain('Email is not open to you, so mail waiting on you and email drafts are not on Today.')
    expect(html).toContain('data-notice="refused"')
    expect(html).not.toContain('Some of it could not be reached')
    // With what the other parts hold, the line counts that and still does not call the refusal a part that could not be reached.
    expect(summaryLine(await answerFor({ ...busy, refuse: 'mail' }))).toBe('1 call in progress, 1 waiting on you, 1 draft not sent, 1 waiting on others.')
  })

  test('before the answer has come it says it is loading, and not that nothing needs you', () => {
    const html = screen(null, { loading: true })
    expect(html).toContain('data-testid="loading"')
    expect(html).not.toContain('Nothing needs you')
  })
})

describe('a part that did not answer', () => {
  test('forms down: its sections are not on the page, the line says what is missing, and the rest is', async () => {
    const html = screen(await answerFor({ ...busy, down: ['documents'] }))
    expect(html).toContain('Forms could not be reached just now, so Today is missing documents. It will be tried again.')
    expect(html).toContain('data-notice="unreachable"')
    expect(html).not.toContain('data-section="waiting-on-others"')
    expect(html).not.toContain('data-section="signed-back"')
    expect(html).toContain('data-section="waiting-on-you"')
    expect(html).toContain('data-section="now"')
  })

  test('the inbox down: mail waiting on you and email drafts are missing, chat and documents are not', async () => {
    const html = screen(await answerFor({ ...busy, down: ['mail'] }))
    expect(html).toContain('Email could not be reached just now, so Today is missing mail waiting on you and email drafts.')
    expect(section(html, 'waiting-on-you').map((r) => r.kind)).toEqual(['waiting-chat'])
    expect(section(html, 'drafts').map((r) => r.kind)).toEqual(['draft-document'])
  })

  test('meet saying no is a quiet line, not a warning, and says what is not on Today', async () => {
    const html = screen(await answerFor({ ...busy, refuse: 'chat' }))
    expect(html).toContain('data-notice="refused"')
    expect(html).toContain('Chat is not open to you, so direct messages waiting on you and calls in progress are not on Today.')
    expect(html).not.toContain('data-section="now"')
  })

  test('one read of a part failing names only what it gives', () => {
    const base = { part: 'documents' as const }
    const notices = noticesFor([
      { source: 'unsent', ...base, state: 'ok' },
      { source: 'out', ...base, state: 'could-not-be-reached', reason: 'timed-out' },
      { source: 'back', ...base, state: 'ok' },
    ])
    expect(notices.map((n) => n.text)).toEqual(['Forms took too long to answer just now, so Today is missing documents waiting on others. It will be tried again.'])
  })

  test('the page could not reach the space at all: it says so and keeps the last Today it had', async () => {
    const answer = await answerFor(busy)
    expect(screen(answer, { problem: 'network' })).toContain('This is the last Today it had.')
    expect(screen(null, { problem: 'network' })).toContain('It will be tried again.')
    expect(screen(null, { problem: 'signin' })).toContain('data-notice="signin"')
  })
})

describe('meetings: Later today and Tomorrow', () => {
  const answerWith = async (meetings: Meeting[]): Promise<TodayAnswer> => {
    const a = await answerFor()
    // Today there runs to 08:00 UTC the next day (midnight in Los Angeles); what is after that is tomorrow.
    return { ...a, meetingsListed: true, laterToday: meetings.filter((m) => m.startsAt < Date.UTC(2026, 10, 2, 8)), tomorrow: meetings.filter((m) => m.startsAt >= Date.UTC(2026, 10, 2, 8)) }
  }

  test('where meet did not list them, one line says meetings are not listed, rather than that there are none', async () => {
    const html = screen({ ...(await answerFor(busy)), meetingsListed: false })
    expect(html).toContain('data-testid="no-meetings"')
    expect(html).toContain('Meetings with a time are not listed yet.')
    expect(html).not.toContain('No meetings')
  })

  test('once something lists them, a meeting is a row at its time on the company’s clock, under the day it is on, opening its conversation', async () => {
    const meetings: Meeting[] = [
      { id: 'm1', title: 'Homepage walkthrough with Dana', startsAt: Date.UTC(2026, 10, 1, 22, 30), conversation: 'dana@harbor.example' },
      { id: 'm2', title: 'Hosting review', startsAt: Date.UTC(2026, 10, 2, 17, 0) },
    ]
    const html = screen(await answerWith(meetings))
    const later = section(html, 'later')
    expect(later).toHaveLength(1)
    expect(later[0]?.text).toContain('Homepage walkthrough with Dana')
    // 22:30 UTC is 14:30 in Los Angeles on the morning the clocks went back: standard time.
    expect(later[0]?.text).toContain('2:30 PM PST')
    expect(later[0]?.href).toBe(inboxPath('dana@harbor.example'))
    const tomorrow = section(html, 'tomorrow')
    expect(tomorrow[0]?.text).toContain('Hosting review')
    expect(tomorrow[0]?.text).toContain('9:00 AM PST')
    expect(tomorrow[0]?.href).toBe('/meet?view=calls')
    expect(html).not.toContain('data-testid="no-meetings"')
  })

  test('listed and none today or tomorrow: it says there are none', async () => {
    const html = screen(await answerWith([]))
    expect(html).toContain('No meetings with a time today or tomorrow.')
  })
})

describe('the words', () => {
  test('times in words, and who has not signed', () => {
    expect([30_000, 5 * MIN, 61 * MIN, 5 * 60 * MIN, 30 * 60 * MIN, 3 * 24 * 60 * MIN].map((d) => agoWords(T0, T0 - d))).toEqual(['just now', '5 minutes ago', '1 hour ago', '5 hours ago', 'yesterday', '3 days ago'])
    expect(peopleWords(['A'])).toBe('A')
    expect(peopleWords(['A', 'B'])).toBe('A and B')
    expect(peopleWords(['A', 'B', 'C', 'D'])).toBe('A, B and 2 others')
    expect(outLine({ id: 'x', title: 't', state: 'sent', at: T0 - 5 * 60 * MIN, signers: 1, signed: 0, notSigned: ['Dana'] }, T0)).toBe('Dana has not signed, sent 5 hours ago')
    expect(outLine({ id: 'x', title: 't', state: 'sealing', at: T0, signers: 1, signed: 1, notSigned: [] }, T0)).toContain('Everyone has signed')
  })

  test('a call’s link is the space’s address and the call’s name, however the address is written', () => {
    expect(ME.origin).toBe('https://space.northfield.example/') // where Me says calls are made and joined: the space's own address, whose /r/ needs no sign-in
    expect(callHref(ME.origin, 'abc')).toBe('https://space.northfield.example/r/abc')
    expect(callHref('https://space.northfield.example', 'abc')).toBe('https://space.northfield.example/r/abc')
  })

  test('a time is read on the company’s clock, not the viewer’s', () => {
    expect(clockIn('America/Los_Angeles', Date.UTC(2026, 6, 1, 21, 0))).toBe('2:00 PM PDT')
    expect(clockIn('Asia/Tokyo', Date.UTC(2026, 6, 1, 21, 0))).toBe('6:00 AM GMT+9')
  })
})
