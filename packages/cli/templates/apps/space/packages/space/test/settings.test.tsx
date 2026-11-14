// Settings and the draft chat as markup: every state of each screen drawn from a literal answer, and what each says and must never say. What a press does is
// settings-dom.test.tsx, in a DOM. The screens are pure over the inbox's answers (packages/workspace/src/inbox-views.ts), so these need no inbox and no network.
import { describe, expect, test } from 'bun:test'
import type { InboxClaudeSending, InboxDevice, InboxGmail, InboxNotifications } from '@space/workspace'
import { renderToStaticMarkup } from 'react-dom/server'
import { northfield } from '../../workspace/test/helpers'
import { meOf } from '../src/app'
import { fixtureViews } from '../src/fixture-views'
import { DraftChatView, TurnLine } from '../src/client/DraftChat'
import { NotificationsPanel } from '../src/client/Notifications'
import { OwnerContext } from '../src/client/owner'
import { RestorePanel, isoFromLocal } from '../src/client/Restore'
import { ClaudeSendingPanel, GmailAccountCard, GmailAccounts, gmailStart, MailboxCard, Settings } from '../src/client/Settings'
import { SECTIONS, settingsItem, settingsSection } from '../src/client/route'

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const view = fixtureViews(NOW)
const ME = meOf({ address: 'tessa@northfield.example', name: 'Tessa' }, northfield())
const noop = () => undefined
/** Drawn in a shell for Northfield's owner, as the page is: "you" in a switch's history is the owner. */
const html = (node: React.ReactNode) => renderToStaticMarkup(<OwnerContext.Provider value={ME.owner}>{node}</OwnerContext.Provider>)

describe('the Settings menu', () => {
  test('the sections, in order, with the first current at /settings and the one the path names current beneath it', () => {
    expect(SECTIONS.map((s) => s.label)).toEqual(['Notifications', 'Claude’s sending', 'Mailboxes and spam check', 'Calendars', 'Clients', 'Chat', 'Calls', 'Phone', 'Restore'])
    const at = (pathname: string) => {
      const markup = renderToStaticMarkup(<Settings me={ME} pathname={pathname} go={noop} />)
      return [...markup.matchAll(/<a href="([^"]+)" class="on"/g)].map((m) => m[1])
    }
    expect(at('/settings')).toEqual(['/settings/notifications'])
    expect(at('/settings/clients/7')).toEqual(['/settings/clients'])
    expect(at('/settings/restore')).toEqual(['/settings/restore'])
  })

  test('a Settings path that names no section says so, with nothing lit, and is not Notifications', () => {
    for (const pathname of ['/settings/nowhere', '/settings/notificatons', '/settings/x/y']) {
      const markup = renderToStaticMarkup(<Settings me={ME} pathname={pathname} go={noop} />)
      expect([pathname, markup.includes('data-testid="settings-not-found"'), markup.includes('class="on"'), markup.includes('data-testid="section-notifications"') || markup.includes('data-testid="notifications"')]).toEqual([pathname, true, false, false])
      expect(markup).toContain('There is no such page in Settings.')
    }
    expect(renderToStaticMarkup(<Settings me={ME} pathname="/settings" go={noop} />)).not.toContain('settings-not-found')
  })

  test('a path names a section and one thing in it, or nothing', () => {
    expect(settingsSection('/settings')).toBe('notifications')
    expect(settingsSection('/settings/')).toBe('notifications')
    expect(settingsSection('/settings/nowhere')).toBeNull()
    expect(settingsSection('/people')).toBeNull()
    expect(settingsItem('/settings/clients/7/', 'clients')).toBe('7')
    expect(settingsItem('/settings/clients/7/extra', 'clients')).toBeNull()
    expect(settingsItem('/settings/clients', 'clients')).toBeNull()
    expect(settingsItem('/settings/clients/%E0%A4%A', 'clients')).toBeNull()
  })
})

