// Settings: the menu of what the inbox's own page had that the Inbox tab does not, in the space: notifications, Claude's sending, the mailboxes and the
// spam check with the Gmail connection, the Google calendars, Clients, and restore. Each is one section of the menu, a path of its own (`/settings/<section>`).
//
// Everything on it is the owner's, and the inbox decides that: the space carries each question with the owner's assertion, the inbox admits its owner only, and Claude's
// sending switch, the spam check and restore are the owner's in the inbox's store as well. (The knowledge base is the Knowledge tab's.) Nothing here sends mail.
import { type MouseEvent, type ReactNode, useState } from 'react'
import { GMAIL_ACCOUNT_PARAM, GMAIL_START_PATH, type InboxBusinessMailbox, type InboxClaudeSending, type InboxGmail, type InboxJmap, type InboxMailboxes, type InboxTelegram } from '@space/workspace'
import type { Me } from '../me'
import { CalendarsSection } from './CalendarsSettings'
import { CallsSection, PhoneSection } from './CallsSettings'
import { ChatSection } from './ChatSettings'
import { Clients } from './ClientsView'
import { NotificationsSection } from './Notifications'
import { Restore } from './Restore'
import { Glyph } from './icons'
import { sectionHeld, settingsPath, settingsSection, SECTIONS, type SectionId } from './route'
import { useSwitches } from './switches'
import { telegramWords } from './telegram'
import { useOwner } from './owner'
import { agoText, Ask, Block, Done, Say, Switch, useAction, Viewed, when, whoText } from './settings-parts'
import { postView, useView } from './views'

type Go = (path: string) => void

// ── Claude's sending ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ── CLAUDE'S SENDING ────────────────────────────────────────────────────
 * Only the owner can flip the switch (the inbox refuses anyone else, and so does its store); this page is the owner's. It starts off, and says so. Off, Claude still drafts: it
 * writes what it means to say, the owner reads it and presses Send. On, when the owner tells Claude to send ("send it", in a session with Claude), it sends a stored draft from
 * the owner's address (tessa@northfield.example) with no further step. Turning it on asks once, in the page, and says what the owner is accepting; turning it off does not ask, because pulling back is
 * never the risky direction.
 */
export function ClaudeSendingPanel({ state, busy, asking, onChange, onAsk, onCancel }: { state: InboxClaudeSending; busy: boolean; asking: boolean; onChange(enabled: boolean): void; onAsk(): void; onCancel(): void }) {
  const owner = useOwner()
  const changed = state.changedAt ? `, changed ${when(state.changedAt)}` : ''
  return (
    <div className={`s-card${state.enabled ? ' amber' : ''}`} data-testid="claude-sending" data-on={state.enabled}>
      <div className="s-switchrow">
        <Switch on={state.enabled} label="Claude may send on my instruction" busy={busy} onChange={(next) => (next ? onAsk() : onChange(false))} testid="claude-switch" />
        <div>
          <p className="s-lead">Claude may send on my instruction</p>
          {state.enabled ? (
            <>
              <p>
                <b>Claude’s sending is ON{changed}.</b> When you tell Claude to send (“send it”, in a session with Claude), it sends a draft already stored in the inbox from{' '}
                {owner.address}, with no further step here, and records your instruction on the message. With no instruction from you it never sends.
              </p>
              <p className="sub">Turning it off stops Claude’s next send. It cannot stop one that Gmail has already been asked for: that message goes out, and its instruction is on it in its conversation.</p>
            </>
          ) : (
            <p>
              <b>Claude’s sending is OFF{changed}.</b> That is how it starts, so you turn it on deliberately. Claude still drafts, so you can see what it means to say, and you press Send. Turn it on and
              Claude can send a stored draft when you tell it to; you can turn it off again at any time and it keeps drafting.
            </p>
          )}
        </div>
      </div>
      {!state.enabled && asking && (
        <Ask question="Let Claude send email as you?" yes="Yes, turn Claude’s sending on" busy={busy} onYes={() => onChange(true)} onNo={onCancel}>
          <p>
            Once it is on, a message can go out in your name on a “send it” without you seeing its final text here, and a mistake reaches the recipient before you can stop it. Every message Claude sends
            carries your instruction, as Claude recorded it, in its conversation.
          </p>
        </Ask>
      )}
    </div>
  )
}

