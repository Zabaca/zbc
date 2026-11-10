import { describe, expect, test } from 'bun:test'
import { GmailError } from '../src/gmail/google'
import { PUSH_TIMEOUT_MS, PUSH_TTL_S, pushOverFetch } from '../src/notify/deliver'
import { UNKNOWN_PUSH_SERVICE } from '../src/notify/device'
import { COLLAPSE_AFTER, NOTIFY_WINDOW_S } from '../src/notify/rule'
import { parseVapidKey } from '../src/notify/webpush'
import { NOTIFICATIONS_NOT_SET_UP } from '../src/types'

/** What Claude is told in Northfield's install, word for word. */
const ONLY_OWNER_NOTIFICATIONS =
  'Notifications are Tessa’s only: Claude cannot turn them on or off, list the devices or send one.'

import { AGENT, AGENT_ID, asHttp, count, firstGmail, harness, ownerDraft, TEST_VAPID } from '../test-support/harness'
import { OWNER_EMAIL } from '../test-support/owner'
import { decrypt, newDevice, type TestDevice, verifyVapid } from '../test-support/push-device'

/**
 * Notifications, through the inbox's Worker driven as a function: with the fake Google, a fake clock and a fake push service that records every request.
 * The owner's four calls (Tessa turns a device on, lists, removes and tests it, from the space's Settings, which calls `Notifications` as him; test/space-views.test.ts
 * has the space's side); the whole path from a Pub/Sub push to an encrypted request a device can read; each exclusion; once only;
 * never for the fill or a resync, nor for the thread read before Tessa's Read, Close and Send (Claude's do notify); more
 * than three at once collapsed into one; and what each answer of the push
 * service does.
 *
 * What this cannot show is Google's push service, Chrome or a phone. The fake answers as the RFCs and Google's docs
 * say, written by the same hand as the code; the runbook's hand test is where a real delivery is seen.
 */

type H = ReturnType<typeof harness>
const PIXEL_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

async function live(h: H, setup?: () => void) {
  setup?.()
  expect((await h.connect()).ok).toBe(true)
  await h.drain()
}

/** A Pub/Sub push, then the alarm it sets. */
async function hear(h: H) {
  expect((await h.push()).status).toBe(204)
  await h.drain()
}

/**
 * Tessa's four notification calls, as the space makes them for him: the `Notifications` module called with his address as the actor (the inbox's own routes for them are gone).
 * Answers `{ status, json }` as the routes did: 201 for a device added.
 */
async function notify(
  h: H,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: any,
  userAgent: string | null = null,
) {
  const device = /^\/api\/notifications\/devices\/([^/]+)(\/test)?$/.exec(path)
  if (method === 'GET' && path === '/api/notifications')
    return asHttp(await h.store.call('notificationSettings', OWNER_EMAIL))
  if (method === 'POST' && path === '/api/notifications/devices') {
    const added = (await h.store.call('addDevice', body, userAgent, OWNER_EMAIL)) as { ok: boolean }
    return added.ok ? { status: 201, json: asHttp(added).json } : asHttp(added)
  }
  if (method === 'DELETE' && device && !device[2])
    return asHttp(await h.store.call('removeDevice', device[1] ?? '', OWNER_EMAIL))
  if (method === 'POST' && device?.[2])
    return asHttp(await h.store.call('sendTestNotification', device[1] ?? '', OWNER_EMAIL))
  throw new Error(`no such notification call: ${method} ${path}`)
}

/** Turn notifications on in a browser: what Settings posts after the browser subscribed. */
async function turnOn(h: H, device: TestDevice, ua = PIXEL_UA) {
  const res = await notify(
    h,
    'POST',
    '/api/notifications/devices',
    { endpoint: device.endpoint, keys: device.keys },
    ua,
  )
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json as { id: string; label: string }
}

/** What each request to a device said, decrypted with the device's own key. */
const read = async (h: H, device: TestDevice) =>
  Promise.all(h.pushService.to(device.endpoint).map(async (r) => JSON.parse((await decrypt(device, r.body)).text)))

