import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createInstall } from '@space/workspace'
import { NORTHFIELD_CONTENT } from '@space/workspace/northfield'
import { MailboxContentError, readMailboxContent } from '../src/mailbox-content'
import { bundledContent, bundledInstall } from '../src/workspace'
import { clef } from '../test-support/fake-ai'
import { FakeKnowledge } from '../test-support/fake-knowledge'
import { harness } from '../test-support/harness'

/**
 * The mailboxes' personas and spam questions are the install's content: a file beside the declaration, read per mailbox. Here the bundled install's are read by address, the file's rules are tested as a
 * table, and a second company shows the rule that a mailbox with nothing written gets no assistant and no spam check, and that the spam check does not depend on the assistant switch.
 */

const RIDGEWAY = 'info@ridgewaycycles.example'
const SHIFTLANTERN = 'hello@shiftlantern.example'
const TESSA = 'tessa@northfield.example'
const QUILL = 'hello@quill.example'

describe('the bundled install’s mailbox content is read per mailbox', () => {
  test('its three personas, and none for the mailbox nobody wrote one for', () => {
    for (const address of [RIDGEWAY, SHIFTLANTERN, TESSA]) {
      expect(bundledContent.persona(address), address).toEqual(
        NORTHFIELD_CONTENT.personas[address as keyof typeof NORTHFIELD_CONTENT.personas],
      )
    }
    expect(Object.keys(NORTHFIELD_CONTENT.personas).sort()).toEqual([RIDGEWAY, TESSA, SHIFTLANTERN].sort())
    // A mailbox with none gets none: quill.example's has no persona.
    expect(bundledContent.persona(QUILL)).toBeNull()
  })

  test('its two spam questions, with the kinds Clef chooses from in the order the model is shown them', () => {
    for (const address of [RIDGEWAY, SHIFTLANTERN]) {
      expect(JSON.stringify(bundledContent.spamQuestions(address)), address).toBe(
        JSON.stringify(NORTHFIELD_CONTENT.spamQuestions[address as keyof typeof NORTHFIELD_CONTENT.spamQuestions]),
      )
    }
    expect(Object.keys(NORTHFIELD_CONTENT.spamQuestions).sort()).toEqual([RIDGEWAY, SHIFTLANTERN].sort())
    // ShiftLantern's questions are not Ridgeway's, and quill.example has none: its mail is never put to Clef.
    expect(bundledContent.spamQuestions(SHIFTLANTERN)).not.toEqual(bundledContent.spamQuestions(RIDGEWAY))
    expect(bundledContent.spamQuestions(QUILL)).toBeNull()
    expect(bundledContent.spamQuestions(TESSA)).toBeNull()
  })

  test('an address is read trimmed and lower case, and anything unnamed has nothing', () => {
    expect(bundledContent.persona(' INFO@RidgewayCycles.example ')).toBe(bundledContent.persona(RIDGEWAY))
    expect(bundledContent.spamQuestions('Hello@ShiftLantern.example')).toBe(bundledContent.spamQuestions(SHIFTLANTERN))
    for (const nobody of ['', 'someone@else.test', null, undefined]) {
      expect(bundledContent.persona(nobody)).toBeNull()
      expect(bundledContent.spamQuestions(nobody)).toBeNull()
      expect(bundledContent.hasSpamQuestions(nobody)).toBe(false)
    }
    expect(bundledContent.anySpamQuestions()).toBe(true)
  })

  test('the file agrees with the declaration it sits beside: every persona is a business mailbox, every question set a Cloudflare mailbox, and Ridgeway’s spam check begins on', () => {
    // Read once at the build and the Worker's start; here the same check, run again, so a change to either file that breaks the other fails a test and not only a build.
    const raw = JSON.parse(
      readFileSync(new URL('../../workspace/northfield/workspace-content.json', import.meta.url), 'utf8'),
    )
    expect(() => readMailboxContent(raw, bundledInstall)).not.toThrow()
    expect(Object.keys(raw).sort()).toEqual(['personas', 'spamQuestions'])
    expect(bundledInstall.cloudflareMailbox(RIDGEWAY)?.spamCheck).toBe(true)
  })
})