function ClaudeSendingSection() {
  const view = useView<InboxClaudeSending>('claude-sending')
  const action = useAction()
  const [asking, setAsking] = useState(false)
  const change = async (enabled: boolean) => {
    const ok = await action.run(() => postView<InboxClaudeSending>('claude-sending', { enabled }), enabled ? 'Claude may now send on your instruction.' : 'Claude can only draft now.')
    setAsking(false)
    view.reload()
    return ok
  }
  return (
    <Block title="Claude’s sending" testid="section-claude">
      <Viewed view={view.state} problem={view.problem} reload={view.reload} loading="Loading Claude’s sending">
        {(state) => <ClaudeSendingPanel state={state} busy={action.busy} asking={asking} onChange={(e) => void change(e)} onAsk={() => setAsking(true)} onCancel={() => setAsking(false)} />}
      </Viewed>
      {action.say && <Say say={action.say} />}
      <Done text={action.done} />
    </Block>
  )
}

// ── Mailboxes, the spam check, Gmail ──────────────────────────────────────────────────────────────────────────────────────

const STATE_TEXT: Record<InboxGmail['state'], string> = {
  disconnected: 'Disconnected',
  lapsed: 'Sign-in ended: connect it again',
  filling: 'Reading in the last 30 days',
  resyncing: 'Catching up after a gap',
  live: 'Live',
}

/** Where Connect Gmail goes: with nothing, a new account (Google asks which); with an account's id, that account again (Google is hinted to offer it first). */
export const gmailStart = (id?: string): string => (id === undefined ? GMAIL_START_PATH : `${GMAIL_START_PATH}?${GMAIL_ACCOUNT_PARAM}=${encodeURIComponent(id)}`)

/**
 * One Gmail account: whether the inbox is hearing from it, and the only buttons that change it. Connecting is a link to the space's own path (Google returns to the space's, gmail.ts), not a call.
 * A LAPSED account (Google no longer accepts its sign-in: a Google app in testing mode ends every grant after 7 days) is said so in the card's own first line, by name, with Connect again as the
 * one thing to do; it never reads as an ordinary error.
 */