const notifyMark = (h: H, gmailId: string) =>
  (h.db.query(`SELECT notify FROM message WHERE gmail_id = ?`).get(gmailId) as { notify: string | null } | null)?.notify

const convoId = (h: H, threadId: string): string =>
  (h.db.query(`SELECT id FROM conversation WHERE gmail_thread_id = ?`).get(threadId) as { id: string }).id

const contactOf = (h: H, address: string): string =>
  (h.db.query(`SELECT contact_id FROM identity WHERE address = ?`).get(address) as { contact_id: string }).contact_id

describe('the routes', () => {
  test('Tessa reads the public key and the devices; Claude has no route to any of it and the module refuses its actor too, and nothing is written', async () => {
    const h = harness()
    const settings = await notify(h, 'GET', '/api/notifications')
    expect(settings.status).toBe(200)
    expect(settings.json).toEqual({
      publicKey: parseVapidKey(TEST_VAPID)?.publicKey,
      devices: [],
      week: { sent: 0, dropped: 0 },
    })

    const device = await newDevice()
    const body = { endpoint: device.endpoint, keys: device.keys }
    for (const [method, path, sent] of [
      ['GET', '/api/notifications', undefined],
      ['POST', '/api/notifications/devices', body],
      ['DELETE', '/api/notifications/devices/x', undefined],
      ['POST', '/api/notifications/devices/x/test', {}],
    ] as const) {
      // Claude's door has none of these routes...
      const res = await h.request(AGENT, method, path, sent)
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    // ...and the module refuses an agent's actor on its own, so a route added later could not open it.
    const claude = `agent:${AGENT_ID}`
    for (const refused of [
      await h.store.call('notificationSettings', claude),
      await h.store.call('addDevice', body, null, claude),
      await h.store.call('removeDevice', 'x', claude),
      await h.store.call('sendTestNotification', 'x', claude),
    ]) {
      expect(asHttp(refused)).toEqual({ status: 403, json: { error: ONLY_OWNER_NOTIFICATIONS } })
    }
    expect(count(h, 'device')).toBe(0)
    expect(h.pushService.requests).toEqual([])
  })

  test('a device is added with its label from the browser, and listed without its keys', async () => {
    const h = harness()
    const device = await newDevice()
    const added = await turnOn(h, device, MAC_UA)
    expect(added).toMatchObject({ label: 'Chrome on macOS', endpoint: device.endpoint, lastFailure: null })
    const listed = (await notify(h, 'GET', '/api/notifications')).json.devices
    expect(listed).toEqual([added])
    expect(JSON.stringify(listed)).not.toContain(device.keys.p256dh)
    expect(JSON.stringify(listed)).not.toContain(device.keys.auth)
    const audit = (await h.request(AGENT, 'GET', '/api/audit')).json as { action: string; after: string }[]
    expect(audit.map((a) => a.action)).toContain('device.add')
    expect(JSON.stringify(audit)).not.toContain(device.keys.p256dh)
    expect(JSON.stringify(audit)).not.toContain(device.endpoint)
  })

  test('turning notifications on twice in the same browser updates the one device, with the new keys', async () => {
    const h = harness()
    const first = await newDevice('same')
    const again = await newDevice('same')
    const a = await turnOn(h, first)
    const b = await turnOn(h, again)
    expect(b.id).toBe(a.id)
    expect(count(h, 'device')).toBe(1)
    expect((await notify(h, 'POST', `/api/notifications/devices/${a.id}/test`)).json.outcome).toBe('delivered')
    // The test notification went with the keys of the second subscription: only it can read it.
    expect((await read(h, again))[0]).toMatchObject({ kind: 'test' })
  })

  test("an address that is not Chrome's push service is refused, and so is anything that is not a subscription", async () => {
    const h = harness()
    const d = await newDevice()
    const bad = [
      { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys: d.keys },
      { endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: d.keys },
      { endpoint: 'https://fcm.googleapis.com.evil.test/fcm/send/x', keys: d.keys },
      { endpoint: 'https://fcm.googleapis.com:8443/fcm/send/x', keys: d.keys },
      { endpoint: 'https://localhost/x', keys: d.keys },
    ]
    for (const body of bad) {
      const res = await notify(h, 'POST', '/api/notifications/devices', body)
      expect(res.status, body.endpoint).toBe(422)
      expect(res.json.error).toBe(UNKNOWN_PUSH_SERVICE)
    }
    for (const body of [
      {},
      { endpoint: d.endpoint },
      { endpoint: d.endpoint, keys: { p256dh: d.keys.auth, auth: d.keys.auth } },
      { endpoint: d.endpoint, keys: { p256dh: d.keys.p256dh, auth: d.keys.p256dh } },
    ]) {
      expect((await notify(h, 'POST', '/api/notifications/devices', body)).status).toBe(422)
    }
    expect(count(h, 'device')).toBe(0)
  })

  test('a device is removed from any device, audited; removing it again is a 404', async () => {
    const h = harness()
    const pixel = await turnOn(h, await newDevice())
    const res = await notify(h, 'DELETE', `/api/notifications/devices/${pixel.id}`)
    expect(res.status).toBe(200)
    expect(count(h, 'device')).toBe(0)
    expect((await notify(h, 'DELETE', `/api/notifications/devices/${pixel.id}`)).status).toBe(404)
    const audit = (await h.request(AGENT, 'GET', '/api/audit')).json as { action: string }[]
    expect(audit.map((a) => a.action)).toContain('device.remove')
  })

  test('the test notification goes to that device only, now, and says what the push service answered', async () => {
    const h = harness()
    const [pixel, mac] = [await newDevice(), await newDevice()]
    const p = await turnOn(h, pixel)
    await turnOn(h, mac, MAC_UA)
    const res = await notify(h, 'POST', `/api/notifications/devices/${p.id}/test`)
    expect(res.json).toEqual({ outcome: 'delivered', status: 201 })
    expect(h.pushService.requests).toHaveLength(1)
    expect((await read(h, pixel))[0]).toMatchObject({
      v: 1,
      kind: 'test',
      conversationId: null,
      title: 'Northfield Works Space',
    })
    expect((await notify(h, 'POST', '/api/notifications/devices/nope/test')).status).toBe(404)
  })

  test('with no key on the Worker every route is 503, nothing is added, and nothing is ever sent', async () => {
    const h = harness({}, { vapid: null })
    const device = await newDevice()
    for (const [method, path, sent] of [
      ['GET', '/api/notifications', undefined],
      ['POST', '/api/notifications/devices', { endpoint: device.endpoint, keys: device.keys }],
      ['DELETE', '/api/notifications/devices/x', undefined],
      ['POST', '/api/notifications/devices/x/test', {}],
    ] as const) {
      const res = await notify(h, method, path, sent)
      expect(res.status, `${method} ${path}`).toBe(503)
      expect(res.json.error).toBe(NOTIFICATIONS_NOT_SET_UP)
    }
    expect(count(h, 'device')).toBe(0)
  })
})

describe('the whole path: a person writes, and each device is told', () => {
  test('a Pub/Sub push becomes a sync that stores the message, and each device gets one request it can read', async () => {
    const h = harness()
    await live(h)
    const [pixel, mac] = [await newDevice(), await newDevice()]
    await turnOn(h, pixel)
    await turnOn(h, mac, MAC_UA)

    h.google.mailbox.add({
      id: 'm1',
      threadId: 't1',
      from: 'Marta Vidal <marta@tamarackprint.test>',
      subject: 'Re: Changes to the site',
      body: 'The body never travels.',
    })
    await hear(h)

    for (const device of [pixel, mac]) {
      const requests = h.pushService.to(device.endpoint)
      expect(requests).toHaveLength(1)
      const [request] = requests
      if (!request) throw new Error('no request')
      expect(await read(h, device)).toEqual([
        {
          v: 1,
          kind: 'message',
          conversationId: convoId(h, 't1'),
          person: 'marta@tamarackprint.test',
          messageId: expect.any(String),
          title: 'Marta Vidal',
          body: 'Re: Changes to the site',
          at: '2026-10-20T12:00:00.000Z',
        },
      ])
      const decoded = (await decrypt(device, request.body)).text
      expect(decoded).not.toContain('never travels')
      // The sender's address travels once, as `person` (how the space opens the conversation), and in no other field.
      expect(decoded.split('marta@')).toHaveLength(2)
      expect(JSON.parse(decoded).person).toBe('marta@tamarackprint.test')
      expect(request.headers).toMatchObject({
        TTL: String(NOTIFY_WINDOW_S),
        Urgency: 'high',
        'Content-Encoding': 'aes128gcm',
      })
      expect(Object.keys(request.headers).map((k) => k.toLowerCase())).not.toContain('topic')
      const vapid = await verifyVapid(request.headers.Authorization ?? '')
      expect(vapid.key).toBe(parseVapidKey(TEST_VAPID)?.publicKey ?? 'no key')
      expect(vapid.claims.aud).toBe('https://fcm.googleapis.com')
      expect(Number(vapid.claims.exp) * 1000 - h.now()).toBeLessThanOrEqual(12 * 60 * 60 * 1000)
    }
    expect(PUSH_TTL_S).toBe(NOTIFY_WINDOW_S)
    expect(notifyMark(h, 'm1')).toBe('sent')
    const after = (await notify(h, 'GET', '/api/notifications')).json
    expect(
      after.devices.every(
        (d: { lastDeliveredAt: string | null; delivered: number }) => d.lastDeliveredAt !== null && d.delivered === 1,
      ),
    ).toBe(true)
    expect(after.week).toEqual({ sent: 1, dropped: 0 })
  })

  test('a second email in the same conversation is a notification of its own', async () => {
    const h = harness()
    await live(h)
    const pixel = await newDevice()
    await turnOn(h, pixel)
    h.google.mailbox.add({ id: 'm1', threadId: 't1', from: 'Ann <ann@person.test>' })
    await hear(h)
    h.google.mailbox.add({ id: 'm2', threadId: 't1', from: 'Ann <ann@person.test>' })
    await hear(h)
    const got = await read(h, pixel)
    expect(got).toHaveLength(2)
    expect(got[0].messageId).not.toBe(got[1].messageId)
    expect(got[0].conversationId).toBe(got[1].conversationId)
  })

  test('with no device, an owed notification is dropped, and a device added later does not get it', async () => {
    const h = harness()
    await live(h)
    h.google.mailbox.add({ id: 'm1', from: 'Ann <ann@person.test>' })
    await hear(h)
    expect(notifyMark(h, 'm1')).toBe('dropped')
    expect((await notify(h, 'GET', '/api/notifications')).json.week).toEqual({ sent: 0, dropped: 1 })
    await turnOn(h, await newDevice())
    h.google.mailbox.add({ id: 'm2', from: 'Ann <ann@person.test>' })
    await hear(h)
    expect(h.pushService.requests).toHaveLength(1)
  })

  test('with no key, what the sync marks owed is dropped and nothing is sent', async () => {
    const h = harness({}, { vapid: null })
    await live(h)
    h.google.mailbox.add({ id: 'm1', from: 'Ann <ann@person.test>' })
    await hear(h)
    expect(notifyMark(h, 'm1')).toBe('dropped')
    expect(h.pushService.requests).toEqual([])
  })
})

describe('what makes no sound', () => {
  async function arrive(spec: Parameters<H['google']['mailbox']['add']>[0], before?: (h: H) => void | Promise<void>) {
    const h = harness()
    await live(h)
    await turnOn(h, await newDevice())
    await before?.(h)
    h.google.mailbox.add({ id: 'x', from: 'Ann <ann@person.test>', ...spec })
    await hear(h)
    return h
  }

  test('mail Tessa sent (Gmail marks it Sent), and mail from our own address with no Sent label', async () => {
    let h = await arrive({
      labels: ['SENT'],
      from: 'Tessa Marlow <tessa@northfield.example>',
      to: 'Ann <ann@person.test>',
    })
    expect(h.pushService.requests).toEqual([])
    expect(notifyMark(h, 'x')).toBeNull()
    h = await arrive({ labels: ['INBOX', 'UNREAD'], from: 'Tessa Marlow <tessa@northfield.example>' })
    expect(h.pushService.requests).toEqual([])
  })

  test('mail not in the Inbox: a reply Gmail filed under a category only, in a conversation the inbox holds', async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ id: 'first', threadId: 'th', from: 'Ann <ann@person.test>' })
    })
    await turnOn(h, await newDevice())
    h.google.mailbox.add({ id: 'reply', threadId: 'th', labels: ['UNREAD'], from: 'Ann <ann@person.test>' })
    await hear(h)
    expect(notifyMark(h, 'reply')).toBeNull()
    expect(h.pushService.requests).toEqual([])
  })

  test('mail already read in Gmail by the time the inbox has it', async () => {
    const h = await arrive({ labels: ['INBOX'] })
    expect(h.pushService.requests).toEqual([])
  })

  test('mail read in Gmail in the same page of history that brought it', async () => {
    const h = harness()
    await live(h)
    await turnOn(h, await newDevice())
    h.google.mailbox.add({ id: 'x', from: 'Ann <ann@person.test>' })
    h.google.mailbox.label('x', { remove: ['UNREAD'] })
    await hear(h)
    expect(h.pushService.requests).toEqual([])
  })

  test('Bulk: a newsletter in Updates, and one with List-Unsubscribe', async () => {
    let h = await arrive({ labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'], from: 'Shop <hello@shop.test>' })
    expect(h.pushService.requests).toEqual([])
    h = await arrive({ from: 'News <news@letter.test>', headers: { 'List-Unsubscribe': '<mailto:u@letter.test>' } })
    expect(h.pushService.requests).toEqual([])
  })

  test('an automated sender: a no-reply mailbox in Primary', async () => {
    const h = await arrive({ from: 'Bank <no-reply@bank.test>' })
    expect(h.pushService.requests).toEqual([])
  })

  test('mail Gmail received more than an hour before the inbox found it', async () => {
    const h = await arrive({ at: Date.parse('2026-10-20T10:59:00.000Z') })
    expect(h.pushService.requests).toEqual([])
    expect(notifyMark(h, 'x')).toBeNull()
  })

  test("a Client's person counts anyway: from a no-reply address, in Updates, it notifies", async () => {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ id: 'old', threadId: 'tc', labels: ['INBOX'], from: 'Acme <notifications@acme.test>' })
    })
    await turnOn(h, await newDevice())
    expect(
      (
        await h.request(AGENT, 'PUT', `/api/contacts/${contactOf(h, 'notifications@acme.test')}/client`, {
          clientId: 1,
        })
      ).status,
    ).toBe(200)
    h.google.mailbox.add({
      id: 'new',
      threadId: 'tc',
      labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
      from: 'Acme <notifications@acme.test>',
      subject: 'Your site is live',
    })
    await hear(h)
    expect(h.pushService.requests).toHaveLength(1)
    expect(notifyMark(h, 'new')).toBe('sent')
  })
})

