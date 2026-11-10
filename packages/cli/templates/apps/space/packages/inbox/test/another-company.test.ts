import { describe, expect, test } from 'bun:test'
import { createInstall } from '@space/workspace'
import { buildChatRequest } from '../src/assistant/prompt'
import { parseDeclared } from '../src/cloudflare/declared'
import { reasonLines } from '../src/cloudflare/spam-check'
import { parseJmapDeclared } from '../src/jmap/declared'
import { inboxPeople } from '../src/live'
import { inboxOwnerOf } from '../src/owner'
import * as words from '../src/owner-words'
import { roleFor } from '../src/workspace'
import { personaFor } from '../test-support/content'
import { AGENT_ID, asker, harness } from '../test-support/harness'

/**
 * The owner is the install's: the same sentences and the same sender name, on a company that is not Northfield Works. The suites that pin Northfield's words (owner-words.test.ts, and every
 * suite that runs on Northfield's declaration) hold them for Northfield Works; this one runs the rules that name the owner on an invented company and proves "Tessa" and "tessa@northfield.example"
 * are nowhere in what the inbox says or sends there, that its owner is the one the inbox admits, and that Northfield's owner is nobody.
 */

const BRIGHTWATER = createInstall({
  company: {
    id: 'brightwater',
    name: 'Brightwater Marine Services',
    domain: 'brightwater.example',
    timeZone: 'America/Los_Angeles',
  },
  access: { teamDomain: 'brightwater.cloudflareaccess.com' },
  formsService: { contact: 'help@example.test' },
  space: { host: 'space.brightwater.example', sessionDuration: '730h' },
  people: [
    {
      address: 'priya@brightwater.example',
      name: 'Priya',
      mailName: 'Priya Raman',
      signIn: 'priya.private@mail.example',
      role: 'owner',
    },
    { address: 'omar@brightwater.example', name: 'Omar', role: 'owner' },
    { address: 'dana@brightwater.example', name: 'Dana', role: 'member' },
  ],
})

const PRIYA = 'priya@brightwater.example'
const AGENT_ACTOR = `agent:${AGENT_ID}`
const WORDS = 'Thanks. Tuesday works for me.'
const SAID = { text: 'send it', where: 'session main', at: '2026-10-20T12:04:00Z' }
/** Nothing of Northfield's, and nobody of Northfield's, may be in what an invented company's inbox says. */
const NORTHFIELD = /tessa|northfield/i

type H = ReturnType<typeof harness>
const brightwater = () => {
  const h = harness({}, { install: BRIGHTWATER })
  h.google.mailbox.address = PRIYA
  return h
}

async function live(h: H) {
  h.google.mailbox.add({
    id: 'm1',
    threadId: 't1',
    subject: 'Quote for the dock',
    from: 'Sam Ortiz <sam@harbor.example>',
    to: 'Priya Raman <priya@brightwater.example>',
  })
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
}

const convoId = (h: H, threadId: string): string =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(threadId) as { id: string }).id

/** A reply draft on t1 by `actor`, with the revision and how far it reached, as a press or Claude's script gives them. */
async function draftFor(h: H, actor: string) {
  const made = (await h.store.call(
    'createDraft',
    {
      conversationId: convoId(h, 't1'),
      body: WORDS,
      subject: 'Re: Quote for the dock',
      why: 'He asked for a time.',
    } as never,
    actor,
  )) as { ok: true; value: { id: string; rev: number } }
  expect(made.ok, JSON.stringify(made)).toBe(true)
  const read = (await h.store.call('getConversation', convoId(h, 't1'))) as { ok: true; value: { through: number } }
  return { id: made.value.id, rev: made.value.rev, through: read.value.through }
}

const refusal = (r: unknown): string => {
  const result = r as { ok: boolean; error?: string }
  expect(result.ok).toBe(false)
  return String(result.error)
}