export function GmailAccountCard({
  account,
  now,
  busy,
  sure,
  onSync,
  onAskDisconnect,
  onDisconnect,
  onKeep,
}: {
  account: InboxGmail
  now: number
  busy: boolean
  sure: boolean
  onSync(): void
  onAskDisconnect(): void
  onDisconnect(): void
  onKeep(): void
}) {
  const lapsed = account.state === 'lapsed'
  if (!account.connected) {
    return (
      <section className="s-card amber" aria-label={`${account.address} Gmail account`} data-testid="gmail" data-id={account.id} data-state="disconnected">
        <h3 className="s-sub">{account.address}</h3>
        <p>Disconnected. Mail that arrived meanwhile is caught up when it is connected again.</p>
        <div className="s-actions">
          <a className="btn primary" href={gmailStart(account.id)} data-testid="reconnect-gmail">
            Connect again
          </a>
        </div>
      </section>
    )
  }
  return (
    <section className={`s-card${account.reasons.length > 0 ? ' amber' : ''}`} aria-label={`${account.address} Gmail account`} data-testid="gmail" data-id={account.id} data-state={account.state}>
      <h3 className="s-sub">{account.address}</h3>
      {lapsed &&
        account.reasons.map((r) => (
          <p key={r} className="s-warn" role="alert" data-testid="gmail-lapsed">
            {r}
          </p>
        ))}
      <dl className="s-facts">
        <dt>Shown on mail as</dt>
        <dd>{account.name}</dd>
        <dt>State</dt>
        <dd>{STATE_TEXT[account.state]}</dd>
        {lapsed ? (
          <>
            <dt>Sign-in ended</dt>
            <dd>{account.lapsedAt ? when(account.lapsedAt) : 'unknown'}</dd>
          </>
        ) : (
          <>
            <dt>Last push</dt>
            <dd>{agoText(now, account.lastPushAt)}</dd>
            <dt>Last sync</dt>
            <dd>{agoText(now, account.lastSyncAt)}</dd>
            <dt>Live connection ends</dt>
            <dd>{account.watchExpiry ? when(account.watchExpiry) : 'not set up'}</dd>
          </>
        )}
        <dt>Held here</dt>
        <dd>
          {account.messages} messages in {account.conversations} conversations
        </dd>
        <dt>In Gmail’s Inbox</dt>
        <dd>
          {account.open} conversations, {account.unreadOpen} unread
        </dd>
      </dl>
      {!lapsed &&
        account.reasons.map((r) => (
          <p key={r} className="s-warn" role="status">
            {r}
          </p>
        ))}
      {sure ? (
        <Ask question={`Disconnect ${account.address}?`} yes="Yes, disconnect" no="Keep it" danger busy={busy} onYes={onDisconnect} onNo={onKeep}>
          <p>The inbox stops receiving this account’s mail and the permission is withdrawn at Google. It takes a sign-in to connect again; mail that arrives meanwhile is caught up then. Its mail already here stays.</p>
        </Ask>
      ) : (
        <div className="s-actions">
          {!lapsed && (
            <button type="button" className="btn" disabled={busy} onClick={onSync} data-testid="sync-gmail">
              Sync now
            </button>
          )}
          <a className={`btn${lapsed ? ' primary' : ''}`} href={gmailStart(account.id)} data-testid="reconnect-gmail">
            Connect again
          </a>
          <button type="button" className="btn danger" disabled={busy} onClick={onAskDisconnect} data-testid="disconnect-gmail">
            Disconnect
          </button>
        </div>
      )}
    </section>
  )
}

/** The Gmail accounts: one card each, and Connect Gmail, which adds another. */
export function GmailAccounts({
  accounts,
  now,
  busy,
  sureId,
  onSync,
  onAskDisconnect,
  onDisconnect,
  onKeep,
}: {
  accounts: readonly InboxGmail[]
  now: number
  busy: boolean
  /** The account the person is being asked about disconnecting, or null. */
  sureId: string | null
  onSync(id: string): void
  onAskDisconnect(id: string): void
  onDisconnect(id: string): void
  onKeep(): void
}) {
  const lapsed = accounts.filter((a) => a.connected && a.state === 'lapsed')
  return (
    <div data-testid="gmail-accounts" data-count={accounts.length}>
      {lapsed.length > 0 && (
        <p className="s-warn" role="alert" data-testid="gmail-lapsed-summary">
          {lapsed.length === 1 ? `${lapsed[0]?.address} needs to be connected again.` : `${lapsed.map((a) => a.address).join(', ')} need to be connected again.`}
        </p>
      )}
      {accounts.length === 0 && (
        <div className="s-card amber" data-testid="gmail" data-connected="false">
          <p>
            Gmail has never been connected. Connecting reads the account you sign in with at Google and keeps the inbox in step with it. Google will ask for permission to manage your mail in Gmail, and to read your calendars. The mail permission can read, organize and send
            your mail and move it to the trash; Google offers no narrower one that also lets the inbox mark mail read and archive it. The calendar permission only reads. The inbox itself uses it only to read mail, to mark a conversation read when you open it, to archive or
            unarchive one when you press Close or Reopen, and to send what you press Send on.
          </p>
        </div>
      )}
      {accounts.map((account) => (
        <GmailAccountCard
          key={account.id}
          account={account}
          now={now}
          busy={busy}
          sure={sureId === account.id}
          onSync={() => onSync(account.id)}
          onAskDisconnect={() => onAskDisconnect(account.id)}
          onDisconnect={() => onDisconnect(account.id)}
          onKeep={onKeep}
        />
      ))}
      <div className="s-actions">
        <a className="btn primary" href={gmailStart()} data-testid="connect-gmail">
          Connect Gmail
        </a>
        <span className="sub">{accounts.length === 0 ? 'Sign in with the account to read.' : 'Connect another account: sign in with it at Google.'} Any Gmail or Google Workspace address works.</span>
      </div>
    </div>
  )
}