describe('once, and only for what the sync stores', () => {
  test('a push delivered twice, a page read again after a failure, and the daily pass finding the same message: one request', async () => {
    const h = harness()
    await live(h)
    const pixel = await newDevice()
    await turnOn(h, pixel)
    h.google.mailbox.add({ id: 'm1', from: 'Ann <ann@person.test>' })
    h.google.mailbox.add({ id: 'm2', from: 'Bob <bob@person.test>' })
    // The second fetch fails, so the run dies after storing nothing of the page; the retry reads the page again.
    h.google.failNext('getMessage', new GmailError('Gmail is having a moment.', 503))
    await h.push()
    await h.push()
    await h.drain()
    h.tick(60_000)
    await h.drain()
    await h.store.call('runDaily')
    await hear(h)
    const got = await read(h, pixel)
    expect(got.map((p) => p.title).sort()).toEqual(['Ann', 'Bob'])
  })

  test('the first fill notifies about nothing, however new and unread', async () => {
    const h = harness()
    await turnOn(h, await newDevice())
    await live(h, () => {
      h.google.mailbox.add({ id: 'f1', from: 'Ann <ann@person.test>' })
      h.google.mailbox.add({ id: 'f2', from: 'Bob <bob@person.test>' })
    })
    expect(count(h, 'message')).toBe(2)
    expect(h.pushService.requests).toEqual([])
    expect(notifyMark(h, 'f1')).toBeNull()
  })

  test('a resync after the cursor went stale notifies about nothing it stores', async () => {
    const h = harness()
    await live(h)
    await turnOn(h, await newDevice())
    h.google.mailbox.add({ id: 'gap', from: 'Ann <ann@person.test>' })
    h.google.mailbox.forgetHistory()
    await hear(h)
    expect(notifyMark(h, 'gap')).toBeNull()
    expect(count(h, 'message')).toBe(1)
    expect(h.pushService.requests).toEqual([])
  })

  /** A conversation Tessa was shown, and a reply that reaches Gmail after it and before any push. */
  async function replyBeforePush() {
    const h = harness()
    await live(h, () => {
      h.google.mailbox.add({ id: 'a1', threadId: 'ta', from: 'Ann <ann@person.test>', subject: 'Quote' })
    })
    const pixel = await newDevice()
    await turnOn(h, pixel)
    const shown = (await h.request(AGENT, 'GET', `/api/conversations/${convoId(h, 'ta')}`)).json.through
    h.google.mailbox.add({ id: 'a2', threadId: 'ta', from: 'Ann <ann@person.test>', subject: 'Re: Quote' })
    return { h, pixel, shown, id: convoId(h, 'ta'), path: `/api/conversations/${convoId(h, 'ta')}` }
  }

  for (const action of ['read', 'close'] as const) {
    test(`Tessa's ${action}: the thread read stores the reply silently (he is looking), and the push after finds it held`, async () => {
      const { h, shown, id } = await replyBeforePush()
      expect(asHttp(await h.store.call('changeConversation', id, action, OWNER_EMAIL, shown)).status).toBe(409)
      expect(notifyMark(h, 'a2')).toBeNull()
      await hear(h)
      expect(h.pushService.requests).toEqual([])
    })
  }

  test("Claude's close: nobody is looking, so the reply its thread read stores notifies at once, and only once", async () => {
    const { h, pixel, shown, path } = await replyBeforePush()
    expect((await h.request(AGENT, 'POST', `${path}/close`, { through: shown })).status).toBe(409)
    expect(notifyMark(h, 'a2')).toBe('sent')
    expect((await read(h, pixel)).map((p) => p.body)).toEqual(['Re: Quote'])
    await hear(h)
    expect(h.pushService.requests).toHaveLength(1)
  })

  async function sendReply(who: 'owner' | 'agent') {
    const { h, pixel } = await replyBeforePush()
    const draft = (await ownerDraft(h, { conversationId: convoId(h, 'ta'), body: 'Tuesday works.' })).json
    const through = (await h.request(AGENT, 'GET', `/api/conversations/${convoId(h, 'ta')}`)).json.through
    if (who === 'agent') expect(asHttp(await h.store.call('setClaudeSending', true, OWNER_EMAIL)).status).toBe(200)
    const instruction = { text: 'send it', where: 'session main', at: new Date(h.now()).toISOString() }
    const send = { rev: draft.rev, through, ...(who === 'agent' ? { instruction } : {}) }
    const res =
      who === 'agent'
        ? await h.request(AGENT, 'POST', `/api/drafts/${draft.id}/send`, send)
        : asHttp(await h.store.call('sendDraft', draft.id, send, OWNER_EMAIL))
    expect(res.status, JSON.stringify(res.json)).toBe(409)
    return { h, pixel }
  }

  test("Tessa's send: the reply the thread read finds is stored silently", async () => {
    const { h } = await sendReply('owner')
    expect(notifyMark(h, 'a2')).toBeNull()
    await hear(h)
    expect(h.pushService.requests).toEqual([])
  })

  test("Claude's send: the reply the thread read finds notifies Tessa at once", async () => {
    const { h, pixel } = await sendReply('agent')
    expect(notifyMark(h, 'a2')).toBe('sent')
    expect((await read(h, pixel)).map((p) => p.body)).toEqual(['Re: Quote'])
  })
})