describe('Claude’s sending', () => {
  const state = (enabled: boolean, changedAt: number | null = null): InboxClaudeSending => ({ enabled, changedAt })
  const panel = (s: InboxClaudeSending, asking = false) => html(<ClaudeSendingPanel state={s} busy={false} asking={asking} onChange={noop} onAsk={noop} onCancel={noop} />)

  test('it starts off, and says so; turning it on asks first, in the page, and says what he is accepting', () => {
    const off = panel(state(false))
    expect(off).toContain('Claude’s sending is OFF')
    expect(off).toContain('aria-checked="false"')
    expect(off).not.toContain('data-testid="ask"')
    const asking = panel(state(false), true)
    expect(asking).toContain('Let Claude send email as you?')
    expect(asking).toContain('a mistake reaches the recipient before you can stop it')
    expect(asking).toContain('Yes, turn Claude’s sending on')
  })

  test('on, it says so and what turning it off does not undo, and offers no question: pulling back is never the risky direction', () => {
    const on = panel(state(true, NOW), true)
    expect(on).toContain('Claude’s sending is ON')
    expect(on).toContain('It cannot stop one that Gmail has already been asked for')
    expect(on).toContain('aria-checked="true"')
    expect(on).not.toContain('data-testid="ask"')
  })
})

describe('Notifications', () => {
  const notifications = (devices: InboxDevice[], publicKey: string | null = 'k'): InboxNotifications => ({ publicKey, devices, week: { sent: 12, dropped: 1 } })
  const panel = (over: Partial<Parameters<typeof NotificationsPanel>[0]> & { devices: InboxDevice[] }) => {
    const { devices, ...rest } = over
    return html(<NotificationsPanel state="off" device={null} notifications={notifications(devices)} busy={false} onTurnOn={noop} onTurnOff={noop} onTest={noop} onAskRemove={noop} onRemove={noop} onCancelRemove={noop} {...rest} />)
  }
  const [inboxMac, inboxPhone, spaceMac] = [view.devices[0], view.devices[1], view.devices[2]] as [InboxDevice, InboxDevice, InboxDevice]

  test('while an inbox device is still listed the page says each email arrives twice until it is removed, and lists the steps Tessa does by hand', () => {
    const markup = panel({ devices: view.devices })
    expect(markup).toContain('Moving over from the inbox app.')
    expect(markup).toContain('2 devices are still turned on from the inbox app')
    expect(markup).toContain('arrives twice')
    expect(markup).toContain('add the space to the home screen')
    expect(markup).toContain('remove that device’s old inbox entry')
    expect(markup.match(/data-origin="inbox"/g)).toHaveLength(2)
    expect(markup.match(/data-origin="space"/g)).toHaveLength(1)
    expect(markup).toContain('The inbox app (old)')
  })

  test('once none is left there is nothing to move, and no mention of one', () => {
    const markup = panel({ devices: [spaceMac], state: 'on', device: spaceMac })
    expect(markup).not.toContain('Moving over')
    expect(markup).toContain('This device gets notifications from the space.')
    expect(markup).toContain('data-mine="true"')
    expect(markup).toContain('Send a test')
    expect(markup).toContain('Turn off on this device')
  })

  test('a device is listed this one first, and a Remove on it asks before anything is removed', () => {
    const before = panel({ devices: view.devices, state: 'on', device: spaceMac })
    expect([...before.matchAll(/data-testid="device" data-origin="(\w+)" data-mine="(\w+)"/g)].map((m) => `${m[1]}:${m[2]}`)).toEqual(['space:true', 'inbox:false', 'inbox:false'])
    expect(before).not.toContain('Yes, remove it')
    const asking = panel({ devices: view.devices, state: 'on', device: spaceMac, removing: inboxPhone.id })
    expect(asking).toContain('Remove this inbox app device?')
    expect(asking).toContain('Do this once the space is turned on for that phone or computer.')
    expect(asking).toContain('Yes, remove it')
    expect(asking).toContain('Keep it')
    expect(asking.match(/Yes, remove it/g)).toHaveLength(1) // only for the one asked about
  })

  test('each state of this browser says what it is, and the buttons only where they help', () => {
    expect(panel({ devices: [], state: 'off' })).toContain('Turn on notifications')
    expect(panel({ devices: [], state: 'unsupported' })).not.toContain('data-testid="turn-on"')
    expect(panel({ devices: [], state: 'unsupported' })).toContain('update to iOS or iPadOS 16.4 or later')
    // An iPhone or iPad in a Safari tab is told the steps, by its own name, and offered no button that cannot work there.
    const phone = panel({ devices: [], state: 'add-to-home-screen', apple: 'iPhone' })
    expect(phone).not.toContain('data-testid="turn-on"')
    expect(phone).toContain('on an iPhone need the space added to the Home Screen first')
    expect(phone).toContain('tap the Share button, choose Add to Home Screen')
    expect(panel({ devices: [], state: 'add-to-home-screen', apple: 'iPad' })).toContain('on an iPad need the space added to the Home Screen first')
    expect(panel({ devices: [], state: 'blocked', apple: 'iPhone' })).toContain('open the Settings app, then Notifications, then Space')
    expect(panel({ devices: [], state: 'blocked' })).toContain('blocked for the space on this device')
    expect(panel({ devices: [], state: 'stale-key' })).toContain('Turn notifications on again')
    // A failure the push service did not refuse offers no "turn on again": it would not help.
    expect(panel({ devices: [inboxPhone], state: 'failing', device: { ...inboxPhone, refused: false } })).not.toContain('data-testid="turn-on"')
    expect(panel({ devices: [inboxPhone], state: 'failing', device: { ...inboxPhone, refused: true } })).toContain('data-testid="turn-on"')
  })

  test('with no key nothing is offered and no device is listed, and what no one should see is never drawn: an address of a push service, a key', () => {
    const none = panel({ devices: view.devices, state: 'no-key', notifications: notifications(view.devices, null) })
    expect(none).toContain('Notifications are not set up on the inbox yet')
    expect(none).not.toContain('data-testid="devices"')
    const listed = panel({ devices: view.devices })
    expect(listed).not.toContain('fcm.googleapis.com')
    expect(listed).not.toContain(view.publicKey as string)
  })

  test('the week’s numbers are said, so the first week can be compared', () => {
    expect(panel({ devices: [spaceMac] })).toContain('12 notifications sent, 1 dropped')
    expect(inboxMac.origin).toBe('inbox')
  })
})