/** One business mailbox: every number the owner checks it by, each reason it gives for a look, and the spam check's switch. */
export function MailboxCard({ box, assistantKey, now, busy, onSwitch }: { box: InboxBusinessMailbox; assistantKey: boolean; now: number; busy: boolean; onSwitch(enabled: boolean): void }) {
  const a = box.spamCheck
  const self = useOwner().address
  const changed = a.changedBy ? `Switched by ${whoText(a.changedBy, self)}${a.changedAt ? `, ${when(a.changedAt)}` : ''}.` : 'As the deploy config set it: nobody has used the switch.'
  return (
    <section className={`s-card${box.reasons.length > 0 ? ' amber' : ''}`} aria-label={`${box.name} mailbox`} data-testid="mailbox" data-id={box.id}>
      <h3 className="s-sub">{box.name} mailbox</h3>
      <dl className="s-facts">
        <dt>Mailbox</dt>
        <dd>{box.address}</dd>
        <dt>Last mail arrived</dt>
        <dd>{box.lastArrivalAt ? `${agoText(now, box.lastArrivalAt)} (${when(box.lastArrivalAt)})` : 'never'}</dd>
        <dt>Held here</dt>
        <dd>
          {box.messages} messages in {box.conversations} conversations
        </dd>
        <dt>In its view</dt>
        <dd>
          {box.open} conversations, {box.unreadOpen} unread
        </dd>
        <dt>Last filing error</dt>
        <dd>{box.lastFilingError ?? 'none'}</dd>
      </dl>
      {box.reasons.map((r) => (
        <p key={r} className="s-warn" role="status">
          {r}
        </p>
      ))}
      <div className="s-switchrow s-ruled">
        <Switch on={a.enabled} label={`The spam check works on ${box.name}’s mail`} busy={busy} onChange={onSwitch} testid="spam-switch" />
        <div>
          <p className="s-lead">The spam check works on {box.name}’s mail</p>
          {a.enabled ? (
            <p>
              <b>The spam check is ON.</b> Each message that arrives, apart from a Client’s and what the Bulk rules already catch, is put to Cloudflare’s Clef model. At the model’s threshold or above it goes to Bulk, marked Spam, kept and never
              deleted, and you can move it back. Everything else is in your Inbox and tells you once.
            </p>
          ) : (
            <p>
              <b>The spam check is OFF.</b> Every message that arrives is in your Inbox and tells you as it arrives, except what the Bulk rules catch (an unsubscribe header, an automated sender).
            </p>
          )}
          <p className="sub">{changed}</p>
          <p className="sub">
            {a.judged} {a.judged === 1 ? 'message has' : 'messages have'} been judged so far.
          </p>
        </div>
      </div>
      {!assistantKey && (
        <p className="s-warn" role="status">
          The inbox has no key for the assistant, so the draft chat cannot write a reply. The spam check does not use it.
        </p>
      )}
    </section>
  )
}

/**
 * The Telegram bridge, as a card like a Gmail account's: the one sentence for where it stands (the same one the menu's foot says, `telegramWords`), amber when it needs a look, and the numbers
 * the owner checks it by. Nothing here changes it: the bridge runs outside the space, and signing in again is done where it runs (the bridge's own README).
 */