describe('what each answer of the push service does', () => {
  async function oneEach(status: number | null) {
    const h = harness()
    await live(h)
    const [pixel, mac] = [await newDevice(), await newDevice()]
    const p = await turnOn(h, pixel)
    const m = await turnOn(h, mac, MAC_UA)
    h.pushService.answer(pixel.endpoint, status)
    h.google.mailbox.add({ id: 'm1', from: 'Ann <ann@person.test>' })
    await hear(h)
    return { h, p, m, pixel, mac }
  }
  const devices = async (h: H) =>
    (await notify(h, 'GET', '/api/notifications')).json.devices as {
      id: string
      lastFailure: string | null
      lastDeliveredAt: string | null
    }[]

  for (const status of [410, 404]) {
    test(`${status}: the browser dropped the device, which leaves the list, and the audit says why`, async () => {
      const { h, p, m } = await oneEach(status)
      expect((await devices(h)).map((d) => d.id)).toEqual([m.id])
      const audit = (await h.request(AGENT, 'GET', '/api/audit')).json as {
        action: string
        actor: string
        subject: string
      }[]
      expect(audit.find((a) => a.action === 'device.gone')).toMatchObject({
        actor: 'push-service',
        subject: `device:${p.id}`,
      })
      // The other device was not held up.
      expect((await devices(h))[0]?.lastDeliveredAt).not.toBeNull()
    })
  }

  test('403: refused, marked failing with what to do, kept, and not retried', async () => {
    const { h, p, pixel } = await oneEach(403)
    const failing = (await devices(h)).find((d) => d.id === p.id) as unknown as {
      lastFailure: string
      failed: number
      delivered: number
    }
    expect(failing?.lastFailure).toContain('Turn notifications on again')
    expect([failing.delivered, failing.failed]).toEqual([0, 1])
    expect(h.pushService.to(pixel.endpoint)).toHaveLength(1)
    h.tick()
    await h.drain()
    expect(h.pushService.to(pixel.endpoint)).toHaveLength(1)
  })

  for (const status of [500, 429, null]) {
    test(`${status ?? 'no answer'}: marked failing, the sync completes with its cursor moved, and nothing is retried`, async () => {
      const { h, p, pixel } = await oneEach(status)
      expect((await devices(h)).find((d) => d.id === p.id)?.lastFailure).not.toBeNull()
      expect(notifyMark(h, 'm1')).toBe('sent')
      const mailbox = (await h.request(AGENT, 'GET', '/api/mailbox')).json.accounts[0]
      expect(mailbox.lastError).toBeNull()
      expect(firstGmail(h.inbox)?.historyId).toBe(String(h.google.mailbox.historyId))
      h.tick()
      await h.drain()
      expect(h.pushService.to(pixel.endpoint)).toHaveLength(1)
    })
  }

  test('a delivery after a failure clears nothing on its own, but shows the device delivering again', async () => {
    const { h, p, pixel } = await oneEach(500)
    h.pushService.answer(pixel.endpoint, 201)
    h.google.mailbox.add({ id: 'm2', from: 'Ann <ann@person.test>' })
    await hear(h)
    const d = (await devices(h)).find((x) => x.id === p.id)
    expect(d?.lastDeliveredAt).not.toBeNull()
  })
})