describe('the content file is checked against the declaration', () => {
  const install = createInstall({
    company: {
      id: 'brightwater',
      name: 'Brightwater Marine Services',
      domain: 'brightwater.example',
      timeZone: 'America/Los_Angeles',
    },
    access: { teamDomain: 'brightwater.cloudflareaccess.com' },
    formsService: { contact: 'help@example.test' },
    space: { host: 'space.brightwater.example', sessionDuration: '730h' },
    people: [{ address: 'priya@brightwater.example', name: 'Priya', role: 'owner' }],
    businesses: [
      { id: 'brightwater', name: 'Brightwater', mailboxes: ['priya@brightwater.example', 'info@brightwater.example'] },
      { id: 'harbor', name: 'Harbor Supply', mailboxes: ['hello@harbor.example'] },
    ],
    cloudflareMailboxes: [
      { address: 'info@brightwater.example', name: 'Brightwater', spamCheck: true },
      { address: 'hello@harbor.example', name: 'Harbor Supply' },
    ],
  })
  const PERSONA = { role: 'the reply assistant for Brightwater', signature: 'Brightwater', us: 'info@ (us)' }
  const QUESTIONS = () => ({
    categories: ['customer', 'vendor_pitch'],
    questions: {
      category: {
        type: 'choice',
        instructions: 'What kind of email is this?',
        criteria: { customer: 'a', vendor_pitch: 'b' },
      },
      junk: { type: 'noul', instructions: 'Is it junk?', criteria: { true: 'yes', false: 'no' } },
    },
  })
  const whole = (): {
    personas: Record<string, Record<string, unknown>>
    spamQuestions: Record<string, ReturnType<typeof QUESTIONS>>
  } => ({
    personas: { 'priya@brightwater.example': PERSONA, 'info@brightwater.example': { ...PERSONA, rules: 'Be brief.' } },
    spamQuestions: { 'info@brightwater.example': QUESTIONS() },
  })
  /** Brightwater's own entry of a table, which the test changes. */
  const mine = <T>(table: Record<string, T>): T => {
    const entry = table['info@brightwater.example']
    if (entry === undefined) throw new Error('the fixture has no entry for info@brightwater.example')
    return entry
  }
  const problems = (raw: unknown): string => {
    try {
      readMailboxContent(raw, install)
    } catch (e) {
      if (e instanceof MailboxContentError) return e.problems.join('\n')
      throw e
    }
    return ''
  }

  test('a whole file reads, and an install with no file has no persona and no question', () => {
    const content = readMailboxContent(whole(), install)
    expect(content.persona('info@brightwater.example')).toEqual({ ...PERSONA, rules: 'Be brief.' })
    expect(content.persona('priya@brightwater.example')).toEqual(PERSONA)
    expect(content.spamQuestions('info@brightwater.example')?.categories).toEqual(['customer', 'vendor_pitch'])
    for (const none of [undefined, {}, { personas: {}, spamQuestions: {} }]) {
      const empty = readMailboxContent(
        none,
        createInstall({
          ...install.declaration,
          cloudflareMailboxes: [{ address: 'info@brightwater.example', name: 'Brightwater' }],
        }),
      )
      expect(empty.persona('info@brightwater.example')).toBeNull()
      expect(empty.anySpamQuestions()).toBe(false)
    }
  })

  test('a persona or questions for an address the declaration does not have is refused, so a typo is a failed build and not an assistant that never speaks', () => {
    const typo = whole()
    typo.personas['info@brightwatr.example'] = PERSONA
    expect(problems(typo)).toContain('personas.info@brightwatr.example: not a mailbox of any business')
    const noBox = whole()
    noBox.spamQuestions['hello@harbor.example'] = QUESTIONS()
    expect(problems(noBox)).toBe('') // a declared Cloudflare mailbox may have questions
    const notCloudflare = whole()
    notCloudflare.spamQuestions['priya@brightwater.example'] = QUESTIONS()
    expect(problems(notCloudflare)).toContain(
      'spamQuestions.priya@brightwater.example: not a Cloudflare mailbox of this install',
    )
    const upper = whole()
    upper.personas['Info@brightwater.example'] = PERSONA
    expect(problems(upper)).toContain('the address is lower case and bare')
  })

  test('a mailbox declared with its spam check on must have questions', () => {
    const raw = whole()
    raw.spamQuestions = {} as never
    expect(problems(raw)).toContain('cloudflareMailboxes: info@brightwater.example declares its spam check on')
  })

  test('a persona is a role, a signature and how a sent message is labelled, and a question set describes exactly the kinds it lists, from the kinds Clef’s reason lines have words for', () => {
    for (const [change, say] of [
      [{ role: '' }, 'personas.info@brightwater.example.role: required'],
      [{ signature: 3 }, 'signature: required'],
      [{ us: undefined }, 'us: required'],
      [{ rules: '  ' }, 'rules: a paragraph, or left out'],
      [{ voice: 'x' }, 'unknown field "voice"'],
    ] as const) {
      const raw = whole()
      Object.assign(mine(raw.personas), change)
      expect(problems(raw), JSON.stringify(change)).toContain(say)
    }
    const unknownKind = whole()
    mine(unknownKind.spamQuestions).categories = ['customer', 'gossip']
    expect(problems(unknownKind)).toContain('"gossip" is not a kind Clef\'s reason lines have words for')
    const mismatch = whole()
    mine(mismatch.spamQuestions).categories = ['customer', 'vendor_pitch', 'scam_phishing']
    expect(problems(mismatch)).toContain('describes exactly the listed categories')
    const twice = whole()
    mine(twice.spamQuestions).categories = ['customer', 'customer']
    expect(problems(twice)).toContain('listed twice')
    const shapeless = whole()
    mine(shapeless.spamQuestions).questions = { junk: {} } as never
    expect(problems(shapeless)).toContain('questions: an object with a category question')
    expect(problems({ personas: [] })).toContain('personas: an object keyed by mailbox address')
    expect(problems({ spam: {} })).toContain('unknown field "spam"')
    expect(problems('nope')).toContain('the content is not an object')
  })
})