export function TelegramCard({ telegram, now, zone }: { telegram: InboxTelegram; now: number; zone?: string }) {
  const words = telegramWords(telegram, now, zone)
  return (
    <section className={`s-card${words.amber ? ' amber' : ''}`} aria-label="Telegram" data-testid="telegram" data-state={telegram.state}>
      <p className={words.amber ? 's-warn' : undefined} role="status" data-testid="telegram-words">
        {words.text}
      </p>
      <dl className="s-facts">
        <dt>Account</dt>
        <dd>Telegram user {telegram.address}</dd>
        <dt>Last message arrived</dt>
        <dd>{telegram.lastPushAt ? `${agoText(now, telegram.lastPushAt)} (${when(telegram.lastPushAt)})` : 'never'}</dd>
        <dt>Bridge last checked in</dt>
        <dd>{telegram.checkedInAt ? `${agoText(now, telegram.checkedInAt)} (${when(telegram.checkedInAt)})` : 'never'}</dd>
        <dt>Held here</dt>
        <dd>
          {telegram.messages} messages in {telegram.conversations} conversations
        </dd>
        <dt>In its view</dt>
        <dd>
          {telegram.open} conversations, {telegram.unreadOpen} unread
        </dd>
      </dl>
      <p className="sub">Your chats with people come in, and so do your groups (one row each, under the group’s name; it rings only when a message mentions you or replies to you) and the channels you follow (filed in Bulk). A chat you archived in Telegram came in closed; Telegram’s own read marks and folders are not changed from here.</p>
    </section>
  )
}

/** What each state of a mailbox on the mail server is called on its card. */
const JMAP_STATE_TEXT: Record<InboxJmap['state'], string> = {
  live: 'Live',
  filling: 'Reading in the last 30 days of mail',
  resyncing: 'Catching up (the inbox lost its place and is reading a window again)',
  refused: 'The mail server refused the space’s key',
  unreachable: 'The mail server did not answer',
  undeclared: 'No longer declared in the deploy: kept, not synced',
  'no-credential': 'The Worker holds no key for it',
}

const JMAP_PUSH_TEXT: Record<InboxJmap['push'], string> = {
  live: 'On: the server calls the inbox when mail arrives',
  waiting: 'Asked for, not yet confirmed by the server',
  off: 'Off: mail arrives when the daily pass runs',
}

/**
 * A mailbox on the install's own mail server, as a card like a Gmail account's: whether it is live, still reading in, refused (the server will not take the space's key) or
 * unreachable (and since when), when it last synced and was told of mail, the numbers the owner checks it by, each reason it gives for a look, and Sync now. Nothing here connects or disconnects it: it is
 * declared in the deploy, and its key is a secret of the Worker, never shown. Refused is not retried; a deploy that changes the key ends it.
 */
