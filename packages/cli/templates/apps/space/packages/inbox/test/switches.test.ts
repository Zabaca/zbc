import { describe, expect, test } from 'bun:test'
import { createInstall, identify } from '@space/workspace'
import { ASSISTANT_OFF } from '../src/assistant/assistant'
import { readMailboxContent } from '../src/mailbox-content'
import { createInboxPartFactory, type InboxPartEnv } from '../src/space-part'
import { GMAIL_OFF } from '../src/space-views'
import { assistantKeyFor, googleCredentialsFor, hostedMailboxesFor, spamCheckAiFor } from '../src/switches'
import { roleFor } from '../src/workspace'
import { AUD, accessFetch, asker, harness, mint, TEAM, TELEGRAM_ID } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'

/**
 * Every feature is a switch any install may turn on. Here the inbox's parts read theirs: Gmail's connection, the mail server's mailboxes,
 * the assistant and its spam check, the Telegram bridge and Claude's door, each on an invented company with the switch off and on, and on Northfield's, where every one is on and nothing has changed. The invented
 * company is not Northfield's and has no Tessa in it.
 */

const PRIYA = 'priya@brightwater.example'
const STATE = 'ab12'.repeat(12)

const BASE = {
  company: {
    id: 'brightwater',
    name: 'Brightwater Marine Services',
    domain: 'brightwater.example',
    timeZone: 'America/Los_Angeles',
  },
  // Access's team is the harness's (the one whose keys it signs with), so an assertion for Priya goes through the layer's own check.
  access: { teamDomain: TEAM },
  formsService: { contact: 'help@example.test' },
  space: { host: 'space.brightwater.example', sessionDuration: '730h' },
  people: [
    { address: PRIYA, name: 'Priya', mailName: 'Priya Raman', signIn: 'priya.private@mail.example', role: 'owner' },
  ],
}
const ON = {
  gmailPush: { host: 'inbox-push.brightwater.example' },
  googleApp: {
    clientId: '123456789-abcdefghij.apps.googleusercontent.com',
    pushTopic: 'projects/brightwater-mail/topics/gmail-push',
  },
  hostedMailboxes: [
    {
      address: 'desk@brightwater.example',
      name: 'Desk',
      door: 'https://jmap.brightwater.example',
      secret: 'INBOX_JMAP_DESK',
    },
  ],
  telegram: { path: '/agent/telegram' },
  businesses: [{ id: 'brightwater', name: 'Brightwater', mailboxes: ['info@brightwater.example'] }],
  switches: { gmail: true, hostedMailboxes: true, assistant: true, telegram: true },
}
const off = createInstall(BASE)
const on = createInstall({ ...BASE, ...ON })

describe('Gmail', () => {
  test('connecting is refused where the switch is off, in words, and allowed where it is on, with the install’s own space as the return', async () => {
    const quiet = harness({}, { install: off })
    for (const step of [
      await quiet.space({ install: off }).gmailSignIn(asker({ email: PRIYA }, off), STATE),
      await quiet.space({ install: off }).gmailConnect(asker({ email: PRIYA }, off), 'a-code'),
    ]) {
      expect(step).toMatchObject({ ok: false, kind: 'refused', reason: 'not-found', message: GMAIL_OFF })
    }
    const live = harness({}, { install: on })
    const signIn = await live.space({ install: on }).gmailSignIn(asker({ email: PRIYA }, on), STATE)
    expect(signIn, JSON.stringify(signIn)).toMatchObject({ ok: true })
    expect(new URL((signIn as { value: { url: string } }).value.url).searchParams.get('redirect_uri')).toBe(
      'https://space.brightwater.example/api/inbox/gmail/callback',
    )
  })

  test('Northfield’s install, where the switch is on, connects as ever', async () => {
    const h = harness()
    expect(await h.space().gmailSignIn(asker(), STATE)).toMatchObject({ ok: true })
  })

  test('Google is reached only with the switch on and both halves of the app', () => {
    expect(googleCredentialsFor(off, 'id', 'secret')).toBeNull()
    expect(googleCredentialsFor(on, ' id ', ' secret ')).toEqual({ clientId: 'id', clientSecret: 'secret' })
    expect(googleCredentialsFor(on, 'id', '')).toBeNull()
    expect(googleCredentialsFor(on, undefined, 'secret')).toBeNull()
  })
})

describe('the mailboxes on the install’s own mail server', () => {
  const declared = [
    {
      address: 'desk@brightwater.example',
      name: 'Desk',
      door: 'https://jmap.brightwater.example',
      secret: 'INBOX_JMAP_DESK',
    },
  ]

  test('none are served where the switch is off, even if the Worker is handed a list; where it is on they are read as ever', () => {
    expect(hostedMailboxesFor(off, declared, PRIYA)).toEqual({ ok: true, mailboxes: [] })
    expect(hostedMailboxesFor(on, declared, PRIYA)).toEqual({ ok: true, mailboxes: declared })
    expect(
      hostedMailboxesFor(on, [{ address: PRIYA, name: 'x', door: 'https://m.example', secret: 'S_X_Y' }], PRIYA),
    ).toMatchObject({ ok: false })
  })
})