describe('the owner is the install’s', () => {
  test('is the first owner the declaration lists, mailed under the name it gives them', () => {
    expect(inboxOwnerOf(BRIGHTWATER)).toEqual({
      email: PRIYA,
      name: 'Priya',
      mailName: 'Priya Raman',
      domain: 'brightwater.example',
      company: 'Brightwater Marine Services',
      mailboxNames: [],
      spaceOrigin: 'https://space.brightwater.example',
      team: [PRIYA, 'omar@brightwater.example', 'dana@brightwater.example'],
    })
    // A person with no mail name is mailed under their name.
    expect(
      inboxOwnerOf(
        createInstall({
          ...BRIGHTWATER.declaration,
          people: [{ address: 'omar@brightwater.example', name: 'Omar', role: 'owner' }],
        }),
      ).mailName,
    ).toBe('Omar')
  })

  test('the inbox admits that owner by their sign-in address and nobody else: not Northfield’s, not a second owner, not a member', () => {
    const env = {}
    const as = (address: string) =>
      roleFor({ kind: 'person', person: BRIGHTWATER.person(address) as never, exp: 0 }, BRIGHTWATER, env)
    expect(as(PRIYA)).toEqual({ role: 'owner', actor: PRIYA })
    expect(as('omar@brightwater.example')).toBeNull()
    expect(as('dana@brightwater.example')).toBeNull()
    // Every person of the install is told that mail moved (a ping that names nothing); which mail each may see is the inbox's own rule, src/queue.ts.
    expect(inboxPeople(BRIGHTWATER)).toEqual([PRIYA, 'omar@brightwater.example', 'dana@brightwater.example'])
  })

  test('the space’s part answers the owner and refuses Northfield’s Tessa, whom the install does not know', async () => {
    const h = brightwater()
    const space = h.space()
    const owner = await space.claudeSending(asker({ email: PRIYA }, BRIGHTWATER))
    expect(owner, JSON.stringify(owner)).toMatchObject({ ok: true })
    for (const who of ['omar@brightwater.example', 'dana@brightwater.example', 'tessa@northfield.example']) {
      const r = await space.claudeSending(asker({ email: who }, BRIGHTWATER))
      expect(r, who).toMatchObject({ ok: false })
    }
  })

  test('the store’s owner-only acts admit the declared owner’s address, not Northfield’s', () => {
    const h = brightwater()
    expect(h.inbox.setClaudeSending(true, PRIYA)).toMatchObject({ ok: true })
    expect(h.inbox.setClaudeSending(false, 'tessa@northfield.example')).toMatchObject({ ok: false, status: 403 })
  })

  test('a Cloudflare mailbox may not be the owner’s Gmail address, and Northfield’s address is just an address here', () => {
    expect(parseDeclared([{ address: PRIYA, name: 'Priya' }], PRIYA)).toEqual({
      ok: false,
      error: `${PRIYA} is the Gmail mailbox; it is not declared here.`,
    })
    expect(parseDeclared([{ address: 'tessa@northfield.example', name: 'Somebody' }], PRIYA)).toMatchObject({
      ok: true,
    })
    expect(
      parseJmapDeclared([{ address: PRIYA, name: 'x', door: 'https://m.example', secret: 'S_X_Y' }], PRIYA),
    ).toEqual({
      ok: false,
      error: `${PRIYA} is the Gmail mailbox; it is not declared here.`,
    })
  })
})