describe('the mailboxes, the spam check and Gmail', () => {
  test('a mailbox says every number it is checked by, each reason it gives for a look, and the spam check’s state and who switched it', () => {
    const [ridgeway, rights] = view.mailboxes as [(typeof view.mailboxes)[number], (typeof view.mailboxes)[number]]
    const on = html(<MailboxCard box={ridgeway} assistantKey now={NOW} busy={false} onSwitch={noop} />)
    expect(on).toContain('The spam check is ON.')
    expect(on).toContain('Switched by you')
    expect(on).toContain('187 messages have been judged so far.')
    expect(on).not.toContain('s-warn')
    const off = html(<MailboxCard box={rights} assistantKey={false} now={NOW} busy={false} onSwitch={noop} />)
    expect(off).toContain('The spam check is OFF.')
    expect(off).toContain('As the deploy config set it: nobody has used the switch.')
    expect(off).toContain('One kept message could not be filed')
    expect(off).toContain('The inbox has no key for the assistant, so the draft chat cannot write a reply. The spam check does not use it.')
  })

  test('Gmail: each account with every number; connecting is a link to the space’s own path (Google returns to the space); disconnecting asks, and never draws a token', () => {
    const account = view.gmailAccounts[0] as InboxGmail
    const card = (g: InboxGmail, sure = false) => html(<GmailAccountCard account={g} now={NOW} busy={false} sure={sure} onSync={noop} onAskDisconnect={noop} onDisconnect={noop} onKeep={noop} />)
    const live = card(account)
    expect(live).toContain('tessa@northfield.example')
    expect(live).toContain('Live')
    expect(live).toContain('4120 messages in 1543 conversations')
    expect(live).toContain(`href="/api/inbox/gmail/start?account=${account.id}"`)
    expect(live).toContain('data-testid="sync-gmail"')
    expect(live).not.toContain('inbox.northfield.example')
    expect(live).not.toContain('Yes, disconnect')
    expect(card(account, true)).toContain('Yes, disconnect')
    expect(card(account, true)).toContain('the permission is withdrawn at Google')
    expect(card(account, true)).toContain('Disconnect tessa@northfield.example?')
    expect(live).not.toMatch(/token|secret/i)
    expect(card({ ...account, connected: false, state: 'disconnected' })).toContain('Disconnected.')
    expect(card({ ...account, connected: false, state: 'disconnected' })).toContain('data-testid="reconnect-gmail"')
  })

  test('the accounts: none says it has never been connected; every account is a card and Connect Gmail adds another; the start path takes the account when it is connected again', () => {
    const list = (accounts: InboxGmail[], sureId: string | null = null) => html(<GmailAccounts accounts={accounts} now={NOW} busy={false} sureId={sureId} onSync={noop} onAskDisconnect={noop} onDisconnect={noop} onKeep={noop} />)
    const never = list([])
    expect(never).toContain('Gmail has never been connected.')
    expect(never).toContain('data-testid="connect-gmail"')
    expect(never).toContain('href="/api/inbox/gmail/start"')
    const account = view.gmailAccounts[0] as InboxGmail
    const second: InboxGmail = { ...account, id: 'gm-ashgrove', address: 'tessa@ashgrove.example', name: 'ashgrove' }
    const two = list([account, second], 'gm-ashgrove')
    expect(two.match(/data-testid="gmail"/g)).toHaveLength(2)
    expect(two).toContain('data-count="2"')
    expect(two).toContain('href="/api/inbox/gmail/start"')
    // Only the account being asked about shows the question.
    expect(two.match(/Yes, disconnect/g)).toHaveLength(1)
    expect(two).toContain('Disconnect tessa@ashgrove.example?')
    expect(gmailStart()).toBe('/api/inbox/gmail/start')
    expect(gmailStart('a b')).toBe('/api/inbox/gmail/start?account=a%20b')
  })

  test('a lapsed account says so first, by name and in words, with Connect again as the one thing to do, and no Sync (it would only fail)', () => {
    const account = view.gmailAccounts[0] as InboxGmail
    const sentence = 'Google no longer accepts the saved sign-in for tessa@northfield.example (a Google app in testing mode loses its grants after 7 days), so nothing new arrives or goes out from it. Connect it again.'
    const lapsed: InboxGmail = { ...account, state: 'lapsed', lapsedAt: NOW - 3_600_000, reasons: [sentence] }
    const card = html(<GmailAccountCard account={lapsed} now={NOW} busy={false} sure={false} onSync={noop} onAskDisconnect={noop} onDisconnect={noop} onKeep={noop} />)
    expect(card).toContain('data-state="lapsed"')
    expect(card).toContain('data-testid="gmail-lapsed"')
    expect(card).toContain('role="alert"')
    expect(card).toContain('a Google app in testing mode loses its grants after 7 days')
    expect(card).toContain('Sign-in ended: connect it again')
    expect(card).toContain('btn primary')
    expect(card).not.toContain('data-testid="sync-gmail"')
    const list = html(<GmailAccounts accounts={[lapsed]} now={NOW} busy={false} sureId={null} onSync={noop} onAskDisconnect={noop} onDisconnect={noop} onKeep={noop} />)
    expect(list).toContain('data-testid="gmail-lapsed-summary"')
    expect(list).toContain('tessa@northfield.example needs to be connected again.')
  })
})