describe('the assistant and its spam check', () => {
  test('no model key is used where the switch is off', () => {
    expect(assistantKeyFor(off, 'sk-live')).toBe('')
    expect(assistantKeyFor(on, ' sk-live ')).toBe('sk-live')
    expect(assistantKeyFor(on, undefined)).toBe('')
  })

  // The spam check is per mailbox: it runs where a mailbox declares a spam question, whether or not the install's assistant is on, and nowhere else.
  const MAILBOXED = {
    ...BASE,
    businesses: [{ id: 'brightwater', name: 'Brightwater', mailboxes: ['info@brightwater.example'] }],
    cloudflareMailboxes: [{ address: 'info@brightwater.example', name: 'Brightwater', spamCheck: true }],
  }
  const QUESTIONS = {
    spamQuestions: {
      'info@brightwater.example': {
        categories: ['customer', 'vendor_pitch'],
        questions: {
          category: { type: 'choice', instructions: 'x', criteria: { customer: 'a', vendor_pitch: 'b' } },
          junk: { type: 'noul' },
        },
      },
    },
  }

  test('the spam check’s binding is used where a mailbox has spam questions, with the assistant off, and not where none has, with the assistant on', () => {
    const binding = { run: () => Promise.resolve({}) }
    const asking = readMailboxContent(QUESTIONS, createInstall(MAILBOXED))
    const quiet = readMailboxContent(
      {},
      createInstall({
        ...MAILBOXED,
        cloudflareMailboxes: [{ address: 'info@brightwater.example', name: 'Brightwater' }],
        switches: { assistant: true },
      }),
    )
    expect(createInstall(MAILBOXED).has('assistant')).toBe(false)
    expect(spamCheckAiFor(asking, binding)).toBe(binding)
    expect(spamCheckAiFor(asking, null)).toBeNull()
    expect(spamCheckAiFor(quiet, binding)).toBeNull()
  })

  test('a draft chat is refused where the switch is off, whatever key the Worker holds, and gets past that refusal where it is on', async () => {
    const quiet = harness({}, { install: off })
    expect(await quiet.assistant.chat('c1', { instruction: 'shorter' } as never, PRIYA)).toMatchObject({
      ok: false,
      status: 403,
      error: ASSISTANT_OFF,
    })
    const live = harness({}, { install: on })
    const got = await live.assistant.chat('c1', { instruction: 'shorter' } as never, PRIYA)
    expect(got).toMatchObject({ ok: false })
    expect((got as { error: string }).error).not.toBe(ASSISTANT_OFF)
  })
})

describe('Claude’s door and the Telegram bridge', () => {
  test('Claude’s token is admitted only where claudeScript is on; no person is admitted by a token', () => {
    const token = { kind: 'service' as const, commonName: 'claude.access', exp: 0 }
    expect(roleFor(token, off, { INBOX_ACCESS_CLIENT_ID: 'claude.access' })).toBeNull()
    const withClaude = createInstall({
      ...BASE,
      agent: { path: '/agent/inbox' },
      switches: { claudeScript: true },
    })
    expect(roleFor(token, withClaude, { INBOX_ACCESS_CLIENT_ID: 'claude.access' })).toEqual({
      role: 'agent',
      actor: 'agent:claude.access',
    })
  })

  test('the bridge’s router answers a 404 where the switch is off, and is reached where it is on', async () => {
    const h = harness()
    const stub = {
      call: (method: string, args: unknown[]) =>
        (h.store.call as (m: string, ...a: unknown[]) => Promise<unknown>)(method, ...args),
    }
    const env = {
      INBOX: { idFromName: (n: string) => n, get: () => stub },
      TELEGRAM_ACCESS_CLIENT_ID: TELEGRAM_ID,
    } as unknown as InboxPartEnv
    const request = () =>
      new Request('https://space.brightwater.example/api/work', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: { id: '7000000001' } }),
      })
    const who = { kind: 'service' as const, commonName: TELEGRAM_ID, exp: Math.floor(Date.now() / 1000) + 600 }
    const closed = await createInboxPartFactory(off)(env).telegram(request(), who)
    expect(closed.status).toBe(404)
    expect(await closed.json()).toEqual({ error: 'Not found' })
    expect((await createInboxPartFactory(on)(env).telegram(request(), who)).status).toBe(200)
  })
})

describe('an owner who signs in at an address that is not their work address', () => {
  test('is admitted through the real access path: the layer’s check names them by sign-in address, and the inbox admits them as its owner', async () => {
    const jwt = await mint({ email: 'priya.private@mail.example' })
    const out = await identify(off, new Headers({ 'cf-access-jwt-assertion': jwt }), {
      fetch: accessFetch,
      aud: AUD,
      now: Date.now(),
    })
    expect(out.ok, JSON.stringify(out)).toBe(true)
    if (!out.ok || out.identity.kind !== 'person') throw new Error('not a person')
    expect(out.identity.person.address).toBe(PRIYA)
    expect(roleFor(out.identity, off, {})).toEqual({ role: 'owner', actor: PRIYA })
    // And the part the space calls answers them, as the person that check named.
    const h = harness({}, { install: off })
    const signedIn = asker({ email: 'priya.private@mail.example' }, off)
    expect(signedIn.person.address).toBe(PRIYA)
    expect(await h.space({ install: off }).claudeSending(signedIn)).toMatchObject({ ok: true })
  })

  test('their work address is no way in: Access never sends a code there, so an assertion for it names nobody, and Northfield’s owner is nobody here', async () => {
    for (const email of [PRIYA, OWNER_EMAIL]) {
      const jwt = await mint({ email })
      const out = await identify(off, new Headers({ 'cf-access-jwt-assertion': jwt }), {
        fetch: accessFetch,
        aud: AUD,
        now: Date.now(),
      })
      expect([email, out.ok]).toEqual([email, false])
    }
  })
})