describe('more than three at once arrive as one, and the hour', () => {
  async function burst(n: number) {
    const h = harness()
    await live(h)
    const pixel = await newDevice()
    await turnOn(h, pixel)
    const names = ['Marta Vidal', 'Corin Pike', 'Dana Smith', 'Eve Jones', 'Finn Ray']
    for (let i = 0; i < n; i++)
      h.google.mailbox.add({ id: `m${i}`, from: `${names[i % 5]} <p${i}@person.test>`, subject: `S${i}` })
    await hear(h)
    return { h, pixel }
  }

  test(`up to ${COLLAPSE_AFTER} in one run arrive one by one`, async () => {
    const { h, pixel } = await burst(COLLAPSE_AFTER)
    expect((await read(h, pixel)).map((p) => [p.kind, p.body])).toEqual([
      ['message', 'S0'],
      ['message', 'S1'],
      ['message', 'S2'],
    ])
  })

  test(`more than ${COLLAPSE_AFTER} in one run are one notification whose tap opens the Inbox, and none is sent alone later`, async () => {
    const { h, pixel } = await burst(5)
    expect(await read(h, pixel)).toEqual([
      {
        v: 1,
        kind: 'summary',
        conversationId: null,
        messageId: expect.stringMatching(/^summary-/),
        title: '5 new messages',
        body: 'From Marta, Corin and 3 others',
        at: expect.any(String),
      },
    ])
    for (let i = 0; i < 5; i++) expect(notifyMark(h, `m${i}`)).toBe('sent')
    await h.store.call('runDaily')
    await hear(h)
    expect(h.pushService.requests).toHaveLength(1)
    expect((await notify(h, 'GET', '/api/notifications')).json.week).toEqual({ sent: 5, dropped: 0 })
  })

  test('the next mail after a summary is counted afresh: one more arrives on its own', async () => {
    const { h, pixel } = await burst(4)
    h.google.mailbox.add({ id: 'later', from: 'Ann <ann@person.test>', subject: 'Later' })
    await hear(h)
    expect((await read(h, pixel)).map((p) => p.kind)).toEqual(['summary', 'message'])
  })

  test('an owed notification found past the hour is dropped, not sent', async () => {
    const h = harness()
    await live(h)
    await turnOn(h, await newDevice())
    h.google.mailbox.add({ id: 'm1', from: 'Ann <ann@person.test>' })
    // Marked owed by a run that stopped before delivering (a crash), and found by the next run an hour later.
    const notifications = h.notifications
    await h.push()
    const deliver = notifications.deliverOwed.bind(notifications)
    notifications.deliverOwed = async () => {}
    await h.drain()
    expect(notifyMark(h, 'm1')).toBe('owed')
    notifications.deliverOwed = deliver
    h.tick((NOTIFY_WINDOW_S + 1) * 1000)
    await notifications.deliverOwed()
    expect(notifyMark(h, 'm1')).toBe('dropped')
    expect(h.pushService.requests).toEqual([])
  })

  test('a push service that never answers is given up on after the timeout, as no answer', async () => {
    const port = pushOverFetch((_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }, 20)
    const started = Date.now()
    await expect(
      port.send('https://fcm.googleapis.com/fcm/send/x', { headers: {}, body: new Uint8Array() }),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(PUSH_TIMEOUT_MS).toBe(10_000)
  })

  test('a notification failing to deliver never fails the sync: an error in delivery leaves the mail stored', async () => {
    const h = harness()
    await live(h)
    const pixel = await newDevice()
    await turnOn(h, pixel)
    // A device row whose keys cannot be read: the encryption throws, the delivery is recorded as failed, the run goes on.
    h.db.run(`UPDATE device SET p256dh = '!!!'`)
    h.google.mailbox.add({ id: 'm1', from: 'Ann <ann@person.test>' })
    await hear(h)
    expect(count(h, 'message')).toBe(1)
    expect((await h.request(AGENT, 'GET', '/api/mailbox')).json.accounts[0].lastError).toBeNull()
    expect(notifyMark(h, 'm1')).toBe('sent')
  })
})