describe('restore asks before it acts', () => {
  const report = { current: 'now-bookmark', restores: view.restores, restoresError: null }
  const plan = { target: 'earlier-bookmark', targetTime: '2026-10-20T12:00:00.000Z', token: 'tok', expiresAt: '2026-11-02T12:05:00.000Z' }
  const panel = (over: Partial<Parameters<typeof RestorePanel>[0]> = {}) => html(<RestorePanel report={report} plan={null} done={null} busy={false} onPrepare={noop} onConfirm={noop} onCancel={noop} {...over} />)

  test('the first screen only prepares: there is no button that restores, and it says nothing changes until the next step', () => {
    const first = panel()
    expect(first).toContain('Show what would be restored')
    expect(first).toContain('Nothing changes until you confirm in the next step.')
    expect(first).not.toContain('data-testid="restore-confirm"')
    expect(first).not.toContain('Yes, restore the store')
    expect(first).toContain('Earlier restores')
    expect(first).toContain('Undo with')
  })

  test('the second asks, says what is lost, that sent mail will look unsent, and that Gmail may need connecting again, and only then offers the restore', () => {
    const second = panel({ plan })
    expect(second).toContain('Restore the inbox to')
    expect(second).toContain('Everything since is replaced')
    expect(second).toContain('Messages sent since then will show as unsent drafts again.')
    expect(second).toContain('do not send them a second time')
    expect(second).toContain('Gmail may need reconnecting')
    expect(second).toContain('Yes, restore the store')
    expect(second).toContain('data-testid="restore-cancel"')
    expect(second).not.toContain('Show what would be restored')
  })

  test('after it, the bookmark that undoes it is said, and no second restore is offered from that screen', () => {
    const done = panel({ done: { restoredTo: 'earlier-bookmark', targetTime: null, undoBookmark: 'undo-bookmark' } })
    expect(done).toContain('The store is restarting and comes back as it was at earlier-bookmark.')
    expect(done).toContain('undo-bookmark')
    expect(done).not.toContain('Yes, restore the store')
    expect(done).not.toContain('Show what would be restored')
  })

  test('a time picked is sent as the ISO time with its zone the inbox asks for, and nonsense is no choice', () => {
    expect(isoFromLocal('2026-10-20T09:30')).toMatch(/^2026-10-20T\d\d:30:00\.000Z$/)
    expect(isoFromLocal('')).toBeNull()
    expect(isoFromLocal('yesterday')).toBeNull()
  })
})