export function JmapCard({ box, now, busy, onSync }: { box: InboxJmap; now: number; busy: boolean; onSync(): void }) {
  const refused = box.state === 'refused'
  const attention = box.reasons.length > 0 || box.state === 'unreachable'
  return (
    <section className={`s-card${attention ? ' amber' : ''}`} aria-label={`${box.name} mailbox on the mail server`} data-testid="jmap" data-id={box.id} data-state={box.state}>
      <h3 className="s-sub">{box.name} mailbox</h3>
      <dl className="s-facts">
        <dt>Mailbox</dt>
        <dd>{box.address}</dd>
        <dt>State</dt>
        <dd data-testid="jmap-state">{JMAP_STATE_TEXT[box.state]}</dd>
        {refused && (
          <>
            <dt>Key refused</dt>
            <dd>{box.refusedAt ? when(box.refusedAt) : 'unknown'}</dd>
          </>
        )}
        {box.state === 'unreachable' && box.lastErrorAt !== null && (
          <>
            <dt>Not answering since</dt>
            <dd data-testid="jmap-since">{`${agoText(now, box.lastErrorAt)} (${when(box.lastErrorAt)})`}</dd>
          </>
        )}
        <dt>Last mail told of</dt>
        <dd>{agoText(now, box.lastPushAt)}</dd>
        <dt>Last sync</dt>
        <dd>{agoText(now, box.lastSyncAt)}</dd>
        <dt>Push from the server</dt>
        <dd>{JMAP_PUSH_TEXT[box.push]}</dd>
        <dt>Held here</dt>
        <dd>
          {box.messages} messages in {box.conversations} conversations
        </dd>
        <dt>In its Inbox</dt>
        <dd>
          {box.open} conversations, {box.unreadOpen} unread
        </dd>
      </dl>
      {box.reasons.map((r) => (
        <p key={r} className="s-warn" role="status">
          {r}
        </p>
      ))}
      {box.state === 'unreachable' && box.lastError !== null && !box.reasons.some((r) => r.includes(box.lastError as string)) && (
        <p className="s-warn" role="status">
          {box.lastError}
        </p>
      )}
      {box.declared && !refused && (
        <div className="s-actions">
          <button type="button" className="btn" disabled={busy} onClick={onSync} data-testid="sync-jmap">
            Sync now
          </button>
        </div>
      )}
    </section>
  )
}

function MailboxesSection({ me }: { me: Me }) {
  // Gmail is a switch: an install without it has no Gmail account to connect, and the section says nothing of one.
  const switches = useSwitches()
  const view = useView<InboxMailboxes>('mailboxes')
  const action = useAction()
  const [sureId, setSureId] = useState<string | null>(null)
  const now = Date.now()
  // Only once the inbox has answered and the bridge has said anything: before that there is no card, and while the mailboxes load the other sections say so.
  const telegram = view.state.kind === 'value' ? (view.state.value.telegram ?? null) : null
  // Likewise the mailboxes on the mail server: no card at all until the deploy declares one (and none from an inbox that predates them).
  const jmap = view.state.kind === 'value' ? (view.state.value.jmap ?? []) : []
  const spam = async (box: InboxBusinessMailbox, enabled: boolean) => {
    await action.run(() => postView('spam-check', { mailboxId: box.id, enabled }), enabled ? `The spam check works on ${box.name}’s mail again.` : `The spam check is off. ${box.name}’s mail still arrives, all of it in your Inbox.`)
    view.reload()
  }
  const syncJmap = async (box: InboxJmap) => {
    await action.run(() => postView<{ change: string; revoked: boolean | null }>('gmail', { change: 'sync', mailboxId: box.id }), `Asked the mail server what changed in ${box.name}. Read this page again in a moment.`)
    view.reload()
  }
  const gmail = async (change: 'sync' | 'disconnect', mailboxId: string) => {
    await action.run(
      () => postView<{ change: string; revoked: boolean | null }>('gmail', { change, mailboxId }),
      (r) => (change === 'sync' ? 'Asked Gmail what changed. Read this page again in a moment.' : r.revoked ? 'Disconnected, and the permission is withdrawn at Google.' : 'Disconnected here, but Google did not confirm withdrawing the permission. Remove it at myaccount.google.com, Security, Third-party access.'),
    )
    setSureId(null)
    view.reload()
  }
  return (
    <>
      <Block title="Mailboxes and the spam check" testid="section-mailboxes">
        <Viewed view={view.state} problem={view.problem} reload={view.reload} loading="Loading the mailboxes">
          {(m) => (
            <>
              {m.mailboxes.length === 0 && <p className="sub">The inbox holds no business mailbox yet.</p>}
              {m.mailboxes.map((box) => (
                <MailboxCard key={box.id} box={box} assistantKey={m.assistantKey} now={now} busy={action.busy} onSwitch={(e) => void spam(box, e)} />
              ))}
            </>
          )}
        </Viewed>
      </Block>
      {jmap.length > 0 && (
        <Block title="Mailboxes on the mail server" testid="section-jmap">
          {jmap.map((box) => (
            <JmapCard key={box.id} box={box} now={now} busy={action.busy} onSync={() => void syncJmap(box)} />
          ))}
          <p className="sub">These are {me.company.name}’s own mail server’s: the same mail in a mail app and here, with read marks and Close kept the same both ways, and replies sent through the server so they are in the mailbox’s Sent. The space’s key opens that one mailbox and nothing else.</p>
        </Block>
      )}
      {telegram && (
        <Block title="Telegram" testid="section-telegram">
          <TelegramCard telegram={telegram} now={now} />
        </Block>
      )}
      {switches.gmail && (
        <Block title="Gmail accounts" testid="section-gmail">
          <Viewed view={view.state} loading="Loading the connections">
            {(m) => (
              <GmailAccounts
                accounts={m.gmailAccounts}
                now={now}
                busy={action.busy}
                sureId={sureId}
                onSync={(id) => void gmail('sync', id)}
                onAskDisconnect={setSureId}
                onDisconnect={(id) => void gmail('disconnect', id)}
                onKeep={() => setSureId(null)}
              />
            )}
          </Viewed>
          {action.say && <Say say={action.say} />}
          <Done text={action.done} />
        </Block>
      )}
      {!switches.gmail && action.say && <Say say={action.say} />}
      {!switches.gmail && <Done text={action.done} />}
    </>
  )
}