/** An invented company with two mailboxes: Brightwater's, with a persona and spam questions, and Harbor Supply's, with neither. */
const brightwater = (assistant: boolean) => {
  const install = createInstall({
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
    ],
    businesses: [
      { id: 'brightwater', name: 'Brightwater', mailboxes: ['info@brightwater.example'] },
      { id: 'harbor', name: 'Harbor Supply', mailboxes: ['hello@harbor.example'] },
    ],
    cloudflareMailboxes: [
      { address: 'info@brightwater.example', name: 'Brightwater', spamCheck: true },
      { address: 'hello@harbor.example', name: 'Harbor Supply' },
    ],
    switches: assistant ? { assistant: true } : {},
  })
  const content = readMailboxContent(
    {
      personas: {
        'info@brightwater.example': {
          role: 'the reply assistant for Brightwater, a marine services company',
          signature: 'Priya\nBrightwater',
          us: 'info@ (us)',
        },
      },
      spamQuestions: {
        'info@brightwater.example': {
          categories: ['customer', 'vendor_pitch'],
          questions: {
            category: {
              type: 'choice',
              instructions: 'Brightwater: what kind of email is this?',
              criteria: { customer: 'a boat owner', vendor_pitch: 'a seller' },
            },
            junk: {
              type: 'noul',
              instructions: 'Brightwater: is it junk?',
              criteria: { true: 'selling', false: 'a boat owner' },
            },
          },
        },
      },
    },
    install,
  )
  const h = harness(
    {},
    {
      install,
      content,
      knowledge: new FakeKnowledge(
        [],
        install.businesses().map((b) => ({ id: b.id, name: b.name })),
      ),
      mailboxes: [
        { address: 'info@brightwater.example', name: 'Brightwater', assistant: true },
        { address: 'hello@harbor.example', name: 'Harbor Supply', assistant: true },
      ],
    },
  )
  return h
}

