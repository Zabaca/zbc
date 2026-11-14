// Notifications in the space: what a notification the inbox sends a SPACE device becomes on screen, whether it is kept quiet, and where a tap goes (the service worker's rules,
// src/client/sw-push.ts), and what Settings says about this browser (src/client/notify.ts). The worker's glue and the browser's push calls are not unit tested: the hand test
// after the deploy watches them work. The payloads here are made by the INBOX'S OWN code (packages/inbox/src/notify/rule.ts), so the two cannot drift apart unseen.
import { describe, expect, test } from 'bun:test'
import type { InboxDevice } from '@space/workspace'
import { messagePayload, summaryPayload, testPayload } from '../../inbox/src/notify/rule'
import { MESSAGES, conversationPathOf, isAppWindow, notificationFor, readPayload, showsEveryPush, stayQuiet, tapPath, tapTarget } from '../src/client/sw-push'
import { type BrowserFacts, WINDOW_MESSAGES, appleDevice, browserState, failing, safePath, serverKey } from '../src/client/notify'
import { inboxPath } from '../src/client/route'
import { ordered } from '../src/client/Notifications'

const ORIGIN = 'https://space.northfield.example'
const NOW = new Date('2026-11-02T12:00:00.000Z')
const mail = { conversationId: 'conv-1', messageId: 'm-1', name: 'Marta Vidal', address: 'Marta@Tamarackprint.test', subject: 'Re: Changes to the site', receivedAt: NOW.toISOString() }

/** What the browser's push service hands the worker: the text the inbox sent, JSON. */
const pushed = (payload: unknown) => JSON.stringify(payload)

describe('the worker and the page speak the same words', () => {
  test('the messages between them are one list, written twice because the worker imports nothing', () => {
    expect(WINDOW_MESSAGES).toEqual(MESSAGES)
  })

  test('the path a conversation opens at is the page’s own route', () => {
    for (const address of ['marta@tamarackprint.test', 'a+b@x.example', 'odd name@x.example']) expect(conversationPathOf(address)).toBe(inboxPath(address))
  })
})