// ── The menu and its sections ─────────────────────────────────────────────────────────────────────────────────────────────

function Section({ id, me, pathname, go }: { id: SectionId; me: Me; pathname: string; go: Go }) {
  switch (id) {
    case 'notifications':
      return <NotificationsSection />
    case 'claude':
      return <ClaudeSendingSection />
    case 'mailboxes':
      return <MailboxesSection me={me} />
    case 'calendars':
      return <CalendarsSection go={go} />
    case 'clients':
      return <Clients pathname={pathname} go={go} />
    case 'chat':
      return <ChatSection />
    case 'calls':
      return <CallsSection />
    case 'phone':
      return <PhoneSection />
    case 'restore':
      return <Restore />
  }
}

function follow(e: MouseEvent<HTMLAnchorElement>, path: string, go: Go): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  go(path)
}

/** The Settings screen: the menu, and the section the path is on. Pure drawing apart from what each section reads. */
export function Settings({ me, pathname, go }: { me: Me; pathname: string; go: Go }): ReactNode {
  const held = (id: SectionId) => sectionHeld(id, me.switches, me.tabs)
  // A section whose part the install does not have is not in the menu and is not found at its address either.
  const named = settingsSection(pathname)
  const found = named !== null && held(named) ? named : null
  // A path that names no section is not Notifications: it says so, with the menu beside it.
  const section: SectionId = found ?? 'notifications'
  return (
    <div className="settings" data-testid="settings">
      <nav className="s-menu" aria-label="Settings">
        <h1>Settings</h1>
        <ul>
          {SECTIONS.filter((s) => held(s.id)).map((s) => (
            <li key={s.id}>
              <a href={settingsPath(s.id)} className={found !== null && s.id === section ? 'on' : ''} aria-current={found !== null && s.id === section ? 'page' : undefined} data-section={s.id} onClick={(e) => follow(e, settingsPath(s.id), go)}>
                <Glyph name={s.glyph} size={14} />
                <span>{s.label}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="s-body">
        {found === null ? (
          <section className="s-block" data-testid="settings-not-found">
            <h2 className="s-h">Not found</h2>
            <p className="sub">There is no such page in Settings. Pick one from the menu.</p>
          </section>
        ) : (
          <Section key={section} id={section} me={me} pathname={pathname} go={go} />
        )}
      </div>
    </div>
  )
}