describe('the draft chat', () => {
  const turns = [
    { seq: 1, at: NOW, instruction: 'shorter', note: 'Cut it to the first paragraph.', revised: true },
    { seq: 2, at: NOW, instruction: null, note: 'A new message came in over this draft.', revised: false },
  ]

  test('the turns, his words and the assistant’s, whether it changed the draft, and that nothing typed here sends anything', () => {
    const markup = html(<DraftChatView turns={turns} words="" busy={false} onWords={noop} onAsk={noop} />)
    expect(markup).toContain('Nothing typed here sends anything. The draft goes out only by Send.')
    expect(markup).toContain('Cut it to the first paragraph.')
    expect(markup).toContain('Revised the draft')
    expect(markup.match(/data-testid="turn"/g)).toHaveLength(2)
    // A note the assistant left by itself has no words of his.
    expect(markup.match(/<b>You<\/b>/g)).toHaveLength(1)
    expect(markup).toContain('turn-ai own')
  })

  test('Ask is not offered with nothing typed, or while one is being asked', () => {
    const disabled = (markup: string) => /data-testid="chat-ask"/.test(markup) && /<button[^>]*disabled[^>]*data-testid="chat-ask"/.test(markup)
    expect(disabled(html(<DraftChatView turns={[]} words="" busy={false} onWords={noop} onAsk={noop} />))).toBe(true)
    expect(disabled(html(<DraftChatView turns={[]} words="Shorter" busy={false} onWords={noop} onAsk={noop} />))).toBe(false)
    const busy = html(<DraftChatView turns={[]} words="Shorter" busy onWords={noop} onAsk={noop} />)
    expect(disabled(busy)).toBe(true)
    expect(busy).toContain('Asking...')
    expect(html(<TurnLine turn={turns[0] as never} />)).toContain('Revised the draft')
  })
})