describe('what the inbox says about its owner, on another company’s install', () => {
  test('every sentence names the owner the install has and nothing of Northfield’s', () => {
    const named = Object.entries(words).map(([name, say]) => {
      const sentence = (say as (owner: string, other?: string | number | string[]) => string)(
        'Priya',
        name === 'instructionOnlyFromOwnerInSession' ? PRIYA : name === 'filesFromBusinessMailboxOnly' ? [] : 2000,
      )
      return { name, sentence }
    })
    expect(named.length).toBeGreaterThan(20)
    for (const { name, sentence } of named) {
      expect(sentence, name).not.toMatch(NORTHFIELD)
      expect(sentence, name).toContain('Priya')
    }
    expect(words.claudeSendingOff('Priya')).toBe(
      'Claude’s sending is switched off in the inbox, so nothing was sent. The draft is still waiting for Priya. Only Priya can switch it on.',
    )
    expect(words.instructionOnlyFromOwnerInSession('Priya', PRIYA)).toContain(`even one from ${PRIYA}`)
  })

  test('the sentence about files names the install’s own business mailboxes, in its order, and none when it has none', () => {
    expect(words.filesFromBusinessMailboxOnly('Priya', [])).toBe(
      'Files can be sent from a business mailbox only, not from Priya’s Gmail. Nothing was sent.',
    )
    expect(words.filesFromBusinessMailboxOnly('Priya', ['Brightwater'])).toBe(
      'Files can be sent from a business mailbox only (Brightwater’s), not from Priya’s Gmail. Nothing was sent.',
    )
    expect(words.filesFromBusinessMailboxOnly('Priya', ['Brightwater', 'Harbor'])).toBe(
      'Files can be sent from a business mailbox only (Brightwater’s or Harbor’s), not from Priya’s Gmail. Nothing was sent.',
    )
    expect(inboxOwnerOf(BRIGHTWATER).mailboxNames).toEqual([])
  })

  test('Claude’s send is refused in the owner’s name: off, then with no instruction, then an instruction given before a reply, and the owner is told nothing of Tessa', async () => {
    const h = brightwater()
    await live(h)
    const draft = await draftFor(h, AGENT_ACTOR)

    const off = refusal(
      await h.store.call(
        'sendDraft',
        draft.id,
        { rev: draft.rev, through: draft.through, instruction: SAID } as never,
        AGENT_ACTOR,
      ),
    )
    expect(off).toContain('Only Priya can switch it on')
    expect(off).not.toMatch(NORTHFIELD)

    // Only the owner flips the switch, and a refusal names who can.
    expect(refusal(h.inbox.setClaudeSending(true, 'someone@else.example'))).toBe(
      'Only Priya can switch Claude’s sending on or off.',
    )
    expect(h.inbox.setClaudeSending(true, PRIYA)).toMatchObject({ ok: true })

    const none = refusal(
      await h.store.call('sendDraft', draft.id, { rev: draft.rev, through: draft.through } as never, AGENT_ACTOR),
    )
    expect(none).toBe(words.noInstruction('Priya'))

    const inbox = refusal(
      await h.store.call(
        'sendDraft',
        draft.id,
        { rev: draft.rev, through: draft.through, instruction: { ...SAID, where: 'the inbox' } } as never,
        AGENT_ACTOR,
      ),
    )
    expect(inbox).toBe(words.instructionOnlyFromOwnerInSession('Priya', PRIYA))
    for (const text of [none, inbox]) expect(text).not.toMatch(NORTHFIELD)

    // Somebody who is neither a person of the install nor Claude cannot send.
    expect(
      refusal(
        await h.store.call(
          'sendDraft',
          draft.id,
          { rev: draft.rev, through: draft.through } as never,
          'stranger@example.com',
        ),
      ),
    ).toBe('Only Priya sends, and Claude on his instruction.')
  })

  test('the owner’s send goes out under the mail name the declaration gives them, with a Message-ID on their own domain', async () => {
    const h = brightwater()
    await live(h)
    const draft = await draftFor(h, PRIYA)
    const sent = await h.store.call('sendDraft', draft.id, { rev: draft.rev, through: draft.through } as never, PRIYA)
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true })
    const out = h.google.mailbox.sent[0]
    expect(out?.headers).toMatchObject({ From: `Priya Raman <${PRIYA}>` })
    expect(String(out?.headers['Message-ID'])).toMatch(/@brightwater\.example>$/)
    expect(JSON.stringify(out)).not.toMatch(NORTHFIELD)
    const filed = h.db.query(`SELECT from_header, sent_by FROM message WHERE id = ?`).get(draft.id)
    expect(filed).toEqual({ from_header: `Priya Raman <${PRIYA}>`, sent_by: PRIYA })
  })

  test('the owner connects Gmail, and a refusal of anybody else says whose it is', async () => {
    const h = brightwater()
    expect(
      refusal(
        await h.mailroom.connectMailbox('good-code', 'dana@brightwater.example', 'https://space.brightwater.example/x'),
      ),
    ).toBe('Only Priya connects or disconnects a Gmail account.')
    expect(await h.connect()).toMatchObject({ ok: true })
  })

  test('the spam call, the notification, the chat and the restore refusals name the owner', async () => {
    const h = brightwater()
    await live(h)
    const conversation = convoId(h, 't1')
    expect(refusal(h.inbox.setSpam(conversation, true, 'stranger@example.com'))).toBe(
      'Only Priya, or Claude in a session, can call a conversation spam or not.',
    )
    expect(refusal(await h.store.call('notificationSettings', AGENT_ACTOR))).toBe(words.onlyOwnerNotifications('Priya'))
    expect(refusal(await h.store.call('prepareRestore', { bookmark: 'x' } as never, 'dana@brightwater.example'))).toBe(
      'Only Priya can restore the inbox’s store.',
    )
    expect(refusal(await h.store.call('setAssistant', 'no-box', true, 'dana@brightwater.example'))).toBe(
      'Only Priya can switch the spam check on or off.',
    )
    expect(
      refusal(await h.store.call('chat', conversation, { instruction: 'shorter' } as never, 'stranger@example.com')),
    ).toBe('Only Priya chats with the assistant about a draft.')
  })

  test('a draft from Claude with no why says who it is for', async () => {
    const h = brightwater()
    await live(h)
    const r = await h.store.call('createDraft', { conversationId: convoId(h, 't1'), body: WORDS } as never, AGENT_ACTOR)
    expect(refusal(r)).toBe('A draft from an agent needs a one-line why, so Priya knows what it is for.')
  })

  test('the reason a conversation is in Bulk says who moved it', () => {
    const lines = reasonLines(
      {
        clientIds: [],
        spamCall: { spam: true, by: 'owner' },
        newest: { listUnsubscribe: false, automated: null, clef: null },
      },
      'Priya',
    )
    expect(lines).toEqual(['Priya moved it to Bulk.'])
  })

  test('the assistant’s prompt calls the operator by the owner’s name, and writes nobody a persona it was not given', () => {
    // The owner's own Gmail has no persona here: Northfield's is Northfield's content, keyed by its own address.
    expect(personaFor(PRIYA)).toBeNull()
    const persona = { role: 'the reply assistant for Brightwater', signature: 'Brightwater', us: 'hello@ (us)' }
    const base = {
      mailboxAddress: 'hello@brightwater.example',
      persona,
      subject: 'Hi',
      participant: { address: 'a@x.test', name: 'A' },
      thread: [],
      draft: '',
      history: [],
      instruction: 'Write a reply',
      ownerName: 'Priya',
    }
    const without = buildChatRequest({ ...base, knowledge: null })
    expect(without.system).toContain('the operator (Priya)')
    expect(without.system).toContain("on Priya's behalf")
    const request = buildChatRequest({ ...base, knowledge: [] })
    expect(request.system).toContain('the operator (Priya)')
    for (const r of [without, request]) expect(JSON.stringify(r)).not.toMatch(NORTHFIELD)
  })
})
