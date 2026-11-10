// Invented data for a local page (`SPACE_FIXTURES`, src/app.ts): Settings as it looks with Gmail live, two business mailboxes, an inbox device and a
// space device, and Clients. Times are counted back from `now`. Never reached on a deployed address.

import type { InboxBusinessMailbox, InboxClientSummary, InboxJmap, InboxTelegram } from '@space/workspace'
import type { StandInClient, StandInViewState } from './stand-in-views'

const MIN = 60_000

/** The Telegram bridge the fixtures show: live, a bridge that has not checked in for twenty minutes (amber, saying since when), or a login Telegram ended (amber, saying what to do). */
export type TelegramFixture = 'live' | 'late' | 'signed-out'

/** The mailbox on the mail server the fixtures show: live; one the server refused the key of (amber, saying so and that a deploy ends it); one the server is not answering (amber, saying since when). */
export type JmapFixture = 'live' | 'refused' | 'down'

export function fixtureViews(now: number, telegram: TelegramFixture = 'live', jmapFixture: JmapFixture = 'live'): StandInViewState {
  const ago = (minutes: number) => now - minutes * MIN
  const bridge: InboxTelegram = {
    id: 'telegram',
    name: 'Telegram',
    address: '7000000001',
    state: telegram === 'live' ? 'live' : telegram === 'late' ? 'not-checked-in' : 'signed-out',
    reportedAt: ago(telegram === 'live' ? 40 : 60 * 3),
    checkedInAt: telegram === 'live' ? ago(0.5) : ago(telegram === 'late' ? 20 : 60 * 3),
    lastPushAt: ago(telegram === 'live' ? 6 : 60 * 3),
    filled: true,
    messages: 96,
    conversations: 7,
    open: 4,
    unreadOpen: 3,
  }
  const refusedWords = 'The mail server refused the space’s key for test@harborline.example (or Cloudflare Access refused the space’s token at its door), so nothing new arrives or goes out from it. A deploy with a working key ends this.'
  const jmap: InboxJmap = {
    id: 'harborline',
    name: 'harborline',
    address: 'test@harborline.example',
    declared: true,
    state: jmapFixture === 'live' ? 'live' : jmapFixture === 'refused' ? 'refused' : 'unreachable',
    refusedAt: jmapFixture === 'refused' ? ago(50) : null,
    push: jmapFixture === 'live' ? 'live' : 'off',
    lastPushAt: ago(jmapFixture === 'live' ? 4 : 60 * 5),
    lastSyncAt: ago(jmapFixture === 'live' ? 4 : 60 * 5),
    lastError: jmapFixture === 'down' ? 'The mail server could not be reached: Network connection lost.' : jmapFixture === 'refused' ? refusedWords : null,
    lastErrorAt: jmapFixture === 'live' ? null : ago(jmapFixture === 'down' ? 45 : 50),
    messages: 14,
    conversations: 9,
    open: 5,
    unreadOpen: 2,
    reasons: jmapFixture === 'refused' ? [refusedWords] : jmapFixture === 'down' ? ['The mail server did not answer well: The mail server could not be reached: Network connection lost.'] : [],
  }
  const spam = (enabled: boolean, judged: number, changedBy: string | null = null) => ({ enabled, changedAt: changedBy ? ago(60 * 24 * 6) : null, changedBy, judged })
  const mailboxes: InboxBusinessMailbox[] = [
    {
      id: 'ridgeway',
      name: 'Ridgeway Cycles',
      address: 'info@ridgewaycycles.example',
      lastArrivalAt: ago(40),
      lastFilingError: null,
      messages: 212,
      conversations: 96,
      open: 14,
      unreadOpen: 3,
      spamCheck: spam(true, 187, 'tessa@northfield.example'),
      reasons: [],
    },
    {
      id: 'shiftlantern',
      name: 'ShiftLantern',
      address: 'hello@shiftlantern.example',
      lastArrivalAt: ago(60 * 30),
      lastFilingError: 'Could not read one message: it had no sender.',
      messages: 18,
      conversations: 17,
      open: 4,
      unreadOpen: 0,
      spamCheck: spam(false, 0),
      reasons: ['One kept message could not be filed and is not retried any more.'],
    },
  ]
  const client = (id: number, name: string, over: Partial<StandInClient> = {}, summary: Partial<InboxClientSummary> = {}): StandInClient => ({
    summary: { id, name, listed: true, legalEntity: null, contacts: 0, conversations: 0, open: 0, adminUrl: `https://admin.example.test/clients#client-${id}`, archived: false, ...summary },
    contacts: [],
    suggestions: [],
    ...over,
  })
  return {
    claudeSending: { enabled: false, changedAt: null },
    gmailAccounts: [
      {
        id: 'gmail-northfield',
        address: 'tessa@northfield.example',
        name: 'northfield',
        connected: true,
        state: 'live',
        lapsedAt: null,
        sendsByDefault: true,
        lastPushAt: ago(3),
        lastSyncAt: ago(3),
        watchExpiry: now + 60 * 24 * 5 * MIN,
        messages: 4120,
        conversations: 1543,
        open: 31,
        unreadOpen: 6,
        reasons: [],
      },
      {
        // A grant that ended (a Google app in testing mode loses them after 7 days): what Settings and the menu foot must say, by name.
        id: 'gmail-ashgrove',
        address: 'tessa@ashgrove.example',
        name: 'ashgrove',
        connected: true,
        state: 'lapsed',
        lapsedAt: ago(60 * 20),
        lastPushAt: ago(60 * 24 * 7),
        lastSyncAt: ago(60 * 24 * 7),
        watchExpiry: now - 60 * 24 * MIN,
        messages: 212,
        conversations: 96,
        open: 4,
        unreadOpen: 2,
        reasons: ['Google no longer accepts the saved sign-in for tessa@ashgrove.example (a Google app in testing mode loses its grants after 7 days), so nothing new arrives or goes out from it. Connect it again.'],
      },
    ],
    mailboxes,
    telegram: bridge,
    jmap: [jmap],
    assistantKey: true,
    publicKey: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    devices: [
      { id: 'device-inbox', label: 'Chrome on macOS', origin: 'inbox', endpoint: 'https://fcm.googleapis.com/fcm/send/inbox-mac', addedAt: ago(60 * 24 * 12), lastDeliveredAt: ago(55), lastFailedAt: null, lastFailure: null, refused: false, delivered: 38, failed: 0 },
      {
        id: 'device-inbox-phone',
        label: 'Chrome on Android',
        origin: 'inbox',
        endpoint: 'https://fcm.googleapis.com/fcm/send/inbox-phone',
        addedAt: ago(60 * 24 * 12),
        lastDeliveredAt: ago(55),
        lastFailedAt: ago(60 * 24),
        lastFailure: 'The push service did not take the notification (503).',
        refused: false,
        delivered: 41,
        failed: 2,
      },
      { id: 'device-space', label: 'Chrome on macOS', origin: 'space', endpoint: 'https://fcm.googleapis.com/fcm/send/space-mac', addedAt: ago(60 * 2), lastDeliveredAt: ago(55), lastFailedAt: null, lastFailure: null, refused: false, delivered: 3, failed: 0 },
    ],
    current: '00000a1b-0000002c-00004e21-fakebookmark',
    restores: [
      {
        kind: 'restored',
        id: 'r-2',
        at: new Date(ago(60 * 24 * 11)).toISOString(),
        actor: 'tessa@northfield.example',
        target: '00000900-0000001a-00004e21-fakebookmark',
        targetTime: new Date(ago(60 * 24 * 11 + 90)).toISOString(),
        undoBookmark: '00000901-0000001b-00004e21-fakebookmark',
      },
    ],
    clients: [
      client(
        7,
        'Harbor Dental',
        {
          contacts: [
            { contactId: 'c-dana', name: 'Dana Reyes', addresses: ['dana@harbordental.example'] },
            { contactId: 'c-marcus', name: 'Marcus Chen', addresses: ['marcus@harbordental.example'] },
          ],
          suggestions: [{ contactId: 'c-hygienist', name: 'Priyanka Mehta', addresses: ['priyanka@harbordental.example'], reason: 'domain', via: 'harbordental.example' }],
        },
        { legalEntity: 'Harbor Dental Group, Inc.', contacts: 2, conversations: 9, open: 3 },
      ),
      client(
        3,
        'Tamarack Print Supply',
        { contacts: [{ contactId: 'c-nils', name: 'Nils Moore', addresses: ['nils@tamarackprint.example'] }] },
        { legalEntity: 'Tamarack Print Supply Co.', contacts: 1, conversations: 4, open: 0 },
      ),
      client(9, 'Lakeside Print Supply', { contacts: [{ contactId: 'c-rosa', name: 'Rosa Whitfield', addresses: ['rosa_whitfield@yahoo.example'] }] }, { contacts: 1, conversations: 1, open: 1 }),
      client(12, 'Client 12', { contacts: [{ contactId: 'c-old12', name: 'Walt Ibarra', addresses: ['walt@ibarra.example'] }] }, { listed: false, contacts: 1, conversations: 1, open: 0 }),
    ],
    directoryAvailable: true,
  }
}