const mail = (to: string, id: string) => ({
  raw: [
    `From: Sam Ortiz <sam@shipyard.example>`,
    `To: ${to}`,
    'Subject: Quote for the dock',
    `Message-ID: <${id}@shipyard.example>`,
    'Date: Tue, 20 Oct 2026 12:00:00 +0000',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Can you quote a new dock?',
  ].join('\r\n'),
  to,
})

const conversationIn = (h: ReturnType<typeof brightwater>, address: string): string =>
  (
    h.db
      .query(`SELECT c.id FROM conversation c JOIN mailbox m ON m.id = c.mailbox_id WHERE m.address = ?`)
      .get(address) as { id: string }
  ).id

describe('a mailbox with nothing written gets no assistant and no spam check, as today', () => {
  test('the spam check asks Clef with the mailbox’s own questions, and is not asked of the mailbox with none, with the assistant switch off', async () => {
    const h = brightwater(false)
    expect(h.assistant).toBeDefined()
    h.ai?.next(clef(0.9, 'vendor_pitch'))
    expect(
      (await h.deliver(mail('info@brightwater.example', 'a1').raw, { to: 'info@brightwater.example' })).entered,
    ).toBe('filed')
    expect(h.ai?.calls).toHaveLength(1)
    expect(JSON.stringify(h.ai?.calls[0]?.input.questions)).toContain('Brightwater: is it junk?')
    expect(JSON.stringify(h.ai?.calls[0]?.input.questions)).not.toMatch(/Ridgeway|ShiftLantern|Tessa/)

    // Harbor Supply's spam check is switched on by its declaration, and there is nothing to ask: nothing is judged, and its mail is in the Inbox.
    expect((await h.deliver(mail('hello@harbor.example', 'h1').raw, { to: 'hello@harbor.example' })).entered).toBe(
      'filed',
    )
    expect(h.ai?.calls).toHaveLength(1)
  })

  test('the owner cannot switch the spam check on for a mailbox with no questions, and can for one with', async () => {
    const h = brightwater(false)
    await h.deliver(mail('hello@harbor.example', 'h1').raw, { to: 'hello@harbor.example' })
    await h.deliver(mail('info@brightwater.example', 'a1').raw, { to: 'info@brightwater.example' })
    const idOf = (address: string) =>
      (h.db.query(`SELECT id FROM mailbox WHERE address = ?`).get(address) as { id: string }).id
    const owner = 'priya@brightwater.example'
    const refused = h.store.call('setAssistant', idOf('hello@harbor.example'), true, owner)
    expect(await refused).toMatchObject({ ok: false, status: 422 })
    expect(await h.store.call('setAssistant', idOf('info@brightwater.example'), false, owner)).toMatchObject({
      ok: true,
    })
    expect(await h.store.call('setAssistant', idOf('info@brightwater.example'), true, owner)).toMatchObject({
      ok: true,
    })
  })

  test('the draft chat speaks with the mailbox’s own persona, and a mailbox with none is refused it, in words', async () => {
    const h = brightwater(true)
    await h.deliver(mail('info@brightwater.example', 'a1').raw, { to: 'info@brightwater.example' })
    await h.deliver(mail('hello@harbor.example', 'h1').raw, { to: 'hello@harbor.example' })
    const owner = 'priya@brightwater.example'
    const spoken = await h.assistant.chat(
      conversationIn(h, 'info@brightwater.example'),
      { instruction: 'Write a reply' } as never,
      owner,
    )
    expect(spoken, JSON.stringify(spoken)).toMatchObject({ ok: true })
    const system = h.model?.requests.at(-1)?.system ?? ''
    expect(system).toContain('You are the reply assistant for Brightwater, a marine services company.')
    expect(system).toContain('signed "Priya\\nBrightwater"')
    expect(system).not.toMatch(/Tessa|Northfield Works|Ridgeway|ShiftLantern/)

    const silent = await h.assistant.chat(
      conversationIn(h, 'hello@harbor.example'),
      { instruction: 'Write a reply' } as never,
      owner,
    )
    expect(silent).toMatchObject({ ok: false, status: 422 })
    expect((silent as { error: string }).error).toBe(
      'The assistant has nothing written for hello@harbor.example, so it does not chat.',
    )
    expect(h.model?.requests).toHaveLength(1)
  })
})