describe('a notification the inbox sends a space device', () => {
  test('is read, shown as sender over subject, and a tap opens THAT PERSON’S CONVERSATION in the space', () => {
    const payload = readPayload(pushed(messagePayload(mail)))
    expect(payload).toMatchObject({ v: 1, kind: 'message', title: 'Marta Vidal', body: 'Re: Changes to the site', person: 'marta@tamarackprint.test', messageId: 'm-1' })
    const shown = notificationFor(payload)
    expect(shown.title).toBe('Marta Vidal')
    expect(shown.options).toMatchObject({ body: 'Re: Changes to the site', tag: 'm-1', data: { person: 'marta@tamarackprint.test' }, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png' })
    expect(shown.options.timestamp).toBe(NOW.getTime())
    expect(tapPath(shown.options.data.person)).toBe('/inbox/marta%40tamarackprint.test')
    // Opened in a window of the space, no reload; or, with none, in a new one at that very address.
    expect(tapTarget('marta@tamarackprint.test', [{ url: `${ORIGIN}/people`, focused: true }], ORIGIN)).toEqual({ kind: 'focus', index: 0, path: '/inbox/marta%40tamarackprint.test' })
    expect(tapTarget('marta@tamarackprint.test', [], ORIGIN)).toEqual({ kind: 'open', url: '/inbox/marta%40tamarackprint.test' })
  })

  test('a mailbox’s name leads the title for mail that came through a business mailbox, and the tap is the same', () => {
    const payload = readPayload(pushed(messagePayload({ ...mail, mailbox: 'Ridgeway Cycles' })))
    expect(payload?.title).toBe('Ridgeway Cycles: Marta Vidal')
    expect(payload?.person).toBe('marta@tamarackprint.test')
  })

  test('a summary and the test name no one, and open the Inbox list', () => {
    const summary = readPayload(pushed(summaryPayload([{ messageId: 'a', name: 'Ann', address: 'ann@x.example', receivedAt: NOW.toISOString() }, { messageId: 'b', name: 'Bob', address: 'bob@x.example', receivedAt: NOW.toISOString() }], NOW)))
    const test = readPayload(pushed(testPayload(NOW, 'Northfield Works')))
    for (const payload of [summary, test]) {
      expect(payload).not.toHaveProperty('person')
      expect(notificationFor(payload).options.data.person).toBeNull()
      expect(tapPath(notificationFor(payload).options.data.person)).toBe('/inbox')
    }
    expect(test?.title).toBe('Northfield Works Space')
  })

  test('a person’s name is never taken from a payload that is not a clean address: it is dropped, and the tap opens the list', () => {
    const base = messagePayload(mail)
    for (const person of ['', '   ', 42, null, 'x'.repeat(400)]) {
      const shown = notificationFor(readPayload(pushed({ ...base, person })))
      expect([String(person).slice(0, 5), shown.options.data.person]).toEqual([String(person).slice(0, 5), null])
    }
  })

  test('one that cannot be read is shown as "New mail" with no detail, because Chrome expects a notification for every push', () => {
    for (const text of ['', 'not json', '[]', pushed({ v: 2, kind: 'message', title: 't', body: 'b', messageId: 'm', conversationId: null }), pushed({ v: 1, kind: 'other', title: 't', body: 'b', messageId: 'm', conversationId: null })]) {
      expect(readPayload(text)).toBeNull()
    }
    expect(notificationFor(null)).toMatchObject({ title: 'New mail', options: { body: '', data: { person: null } } })
    expect(readPayload(null)).toBeNull()
  })

  test('a payload with no person (one sent before every device was the space’s) read by the space’s worker would open the list, never a stranger’s conversation', () => {
    const { person: _gone, ...older } = messagePayload(mail)
    const forInbox = readPayload(pushed(older))
    expect(forInbox).not.toHaveProperty('person')
    expect(tapPath(notificationFor(forInbox).options.data.person)).toBe('/inbox')
  })
})

describe('kept quiet only when the page shows that very person', () => {
  test('a visible window with that person open means nothing is shown; another person, or nothing open, is news', () => {
    expect(stayQuiet('marta@tamarackprint.test', [['marta@tamarackprint.test', 'marta@other.example']])).toBe(true)
    expect(stayQuiet('marta@other.example', [['marta@tamarackprint.test', 'marta@other.example']])).toBe(true) // wrote from another of their addresses
    expect(stayQuiet('someone@x.example', [['marta@tamarackprint.test']])).toBe(false)
    expect(stayQuiet('marta@tamarackprint.test', [[], []])).toBe(false)
    expect(stayQuiet('marta@tamarackprint.test', [])).toBe(false)
    expect(stayQuiet(null, [['marta@tamarackprint.test']])).toBe(false) // a summary or the test is always shown
  })
})

describe('Apple’s devices show every push', () => {
  const UA = {
    iphoneApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    ipadApp: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
    macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    macEdge: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
    pixel: 'Mozilla/5.0 (Linux; Android 15; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  }

  test('Safari takes away a site’s permission when a push shows nothing, so the worker shows it even with that person’s conversation open; Chrome lets it stand', () => {
    for (const ua of [UA.iphoneApp, UA.ipadApp, UA.iphoneChrome, UA.macSafari]) expect([ua, showsEveryPush(ua)]).toEqual([ua, true])
    for (const ua of [UA.macChrome, UA.macEdge, UA.macFirefox, UA.pixel]) expect([ua, showsEveryPush(ua)]).toEqual([ua, false])
  })

  test('an iPhone and an iPad are told apart from a Mac by what they say, an iPad’s desktop-class Macintosh by its touch screen', () => {
    expect(appleDevice(UA.iphoneApp, 5)).toBe('iPhone')
    expect(appleDevice(UA.iphoneChrome, 5)).toBe('iPhone')
    expect(appleDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', 5)).toBe('iPad')
    expect(appleDevice(UA.macSafari, 5)).toBe('iPad') // Safari in a tab on an iPad says Macintosh, with a touch screen
    expect(appleDevice(UA.ipadApp, 5)).toBe('iPad')
    expect(appleDevice(UA.macSafari, 0)).toBeNull() // a Mac
    expect(appleDevice(UA.macChrome, 0)).toBeNull()
    expect(appleDevice(UA.pixel, 5)).toBeNull()
  })
})

describe('where a tap goes', () => {
  test('the focused window of the space first, any other window of the space next, and never an API answer (forms’ included) or Access’s page', () => {
    const windows = [
      { url: `${ORIGIN}/api/me`, focused: true },
      { url: `${ORIGIN}/cdn-cgi/access/login`, focused: false },
      { url: `${ORIGIN}/forms/api/envelopes/e1/finished.pdf`, focused: false },
      { url: 'https://inbox.northfield.example/', focused: false },
      { url: `${ORIGIN}/today`, focused: false },
      { url: `${ORIGIN}/people`, focused: true },
    ]
    expect(tapTarget('ann@x.example', windows, ORIGIN)).toEqual({ kind: 'focus', index: 5, path: '/inbox/ann%40x.example' })
    expect(tapTarget('ann@x.example', windows.slice(0, 5), ORIGIN)).toEqual({ kind: 'focus', index: 4, path: '/inbox/ann%40x.example' })
    expect(tapTarget('ann@x.example', windows.slice(0, 4), ORIGIN)).toEqual({ kind: 'open', url: '/inbox/ann%40x.example' })
    expect(isAppWindow('not a url', ORIGIN)).toBe(false)
    // The Forms tab's screens are pages of the space now (no frame), so a window on one is brought forward; forms' API and logos are not pages.
    expect(isAppWindow(`${ORIGIN}/forms/envelopes/e1`, ORIGIN)).toBe(true)
    expect(isAppWindow(`${ORIGIN}/forms/logo/c1`, ORIGIN)).toBe(false)
  })

  test('a path the worker asks the page to open is the space’s own: never another site’s, a protocol-relative address or a script', () => {
    expect(safePath('/inbox/a%40b.example')).toBe(true)
    for (const bad of ['https://evil.example/', '//evil.example/', 'javascript:alert(1)', '/\\evil.example', '', 7, null, undefined]) expect([String(bad), safePath(bad)]).toEqual([String(bad), false])
  })
})

describe('what Settings says about this browser', () => {
  const device = (over: Partial<InboxDevice> = {}): InboxDevice => ({
    id: 'd1',
    label: 'Chrome on Android',
    origin: 'space',
    endpoint: 'https://fcm.googleapis.com/fcm/send/mine',
    addedAt: 1,
    lastDeliveredAt: null,
    lastFailedAt: null,
    lastFailure: null,
    refused: false,
    delivered: 0,
    failed: 0,
    ...over,
  })
  const KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
  const facts = (over: Partial<BrowserFacts> = {}): BrowserFacts => ({
    supported: true,
    permission: 'granted',
    notifications: { publicKey: KEY, devices: [device()] },
    thisBrowser: { endpoint: device().endpoint, key: KEY },
    ...over,
  })

  test('each state, in the order it is checked', () => {
    expect(browserState(facts()).state).toBe('on')
    expect(browserState(facts({ supported: false })).state).toBe('unsupported')
    expect(browserState(facts({ permission: 'denied' })).state).toBe('blocked')
    expect(browserState(facts({ notifications: { publicKey: null, devices: [] } })).state).toBe('no-key')
    expect(browserState(facts({ thisBrowser: { endpoint: device().endpoint, key: 'another-key' } })).state).toBe('stale-key')
    expect(browserState(facts({ thisBrowser: null })).state).toBe('off')
    // The inbox does not list this browser (removed from another device): off, though the browser still holds its address.
    expect(browserState(facts({ notifications: { publicKey: KEY, devices: [] } })).state).toBe('off')
    expect(browserState(facts({ notifications: { publicKey: KEY, devices: [device({ lastFailedAt: 5, lastDeliveredAt: 2, lastFailure: 'down' })] } })).state).toBe('failing')
    expect(browserState(facts()).device?.id).toBe('d1')
  })

  test('an iPhone or iPad in a Safari tab is told how to add the space to the Home Screen; the app added to it, with push, is a browser like any other', () => {
    const tab = { supported: false, permission: 'default' as const, thisBrowser: null, apple: { device: 'iPhone' as const, installed: false } }
    expect(browserState(facts(tab)).state).toBe('add-to-home-screen')
    expect(browserState(facts({ ...tab, apple: { device: 'iPad', installed: false } })).state).toBe('add-to-home-screen')
    // Installed and still no push: before iOS 16.4, which no page can fix.
    expect(browserState(facts({ ...tab, apple: { device: 'iPhone', installed: true } })).state).toBe('unsupported')
    // Anywhere else without push is as it was.
    expect(browserState(facts({ ...tab, apple: null })).state).toBe('unsupported')
    expect(browserState(facts({ supported: false })).state).toBe('unsupported')
    // Installed, with push: the same states as every browser.
    const app = { apple: { device: 'iPhone' as const, installed: true } }
    expect(browserState(facts({ ...app, permission: 'default', thisBrowser: null, notifications: { publicKey: KEY, devices: [] } })).state).toBe('off')
    expect(browserState(facts({ ...app, permission: 'denied' })).state).toBe('blocked')
    expect(browserState(facts({ ...app })).state).toBe('on')
  })

  test('a device has stopped when its last failure came after its last delivery', () => {
    expect(failing({ lastFailedAt: null, lastDeliveredAt: 3 })).toBe(false)
    expect(failing({ lastFailedAt: 5, lastDeliveredAt: 3 })).toBe(true)
    expect(failing({ lastFailedAt: 2, lastDeliveredAt: 3 })).toBe(false)
    expect(failing({ lastFailedAt: 2, lastDeliveredAt: null })).toBe(true)
  })

  test('the inbox’s key is taken only as exactly the 65 bytes of a P-256 point', () => {
    expect(serverKey(KEY)?.length).toBe(65)
    for (const bad of ['', 'short', 'not base64!', `${KEY}AA`]) expect([bad, serverKey(bad)]).toEqual([bad, null])
  })

  test('devices are listed this one first, the space’s next, and the inbox’s still to be moved last', () => {
    const list = [device({ id: 'old', origin: 'inbox', addedAt: 1 }), device({ id: 'other-space', addedAt: 2 }), device({ id: 'mine', addedAt: 3 })]
    expect(ordered(list, 'mine').map((d) => d.id)).toEqual(['mine', 'other-space', 'old'])
  })
})
