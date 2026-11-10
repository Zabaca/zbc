// One conversation, with a person or a channel: in the Inbox (`scope` `mail`) a person's emails, in Meet (`chat`) a channel
// or a direct message, with the draft waiting for you, the reply box, and their profile beside it (one tap away on a phone). One tab once held both as one history; they are two tabs now.
//
// `ConversationView` is pure: it draws an answer and the state of the compose, and the tests draw it with literal ones. `ConversationPane`
// fetches, keeps the history fresh, marks it read in both apps, and sends. Every send carries a key made once for that message (compose.ts).
import { type ClipboardEvent, Fragment, type KeyboardEvent, type MouseEvent, type Ref, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { InboxRead, InboxSpamResult, MeetDeleted, MeetMessage } from '@space/workspace'
import type { ConversationAnswer, DraftView, ReadOutcome } from '../conversation'
import type { Scope } from '../conversations'
import { type HistorySource, type MailMessage, changeChat, mergeHistory, oldestId, refreshSources, sourceId, sourcesToPage, withEarlierPage } from '../history'
import { byHand } from '../guards'
import type { Me } from '../me'
import { type Fetched, read, write, writeForm } from './api'
import {
  type Compose,
  type Notice as ComposeNotice,
  type Way,
  attached,
  begin,
  canSend,
  detached,
  dismissed,
  filesOf,
  mintKey,
  newCompose,
  choosePicture,
  outcomeFromResponse,
  pastedPicture,
  requestFor,
  settle,
  typed,
  whyNotPicture,
  withoutPicture,
} from './compose'
import { describeClose, describeReopen, isCloseKey, modalOpen, reopenOffer, typingIn, whyNotClosed, withPending } from './close'
import { changes } from './changes'
import { DocumentCard } from './DocumentCard'
import { ProfileFields } from './People'
import { sendFromPath } from './day'
import { DRAFT_BY, type Item, TELEGRAM_HEADING, blocksOf, chosenWay, newLineKey, documentsNotice, partNotices, profileFacts, replyLine, replyTarget, replyWays, senderAddress, senderName, stamp } from './convo'
import { CallCard } from './CallCard'
import { type ChatTools, ChatMessageRow, NewLine, meetOrigin } from './ChatMessage'
import { type CallActions, useCallActions } from './callActions'
import { ChannelPanel } from './Channels'
import { DraftChat } from './DraftChat'
import { DraftEditor } from './DraftEdit'
import { MarkSent, NotSentAfterAll, StuckSend } from './HandWork'
import { AttachFiles, AttachPicture, DeliveryNotes, DraftPicture, MessageFiles } from './Files'
import { spamControl, spamNotice } from './spam'
import { postView } from './views'
import { initials } from './format'
import { withBlock } from './invite'
import { setShownConversation } from './notify'
import { Glyph, TabIcon } from './icons'
import { callPath, follow, inboxPath, meetPath, tabNameOf, tabPathOf } from './route'
import { ScheduleFormView } from './Schedule'

// ── The view ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ViewProps {
  me: Me
  /** Which tab it is drawn in: the Inbox (`mail`, the default) or Meet (`chat`). It names the tab the Back link goes to; Send for signature is the Inbox's. */
  scope?: Scope
  now: number
  answer: ConversationAnswer
  sources: readonly HistorySource[]
  loadingEarlier: boolean
  onEarlier(): void
  /** The way the reply goes, and the thread an email goes in (null: the newest that can be answered). */
  way: Way
  onWay(way: Way): void
  threadId: string | null
  onThread(conversationId: string): void
  compose: Compose
  onText(text: string): void
  /** Files chosen to go with an email reply from a business mailbox's thread, and one taken out again. */
  onAttach?(files: File[]): void
  onDetach?(index: number): void
  /** The ONE picture of a Telegram reply, chosen with Attach picture or pasted, and taken out again. */
  onPicture?(file: File): void
  onTakeOutPicture?(): void
  onSend(): void
  /** Send the email, then close the thread it went in (the inbox's "Send and close"). Only offered for an email in a thread that is open. */
  onSendAndClose(): void
  onDismiss(): void
  /** The drafts that have been pressed, by id: their key, and what became of them. */
  drafts: Readonly<Record<string, Compose>>
  onSendDraft(draft: DraftView): void
  onDismissDraft(id: string): void
  /** The assistant revised a draft (or refused to): the conversation is read again, so the card shows it as it is now. */
  onDraftChanged(): void
  /** Close the open email threads on screen. The button is there only when the answer names some (a row that is only chat has none). */
  onClose(): void
  /** Reopen: offered on a conversation opened from the Closed view (one thread, named on the button), and right after a close made here (exactly what that close closed). */
  onReopen(press?: { detail?: number }): void
  reopen: { label: string; title: string } | null
  /** A call that cannot be queued behind a close (Mark as spam) is with the inbox: the buttons wait. A Close or Reopen never makes them wait; it is shown at once and made behind. */
  changing: boolean
  /** How the last close or reopen ended (or, until the inbox answers, what it is hoped to say), under the header. */
  changed: ComposeNotice | null
  /** Closes and reopens of THIS conversation that the inbox refused or failed, each told as it was, under it, with a way to put it away. */
  problems?: readonly { seq: number; notice: ComposeNotice }[]
  onDismissProblem?(seq: number): void
  profileOpen: boolean
  onProfile(open: boolean): void
  onBack(e: MouseEvent<HTMLAnchorElement>): void
  /** Call an email thread spam, or not (the inbox's Mark as spam and Move to the Inbox). Absent where the page offers none (a test that draws the conversation alone). */
  onSpam?(conversationId: string, spam: boolean): void
  /** A spam call is with the inbox: its buttons wait. */
  spamming?: boolean
  /** A time zone, for a test; a person's own is the default. */
  timeZone?: string
  /** The timeline's element, so the pane can keep the newest message in view. */
  timelineRef?: Ref<HTMLDivElement>
  /** What can be done with calls here (a huddle, a call link, a meeting); absent where the page offers none (a test that draws the conversation alone). */
  calls?: CallActions
  /** Open a call's own screen (its saved chat). */
  onOpenCall?(name: string): void
  /** A channel's people and what can be done with the channel (Channels.tsx), beside it; absent where the page offers none (a test that draws the conversation alone). */
  channel?: { go(path: string): void; onChanged(): void }
  /** Chat messages with links, Edit and Delete (ChatMessage.tsx); absent where the page offers none (a test that draws the conversation alone), and chat is then plain text. */
  chat?: ChatTools & {
    /** Where "New" begins (the id of the first message that was unread when the conversation was opened), kept by the pane for as long as it stays open; null for none. */
    newFrom: number | null
  }
}

export function Mark({ name, kind }: { name: string; kind: 'channel' | 'team' | 'outside' }) {
  if (kind === 'channel') {
    return (
      <span className="avatar-lg channel" data-mark="channel" aria-hidden="true">
        <Glyph name="hash" size={14} />
      </span>
    )
  }
  const letters = initials(name)
  return (
    <span className={`avatar-lg ${kind}`} aria-hidden="true">
      {letters || <Glyph name="person" size={14} />}
    </span>
  )
}

/** The bracketed words a photo, voice note, image, video or file arrives with when it has no caption. */
const PLACEHOLDER = /^\[(Photo|Voice note|Image|Video|File)\]$/
/** The bracketed words any Telegram message with no text carries ("[Video]", "[Voice note]", "[Location]"): short, fixed, and never to be broken across lines. */
const BRACKETED = /^\[[A-Za-z ]{2,20}\]$/
/** Whether a message has a file the page is drawing (a thumbnail or a player), so its bracketed placeholder is redundant. */
const shownFile = (m: MailMessage): boolean => (m.attachments ?? []).some((f) => f.picture || f.play === true || f.video === true)

/**
 * An email the way the inbox's page draws it, from the inbox's own reading of it (`read`, made by the code that page uses): a bubble each, theirs
 * on the left and ours on the right, a line over it with who and when ("You to <address>" for ours), and the earlier email it quotes folded behind a
 * "•••" button. Both halves are text, so React escapes them. The inbox's labels line is not here: the answer does not carry the labels.
 */
function EmailMessage({ message, read, now, zone, after }: { message: MailMessage; read: InboxRead; now: number; zone: string | undefined; after?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const mine = message.direction === 'out'
  const name = mine ? 'You' : senderName(message.from)
  const address = mine ? null : senderAddress(message.from)
  const label = open ? 'Hide the quoted text' : 'Show the quoted text'
  return (
    <div className={`msg email${mine ? ' mine' : ''}`} data-testid="entry" data-kind="email">
      {!mine && (
        <span className="avatar-sm" aria-hidden="true">
          {initials(name) || '?'}
        </span>
      )}
      <div className="msg-body">
        <div className="msg-head">
          <b>{name}</b>
          {mine && message.to !== undefined && message.to.trim() !== '' && <span className="sub addr" title={message.to}>to {message.to}</span>}
          {address !== null && address !== name && <span className="sub addr" title={address}>{address}</span>}
          <time className="sub" dateTime={new Date(message.at).toISOString()}>
            {stamp(now, message.at, zone)}
          </time>
          {message.edited === true && (
            <span className="sub" data-testid="edited">
              edited
            </span>
          )}
        </div>
        {/* The words of a Telegram message that is only a photo, a voice note, an image or a video are the bracketed label ("[Photo]"); with the file shown under it the label says nothing, so it is not drawn. */}
        {!(message.deleted !== true && shownFile(message) && PLACEHOLDER.test(read.visible)) && (
        <div className={`msg-text bubble${message.deleted === true ? ' deleted' : BRACKETED.test(read.visible) ? ' placeholder' : ''}`} {...(message.deleted === true && { 'data-testid': 'deleted-message' })}>
          {message.deleted === true ? <i>This message was deleted in Telegram.</i> : read.visible}
          {read.quoted !== '' && (
            <>
              <button type="button" className="fold" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((o) => !o)} data-testid="fold">
                •••
              </button>
              {open && (
                <div className="quoted" data-testid="quoted">
                  {read.quoted}
                </div>
              )}
            </>
          )}
        </div>
        )}
        <MessageFiles messageId={message.id} files={message.attachments} mine={mine} />
        <DeliveryNotes notes={message.delivery} mine={mine} />
        {message.textCut && <div className="sub">This email is longer than the inbox keeps, so it is cut short here. If it came through Gmail, the rest is there.</div>}
        {after}
      </div>
    </div>
  )
}

function Message({ entry: e, now, zone, onChanged, tools }: { entry: Extract<Item, { kind: 'entry' }>['entry']; now: number; zone: string | undefined; onChanged?(): void; tools?: ChatTools }) {
  // An answer from an inbox that predates `read` has nothing to fold by: the email is drawn whole, as it was.
  // "Not sent after all" is drawn once, under the message, whichever way the message is drawn.
  const after = e.kind === 'email' && e.message.sentByHand === true && onChanged ? <NotSentAfterAll messageId={e.message.id} onChanged={onChanged} /> : null
  if (e.kind === 'email' && e.message.read !== undefined) return <EmailMessage message={e.message} read={e.message.read} now={now} zone={zone} after={after} />
  const name = e.kind === 'email' ? (e.message.direction === 'out' ? 'You' : senderName(e.message.from)) : e.message.mine ? 'You' : e.message.authorName
  const mine = e.kind === 'email' ? e.message.direction === 'out' : e.message.mine
  // A chat message in the page: links, Edit and Delete where meet says the person may (ChatMessage.tsx). Drawn alone (a test), it is the plain text it was.
  if (e.kind === 'chat' && tools) {
    return (
      <ChatMessageRow
        message={e.message}
        name={name}
        tools={tools}
        at={
          <time className="sub" dateTime={new Date(e.at).toISOString()}>
            {stamp(now, e.at, zone)}
          </time>
        }
      />
    )
  }
  return (
    <div className={`msg${mine ? ' mine' : ''}`} data-testid="entry" data-kind={e.kind}>
      <span className="avatar-sm" aria-hidden="true">
        {initials(name) || '?'}
      </span>
      <div className="msg-body">
        <div className="msg-head">
          <b>{name}</b>
          <time className="sub" dateTime={new Date(e.at).toISOString()}>
            {stamp(now, e.at, zone)}
          </time>
        </div>
        <div className="msg-text">{e.message.text}</div>
        {e.kind === 'email' && <MessageFiles messageId={e.message.id} files={e.message.attachments} mine={mine} />}
        {e.kind === 'email' && <DeliveryNotes notes={e.message.delivery} mine={mine} />}
        {e.kind === 'email' && e.message.textCut && <div className="sub">This email is longer than the inbox keeps, so it is cut short here. If it came through Gmail, the rest is there.</div>}
        {after}
      </div>
    </div>
  )
}

function Notice({ tone, children, testid, onDismiss }: { tone: 'ok' | 'warn' | 'error'; children: React.ReactNode; testid?: string; onDismiss?: () => void }) {
  return (
    <p className={`cnotice ${tone}`} role={tone === 'error' ? 'alert' : 'status'} data-testid={testid ?? 'compose-notice'} data-tone={tone}>
      <Glyph name={tone === 'ok' ? 'mail' : 'warn'} size={13} />
      <span>{children}</span>
      {onDismiss && (
        <button type="button" className="linkish" onClick={onDismiss} data-testid="change-dismiss">
          Dismiss
        </button>
      )}
    </p>
  )
}

/** Copy the address or the words of a draft the person sends by hand, as the inbox's own card offers: a browser that will not write to the clipboard leaves the button saying so. */
function CopyWords({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <button
      type="button"
      className="btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setState('copied')
        } catch {
          setState('failed')
        }
      }}
      data-testid={`copy-${label}`}
    >
      {state === 'copied' ? `Copied ${label}` : state === 'failed' ? `Could not copy ${label}` : `Copy ${label}`}
    </button>
  )
}

export function DraftCard({ draft, state, onSend, onDismiss, onChanged }: { draft: DraftView; state: Compose | undefined; onSend(): void; onDismiss(): void; onChanged(): void }) {
  const unknown = state?.phase === 'unknown'
  const sending = state?.phase === 'sending'
  // Editing the subject and the words, as the inbox's own card does. A stuck draft (Gmail never said) is not edited: the inbox refuses it too.
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(false)
  return (
    <div className={`card draft${draft.stuck ? ' stuck' : ''}`} data-testid="draft" data-draft={draft.id}>
      <span className="card-ico">
        <Glyph name="note" size={15} />
      </span>
      <div className="card-main">
        <div className="card-title">{DRAFT_BY[draft.author]}</div>
        {/* A Telegram draft is to a person by their Telegram user id, a number that means nothing to read and nothing to paste: it is named and not addressed. */}
        <div className="sub" data-testid="draft-to">
          {draft.kind === 'telegram' ? (
            <>To {draft.toName} on Telegram</>
          ) : (
            <>
              To {draft.toName} {'<'}
              {draft.to}
              {'>'}
            </>
          )}
        </div>
        {draft.sendsFrom !== null && !byHand(draft) && (
          <div className="sub" data-testid="draft-from">
            From {draft.sendsFrom.name === draft.sendsFrom.address ? draft.sendsFrom.address : `${draft.sendsFrom.name} <${draft.sendsFrom.address}>`}
          </div>
        )}
        {draft.cc !== null && draft.cc.length > 0 && (
          <div className="sub" data-testid="draft-cc">
            Cc {draft.cc.map((c) => (c.name === c.address ? c.address : `${c.name} <${c.address}>`)).join(', ')}
          </div>
        )}
        {editing ? (
          <DraftEditor
            draft={draft}
            onChanged={onChanged}
            onClose={(wasSaved) => {
              setEditing(false)
              setSaved(wasSaved)
            }}
          />
        ) : (
          <>
            {draft.subject.trim() !== '' && <div className="sub">{draft.subject}</div>}
            {draft.text.trim() === '' && draft.picture ? <div className="sub" data-testid="draft-no-words">No words: the picture alone.</div> : <div className="draft-text">{draft.text}</div>}
            <DraftPicture id={draft.id} rev={draft.rev} picture={draft.picture} byClaude={draft.author === 'claude' && draft.editedBy !== 'owner'} />
          </>
        )}
        {saved && !editing && <Notice tone="ok" testid="draft-saved">Saved. Send it as it now stands, or ask the assistant to change it.</Notice>}
        {draft.stuck && <StuckSend draft={draft} onChanged={onChanged} />}
        {draft.sending && (
          <Notice tone="ok" testid="draft-sending">
            Sending on Telegram. This card goes when Telegram has the message; if it does not, it will say to check Telegram.
          </Notice>
        )}
        {draft.refusal !== null && !draft.stuck && (
          <Notice tone="error" testid="draft-refusal">
            {draft.refusal}
          </Notice>
        )}
        {byHand(draft) && !draft.stuck && (
          <Notice tone="warn" testid="draft-notice">
            The inbox cannot send {draft.kind === 'sms' ? 'a text message' : draft.kind === 'telegram' ? 'a Telegram message here (a channel, or a chat it holds no conversation for)' : 'a direct message'}. Send it yourself, then press Mark sent.
          </Notice>
        )}
        {!draft.sendable && !draft.stuck && !draft.sending && !byHand(draft) && (
          <Notice tone="warn" testid="draft-notice">
            {draft.cc === null ? 'The inbox did not say who this draft copies, so the space will not send it.' : 'This draft is on a conversation the space cannot send from.'}
          </Notice>
        )}
        {state?.notice && <Notice tone={state.notice.tone} testid="draft-notice">{state.notice.text}</Notice>}
        <DraftChat draft={draft} onChanged={onChanged} />
      </div>
      <div className="card-act">
        {draft.sendable && !unknown && (
          <button type="button" className="btn primary" onClick={onSend} disabled={sending || editing} title={editing ? 'Save or cancel your changes first' : undefined} data-testid="send-draft">
            {sending ? 'Sending' : 'Send as it stands'}
          </button>
        )}
        {unknown && (
          <button type="button" className="btn" onClick={onDismiss}>
            Done
          </button>
        )}
        {byHand(draft) && !draft.stuck && !editing && (
          <>
            {draft.kind !== 'telegram' && <CopyWords text={draft.to} label="address" />}
            <CopyWords text={draft.text} label="words" />
            <MarkSent draft={draft} onChanged={onChanged} />
          </>
        )}
        {!draft.stuck && !draft.sending && !editing && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setSaved(false)
              setEditing(true)
            }}
            data-testid="edit-draft"
          >
            Edit
          </button>
        )}
      </div>
    </div>
  )
}

function Composer(p: ViewProps) {
  const ways = replyWays(p.answer)
  const { row } = p.answer
  if (ways.preferred === null) {
    return (
      <div className="composer" data-testid="composer-none">
        <p className="sub">{ways.none}</p>
      </div>
    )
  }
  const way = chosenWay(ways, p.way)
  const thread = ways.email.find((t) => t.conversationId === p.threadId) ?? ways.email[0]
  const person = row.name
  const both = ways.email.length > 0 && ways.chat !== null && row.type === 'person'
  const line = way === 'email' && thread ? replyLine(person, thread) : null
  // A Telegram chat is not mail: no call link or booking goes into it (both are made by email), and its button says Send.
  const telegramThread = way === 'email' && thread?.kind === 'telegram'
  // Send and close only where Close would close that thread: it is open AND drawn on screen. A thread older than the page has unread mail nobody has seen.
  const closable = way === 'email' && thread !== undefined && p.answer.change.close.some((m) => m.conversationId === thread.conversationId)
  const locked = p.compose.phase !== 'writing'
  // A Telegram group is written to by its whole title (its first word is not a name), a chat by the person's first name.
  const placeholder = telegramThread && thread?.telegramChat === 'group' ? `Message ${person}` : way === 'email' ? `Write to ${person.split(/\s+/)[0]}` : row.type === 'channel' ? `Message #${row.name}` : `Message ${person.split(/\s+/)[0]}`
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      // Cmd+Shift+Enter is Send and close, as in the inbox; only where that is offered.
      if (e.shiftKey) p.onSendAndClose()
      else p.onSend()
    }
  }
  // A Telegram chat that has a reply box takes one picture (Attach picture, or a screenshot pasted into the words). Everywhere else paste is the browser's own.
  const takesPicture = way === 'email' && thread?.canPicture === true && p.onPicture !== undefined
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!takesPicture) return
    const pasted = pastedPicture(e.clipboardData)
    if (pasted === null) return
    // A picture on the clipboard beside no words is the picture; with words it is the words (a spreadsheet's cells carry both), which the browser pastes.
    e.preventDefault()
    p.onPicture?.(pasted)
  }
  // The booking form is a SIBLING of the composer's form, never inside it: Enter in one of its boxes would otherwise submit the composer's form through Send and send the email
  // (or post the chat) being written. It is a form of its own, whose submit is Book.
  const schedule = p.calls?.scheduleOpen ? (
    <div className="schedule-wrap">
      <ScheduleFormView
        with={person}
        zone={p.me.company.timeZone}
        now={p.now}
        invitable={way === 'email' ? p.calls.invitable : []}
        emailed={way === 'email'}
        busy={p.calls.busy}
        onBook={p.calls.schedule}
        onCancel={p.calls.closeSchedule}
      />
    </div>
  ) : null
  return (
    <>
    {schedule}
    <form
      className="composer"
      data-testid="composer"
      data-way={way}
      onSubmit={(e) => {
        e.preventDefault()
        p.onSend()
      }}
    >
      <div className="to">
        {both && (
          <span className="seg" role="group" aria-label="Reply by">
            <button type="button" className={`chip${way === 'email' ? ' on' : ''}`} aria-pressed={way === 'email'} onClick={() => p.onWay('email')} disabled={locked} data-testid="way-email">
              Email
            </button>
            <button type="button" className={`chip${way === 'chat' ? ' on' : ''}`} aria-pressed={way === 'chat'} onClick={() => p.onWay('chat')} disabled={locked} data-testid="way-chat">
              Direct message
            </button>
          </span>
        )}
        {line && (
          <span data-testid="reply-line" data-all={line.all}>
            <span className="sub">
              {line.text}
              {ways.email.length === 1 && thread && thread.kind !== 'telegram' && `, in: ${thread.subject.trim() || '(no subject)'}`}
            </span>
          </span>
        )}
        {way === 'email' && thread && ways.email.length > 1 && (
          <select value={thread.conversationId} onChange={(e) => p.onThread(e.target.value)} disabled={locked} aria-label="Reply in which email thread" data-testid="thread-select">
            {ways.email.map((t) => (
              <option key={t.conversationId} value={t.conversationId}>
                In: {t.kind === 'telegram' ? (t.telegramChat === 'group' ? 'Telegram group' : 'Telegram') : t.subject.trim() || '(no subject)'}
                {t.open ? '' : ' (closed)'}
              </option>
            ))}
          </select>
        )}
        {way === 'chat' && row.type === 'person' && <span className="sub">Direct message to {person}</span>}
        {way === 'chat' && row.type === 'channel' && <span className="sub">Post in #{row.name}</span>}
      </div>
      <textarea
        rows={3}
        value={p.compose.text}
        onChange={(e) => p.onText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        readOnly={locked}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid="compose-text"
      />
      {way === 'email' && thread?.canAttach === true && (
        <AttachFiles files={filesOf(p.compose)} onAdd={(files) => p.onAttach?.(files)} onRemove={(i) => p.onDetach?.(i)} disabled={locked} />
      )}
      {takesPicture && <AttachPicture picture={p.compose.picture} why={whyNotPicture(p.compose)} onChoose={(file) => p.onPicture?.(file)} onTakeOut={() => p.onTakeOutPicture?.()} disabled={locked} />}
      {p.compose.notice && <Notice tone={p.compose.notice.tone}>{p.compose.notice.text}</Notice>}
      {p.calls?.notice && <Notice tone={p.calls.notice.tone} testid="calls-notice">{p.calls.notice.text}</Notice>}
      <div className="composer-bar">
        {p.calls && !telegramThread && (
          <span className="call-tools" role="group" aria-label="Calls">
            {way === 'chat' && p.calls.canHuddle && (
              <button type="button" className="btn" onClick={p.calls.startHuddle} disabled={p.calls.busy || locked} title="Start a huddle here: anyone in this conversation can join" data-testid="start-huddle">
                <Glyph name="video" size={13} />
                Start huddle
              </button>
            )}
            {way === 'email' && p.calls.canLink && (
              <button type="button" className="btn" onClick={p.calls.addLink} disabled={p.calls.busy || locked} title="Make a call and put its link in this email" data-testid="add-call-link">
                <Glyph name="link" size={13} />
                Add call link
              </button>
            )}
            {p.calls.canSchedule && (
              <button type="button" className="btn" onClick={p.calls.openSchedule} disabled={p.calls.busy || locked || p.calls.scheduleOpen} title="Book a meeting with a time" data-testid="open-schedule">
                <Glyph name="calendar" size={13} />
                Schedule
              </button>
            )}
          </span>
        )}
        <span className="grow" />
        {p.compose.phase === 'unknown' ? (
          <button type="button" className="btn" onClick={p.onDismiss} data-testid="write-another">
            Write another message
          </button>
        ) : (
          <>
            {closable && (
              <button type="button" className="btn" disabled={!canSend(p.compose)} onClick={p.onSendAndClose} title="Send, then close this email thread (Cmd+Shift+Enter)" data-testid="send-and-close">
                Send and close
              </button>
            )}
            <button type="submit" className="btn primary" disabled={!canSend(p.compose)} data-testid="send" data-what={way}>
              {p.compose.phase === 'sending' ? 'Sending' : way === 'email' && !telegramThread ? (line?.all ? 'Send to all' : 'Send email') : 'Send'}
            </button>
          </>
        )}
      </div>
    </form>
    </>
  )
}

/** The button over an email thread: the inbox's Mark as spam, or Move to the Inbox for one that is in Bulk. */
function SpamButton({ block, answer, onSpam, busy }: { block: string; answer: ConversationAnswer; onSpam: ViewProps['onSpam']; busy: boolean }) {
  if (!onSpam || !block.startsWith('email:')) return null
  const id = block.slice('email:'.length)
  const thread = answer.threads.find((t) => t.conversationId === id)
  const control = thread ? spamControl(thread) : null
  if (!control) return null
  return (
    <button type="button" className="btn spam" disabled={busy} title={control.title} onClick={() => onSpam(id, control.spam)} data-testid="spam" data-spam={control.spam}>
      {control.label}
    </button>
  )
}

function Profile({ answer, channel }: { answer: ConversationAnswer; channel: ViewProps['channel'] }) {
  const { profile, row } = answer
  const facts = profileFacts(profile)
  return (
    <div className="e-pro" data-testid="profile" data-kind={profile.kind}>
      <div className="e-pro-head">
        <Mark name={row.name} kind={row.type === 'channel' ? 'channel' : row.side} />
        <h2>{profile.name}</h2>
        <div className="tags">
          {profile.kind === 'outside' && profile.telegramChat === undefined && profile.client && <span className="pill accent">Client</span>}
          {profile.kind === 'outside' && profile.telegramChat === undefined && !profile.client && <span className="pill">Not a client</span>}
          {profile.kind === 'outside' && profile.telegramChat !== undefined && <span className="pill">{profile.telegramChat === 'group' ? 'Group' : 'Channel'}</span>}
          {profile.kind === 'team' && <span className="pill accent">Teammate</span>}
          {profile.kind === 'channel' && <span className="pill">Channel</span>}
        </div>
      </div>
      <dl className="facts">
        {facts.map(([k, v]) => (
          <div key={k} className="fact">
            <dt className="sub">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {/* The business, role and notes of someone outside the team: People's fields, editable here too (People.tsx). */}
      {profile.kind === 'outside' && profile.telegramChat === undefined && <ProfileFields convKey={answer.key} {...(channel && { go: channel.go })} />}
      {/* A channel's people, and what its people can do with it: meet's answer, drawn (Channels.tsx). */}
      {row.type === 'channel' && channel && <ChannelPanel key={row.conversationId} conversationId={row.conversationId} go={channel.go} onChanged={channel.onChanged} />}
    </div>
  )
}

export function ConversationView(p: ViewProps) {
  const { answer } = p
  const scope = p.scope ?? 'mail'
  const { row } = answer
  const merged = useMemo(() => mergeHistory(p.sources), [p.sources])
  const blocks = blocksOf(answer, merged.entries, merged.cutoff)
  const notices = partNotices(answer.parts)
  const sub =
    row.type === 'channel'
      ? `${row.privacy === 'private' ? 'Private channel' : 'Channel'}, ${row.memberCount} people`
      : row.type === 'person' && row.telegramChat !== null
        ? row.telegramChat === 'group'
          ? 'Telegram group'
          : 'Telegram channel'
        : row.client
          ? row.client.name
          : row.side === 'team'
            ? 'Teammate'
            : (row.addresses[0] ?? 'Outside')
  // A group or a channel is not somebody a document is sent to.
  const signable = !(row.type === 'person' && row.telegramChat !== null)
  const empty = blocks.length === 0
  // "New" goes before the first chat message DRAWN that is at or after where unread began and is from someone else. It is found among what is drawn (the blocks), not among the messages: a huddle's
  // announcement is drawn as its card, so it is not that message, and the line goes before the next one that is.
  const newFrom = p.chat?.newFrom ?? null
  const newKey = newFrom === null ? null : newLineKey(blocks, newFrom)
  return (
    <div className="e-detail" data-testid="conversation" data-key={answer.key}>
      <div className={`e-convo${p.profileOpen ? ' away' : ''}`}>
        <a className="back" href={tabPathOf(scope)} onClick={p.onBack} data-testid="back">
          <Glyph name="back" size={14} />
          {tabNameOf(scope)}
        </a>
        <div className="d-head e-head">
          <Mark name={row.name} kind={row.type === 'channel' ? 'channel' : row.side} />
          <div className="grow">
            <h2 data-testid="convo-title">{row.type === 'channel' ? `# ${row.name}` : row.name}</h2>
            <div className="sub">{sub}</div>
          </div>
          {answer.change.close.length > 0 && (
            <button type="button" className="btn" onClick={p.onClose} disabled={p.changing} title="Close (c)" data-testid="close-conversation">
              Close <kbd className="kbd">c</kbd>
            </button>
          )}
          {p.reopen && (
            <button type="button" className="btn" onClick={p.onReopen} disabled={p.changing} title={p.reopen.title} data-testid="reopen-conversation">
              <span className="reopen-name">{p.reopen.label}</span>
            </button>
          )}
          {/* A full page load, like every way into Forms: it is what renews the Forms application's day-long sign-in. The Inbox's: a document goes to a person's email. */}
          {scope === 'mail' && signable && (
            <a className="btn send-sign" href={sendFromPath(answer.key)} title="Send a document from here to be signed" aria-label="Send for signature" data-testid="send-for-signature">
              <TabIcon tab="forms" size={13} />
              <span className="btn-words">Send for signature</span>
            </a>
          )}
          <button type="button" className="btn e-pbtn" onClick={() => p.onProfile(true)} data-testid="open-profile">
            Profile
          </button>
        </div>
        {p.changed && (
          <div className="change-notice">
            <Notice tone={p.changed.tone} testid="change-notice">
              {p.changed.text}
            </Notice>
          </div>
        )}
        {(p.problems ?? []).map((n) => (
          <div className="change-notice" key={n.seq}>
            <Notice tone={n.notice.tone} testid="change-notice" {...(p.onDismissProblem && { onDismiss: () => p.onDismissProblem?.(n.seq) })}>
              {n.notice.text}
            </Notice>
          </div>
        ))}
        {notices.map((n) => (
          <p key={n.part} className={`notice ${n.kind}`} role="status" data-notice={n.kind} data-part={n.part}>
            <Glyph name={n.kind === 'unreachable' ? 'warn' : 'lock'} size={13} />
            <span>{n.text}</span>
          </p>
        ))}
        {answer.documents.state !== 'ok' && (
          <p className="notice unreachable" role="status" data-notice={answer.documents.state} data-part="documents">
            <Glyph name={answer.documents.state === 'not-open-to-you' ? 'lock' : 'warn'} size={13} />
            <span>{documentsNotice(answer.documents)}</span>
          </p>
        )}
        <div className="timeline" data-testid="timeline" ref={p.timelineRef}>
          {merged.hasEarlier && (
            <button type="button" className="btn earlier" onClick={p.onEarlier} disabled={p.loadingEarlier} data-testid="earlier">
              {p.loadingEarlier ? 'Loading' : 'Earlier messages'}
            </button>
          )}
          {empty && <p className="empty-line sub">Nothing has been said here yet.</p>}
          {blocks.map((b, i) => (
            <div key={`${b.id}:${i}`} className="trow-wrap" data-testid="block">
              {b.heading && (
                <div className="srchead" data-testid="heading">
                  <Glyph name={b.kind === 'email' && b.heading !== TELEGRAM_HEADING ? 'mail' : row.type === 'channel' ? 'hash' : 'chat'} size={12} />
                  {b.heading}
                  <SpamButton block={b.id} answer={answer} onSpam={p.onSpam} busy={p.spamming === true} />
                </div>
              )}
              {b.items.map((item) =>
                item.kind === 'entry' ? (
                  <Fragment key={item.entry.key}>
                    {item.entry.key === newKey && <NewLine />}
                    <Message entry={item.entry} now={p.now} zone={p.timeZone} onChanged={p.onDraftChanged} {...(p.chat && { tools: p.chat })} />
                  </Fragment>
                ) : item.kind === 'document' ? (
                  <DocumentCard key={`document:${item.doc.id}`} doc={item.doc} now={p.now} zone={p.timeZone} />
                ) : item.kind === 'call' ? (
                  <CallCard
                    key={`call:${item.call.name}`}
                    call={item.call}
                    now={p.now}
                    zone={p.me.company.timeZone}
                    name={p.me.name}
                    chatHref={callPath(item.call.name)}
                    {...(p.onOpenCall && { onOpenChat: () => p.onOpenCall?.(item.call.name) })}
                  />
                ) : (
                  <DraftCard key={item.draft.id} draft={item.draft} state={p.drafts[item.draft.id]} onSend={() => p.onSendDraft(item.draft)} onDismiss={() => p.onDismissDraft(item.draft.id)} onChanged={p.onDraftChanged} />
                ),
              )}
            </div>
          ))}
        </div>
        <Composer {...p} />
      </div>
      <div className={`e-profile${p.profileOpen ? ' open' : ''}`}>
        <button type="button" className="back always" onClick={() => p.onProfile(false)} data-testid="close-profile">
          <Glyph name="back" size={14} />
          Conversation
        </button>
        <Profile answer={answer} channel={p.channel} />
      </div>
    </div>
  )
}

// ── The pane: fetching, keeping fresh, reading, sending ───────────────────────────────────────────────────────────────────

interface Loaded {
  answer: ConversationAnswer
  sources: HistorySource[]
}

type State = { kind: 'loading' } | { kind: 'ready'; loaded: Loaded } | { kind: 'failed'; message: string; signin: boolean; missing?: boolean }

/** A draft is sent as an email, which is what its notices say to check. */
const EMAIL: Way = 'email'

/** How often a conversation with a call on redraws its clock (not a read: who is in the call arrives by the live connection). */
export const CARDS_REFRESH_MS = 8_000

/** A Reopen pressed sooner than this after a Close is the Close's double click, and does nothing. */
export const REOPEN_AFTER_CLOSE_MS = 400

export interface PaneProps {
  me: Me
  /** Which tab it is opened in: the Inbox (`mail`: the emails, no chat) or Meet (`chat`: the channel or direct message, no email). */
  scope: Scope
  convKey: string
  /** Counts up whenever the list is read again (chat said something changed, the page was shown again, a minute passed): the conversation is read again with it. */
  refreshes: number
  /** The row was opened from the Closed view: it offers Reopen. */
  fromClosed: boolean
  /** The list should be read again: something was sent, closed, reopened or marked read. */
  onChanged(): void
  go(path: string): void
}

const failure = (r: Extract<Fetched<unknown>, { ok: false }>): State => {
  if (r.problem === 'signin') return { kind: 'failed', message: 'Your sign-in may have ended.', signin: true }
  if (r.status === 404) return { kind: 'failed', message: r.message ?? 'There is no such conversation.', signin: false, missing: true }
  return { kind: 'failed', message: r.message ?? 'The space could not be reached just now.', signin: false }
}

export function ConversationPane({ me, scope, convKey, fromClosed, refreshes, onChanged, go }: PaneProps) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const [compose, setCompose] = useState<Compose>(() => newCompose(mintKey))
  const [way, setWay] = useState<Way>('email')
  const [threadId, setThreadId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Compose>>({})
  const [profileOpen, setProfileOpen] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible')
  const [changing, setChanging] = useState(false)
  // Words of this pane's own (a send that was not followed by a close, Mark as spam). Closes and reopens are told by `changes`, which outlives the pane.
  const [changed, setChanged] = useState<ComposeNotice | null>(null)
  const pending = useSyncExternalStore(changes.subscribe, changes.snapshot, changes.snapshot)
  // The threads the last Close from this page closed, so a mistaken Close can be undone here, exactly, and not only from the Closed view.
  const [lastClosed, setLastClosed] = useState<string[]>([])
  const busy = useRef(false)
  const spamBusy = useRef(false)
  // When Close was last pressed here: a Reopen right after it is a double click landing on the button that replaced Close, not an undo.
  const closedAt = useRef(0)
  // Each read of the conversation is numbered when it starts. A result is dropped only once a NEWER read has already landed: a slow read started
  // before a close must not land after the close's own and put the old state back. An older one that lands first is shown (the pane is never left
  // waiting on a newer read that then fails) and the newer one replaces it when it comes.
  const started = useRef(0)
  const landed = useRef(0)
  const paging = useRef(false)
  const tried = useRef(new Set<string>())
  const wayChosen = useRef(false)
  const timeline = useRef<HTMLDivElement>(null)
  // Where "New" begins is the FIRST answer's: opening the conversation marks it read, so every answer after it says nothing is unread, and a message that arrives while it is open is not new to the person reading.
  const newFromHeld = useRef<number | null | undefined>(undefined)
  const settledOn = useRef<string | null>(null)

  const load = useCallback(
    async (quiet: boolean) => {
      const mine = ++started.current
      const startedAt = Date.now()
      const r = await read<ConversationAnswer>(`/api/conversation?key=${encodeURIComponent(convKey)}&scope=${scope}`)
      if (mine < landed.current) return
      setNow(Date.now())
      if (!r.ok) {
        // A quiet read that fails leaves what is on screen: the conversation does not vanish because one refresh missed.
        if (!quiet) setState(failure(r))
        return
      }
      landed.current = mine
      // What this read says is the inbox's, after every change that ended before it began: the page need not show those changes over it any more.
      changes.release('threads', startedAt)
      if (newFromHeld.current === undefined) newFromHeld.current = r.value.newFrom ?? null
      setState((prev) => ({
        kind: 'ready',
        loaded: { answer: r.value, sources: prev.kind === 'ready' ? refreshSources(prev.loaded.sources, r.value.sources) : r.value.sources },
      }))
    },
    [convKey, scope],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  // The list was read again (chat, focus, the minute): so is this, quietly. The first run is the load above.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    void load(true)
  }, [refreshes, load])

  // A close or reopen made from anywhere on the page ended: this conversation is read again, and that read (begun after it ended) is what its overlay waits for.
  const lastEnded = useRef(pending.ended)
  useEffect(() => {
    if (lastEnded.current === pending.ended) return
    lastEnded.current = pending.ended
    void load(true)
  }, [pending.ended, load])

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  // What was read, with the closes and reopens still out shown as done: the screen is where it will be, not where the inbox last said.
  const fetched = state.kind === 'ready' ? state.loaded : null
  const answer = useMemo(() => (fetched ? withPending(fetched.answer, pending.threads) : null), [fetched, pending.threads])
  const loaded = useMemo(() => (fetched && answer ? (answer === fetched.answer ? fetched : { ...fetched, answer }) : null), [fetched, answer])

  // Calls: a huddle, a call link, a meeting. The reply box takes the link or the invitation as text under what is written; a call made reads the conversation again.
  const effectiveWay = answer ? chosenWay(replyWays(answer), way) : way
  const calls = useCallActions({
    answer,
    way: effectiveWay,
    threadId,
    zone: me.company.timeZone,
    insert: (text) => setCompose((c) => typed(c, withBlock(c.text, text))),
    made: () => {
      void load(true)
      onChanged()
    },
    now: Date.now,
  })

  // While a call here has people in it, its card's clock ticks every few seconds ("Call ended, 12 min"). WHO is in it is not polled: the call's object tells the live connection when that changes, and the list reads this conversation again (Conversations.tsx).
  const anyLive = answer?.calls.some((c) => c.present > 0) ?? false
  useEffect(() => {
    if (!anyLive || !visible) return
    const timer = setInterval(() => setNow(Date.now()), CARDS_REFRESH_MS)
    return () => clearInterval(timer)
  }, [anyLive, visible])

  // The way a reply opens in, until the person chooses one.
  useEffect(() => {
    if (!answer || wayChosen.current) return
    const w = replyWays(answer)
    if (w.preferred) setWay(w.preferred)
  }, [answer])

  // OPENING IT MARKS IT READ, in both apps, at the position this answer reached: each unread email conversation at its `through`, and the chat up
  // to its newest message. Once for each position (a message that arrives while it is open makes a new one), and only while it is on screen.
  useEffect(() => {
    if (!answer || !visible) return
    const marks = answer.read
    if (marks.mail.length === 0 && marks.chat === null) return
    const signature = JSON.stringify(marks)
    if (tried.current.has(signature)) return
    tried.current.add(signature)
    void write('/api/read', marks).then((res) => {
      const out = res !== 'network' && res.status === 200 ? (res.body as ReadOutcome) : null
      onChanged()
      // Mail arrived after what was read: it is shown first (the inbox will not mark what was not seen) and read again at its new position.
      if (out && out.mail.state === 'ok' && out.mail.notRead.some((n) => n.reason === 'conflict')) void load(true)
    })
  }, [answer, visible, load, onChanged])

  // The service worker asks which person is open (notify.ts): a notification for them is kept quiet while this page shows them. Notifications are the inbox's (an email), so only the
  // Inbox's conversation says so: an email from someone whose direct message is open in Meet is news, since the email is not on screen.
  // Plus the row's own key: a Telegram person with no email is opened (and notified) by `mail:<contact id>`, which no address names.
  const shownAddresses = useMemo(() => (scope === 'mail' && answer && answer.row.type === 'person' ? [...answer.row.addresses, answer.row.key] : null), [scope, answer])
  useEffect(() => {
    setShownConversation(shownAddresses ?? [])
    return () => setShownConversation([])
  }, [shownAddresses])

  // Newest at the bottom: a conversation opens there, and stays there as messages arrive unless the person has scrolled up to read.
  const lastKey = useMemo(() => (loaded ? (mergeHistory(loaded.sources).entries.at(-1)?.key ?? '') : ''), [loaded])
  useEffect(() => {
    const el = timeline.current
    if (!el) return
    // Opening it: the "New" line is brought into view when there is one, and the newest message otherwise. After that the newest stays in view as messages arrive, unless the person has scrolled up.
    if (settledOn.current !== convKey) {
      settledOn.current = convKey
      const line = el.querySelector('[data-testid="new-line"]')
      if (line) {
        line.scrollIntoView?.({ block: 'center' })
        return
      }
    }
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (near || el.scrollTop === 0) el.scrollTop = el.scrollHeight
  }, [lastKey, profileOpen, answer?.drafts.length, convKey])

  const earlier = async () => {
    if (!loaded || paging.current) return
    paging.current = true
    setLoadingEarlier(true)
    try {
      const pages = sourcesToPage(loaded.sources).map((s) => ({ id: sourceId(s), before: oldestId(s), s }))
      const got = await Promise.all(
        pages.map(async ({ s, ...asked }) => {
          const url = s.kind === 'mail' ? `/api/history?mail=${encodeURIComponent(s.contactId)}&before=${encodeURIComponent(String(asked.before))}` : `/api/history?chat=${s.conversationId}&before=${asked.before}`
          return { ...asked, r: await read<{ messages: HistorySource['messages']; more: boolean }>(url) }
        }),
      )
      // Placed on what is held NOW, and only where it still stops where it did when this page was asked for: a refresh in between may have moved it.
      setState((prev) => {
        if (prev.kind !== 'ready') return prev
        let sources = prev.loaded.sources
        for (const { id, before, r } of got) if (r.ok) sources = withEarlierPage(sources, id, before, r.value)
        return { kind: 'ready', loaded: { ...prev.loaded, sources } }
      })
    } finally {
      paging.current = false
      setLoadingEarlier(false)
    }
  }

  // EDIT and DELETE a chat message, with meet's rules and words (ChatMessage.tsx). Each is one call, never retried: what meet refuses is said under the message, and a call the space lost track of says
  // it may have been done. What was done is put right in the sources held here (the message may be older than the newest page, which a read of the conversation does not bring back), and the
  // conversation and the list are then read again.
  const chatTools: ChatTools = {
    origin: meetOrigin(me.origin),
    edit: async (messageId, text) => {
      const got = await postView<MeetMessage>('meet/message-edit', { messageId, text })
      if (!got.ok) return got.say.text
      const now = got.value
      setState((prev) =>
        prev.kind !== 'ready'
          ? prev
          : { kind: 'ready', loaded: { ...prev.loaded, sources: changeChat(prev.loaded.sources, messageId, (m) => ({ ...m, text: now.text, edited: now.editedAt !== null, ...(now.may !== undefined && { may: now.may }) })) } },
      )
      onChanged()
      return null
    },
    remove: async (messageId) => {
      const got = await postView<MeetDeleted>('meet/message-delete', { messageId })
      if (!got.ok) return got.say.text
      setState((prev) => (prev.kind !== 'ready' ? prev : { kind: 'ready', loaded: { ...prev.loaded, sources: changeChat(prev.loaded.sources, messageId, () => null) } }))
      onChanged()
      return null
    },
  }

  const subjectOf = (id: string) => answer?.threads.find((t) => t.conversationId === id)?.subject.trim() || '(no subject)'

  // MARK AS SPAM, or move back to the Inbox: one call to the inbox for the thread, one at a time (a second press while it waits does nothing), told in the notice under the header and followed by a
  // read of the conversation and the lists. It waits for the closes and reopens already out. Idempotent, so a lost answer is read again and never guessed.
  const markSpam = async (conversationId: string, spam: boolean) => {
    if (!answer || spamBusy.current) return
    spamBusy.current = true
    setChanging(true)
    try {
      await changes.idle()
      const got = await postView<InboxSpamResult>('spam', { conversationId, spam })
      setChanged(got.ok ? spamNotice(got.value, subjectOf(conversationId)) : { tone: got.say.tone === 'bad' ? 'error' : 'warn', text: got.say.text })
      onChanged()
      await load(true)
    } finally {
      spamBusy.current = false
      setChanging(false)
    }
  }

  // CLOSE the email threads on screen, each at the position this answer reached: the inbox refuses one that has newer mail (and says so), so nothing is
  // archived unseen. `sent`: this follows a send. The screen moves on at once (changes.ts): the threads are shown closed and the row leaves the lists while the call
  // is made behind, in its turn; a refusal brings them back and says why. Pressed again at once (another conversation, another Close) it is queued behind, never dropped.
  const closeThreads = (marks: { conversationId: string; through: number }[], sent: boolean) => {
    if (marks.length === 0 || !answer) return undefined
    const ids = marks.map((m) => m.conversationId)
    const notShown = sent ? 0 : answer.change.notShown
    // The row leaves the lists that hold open conversations only when nothing of it stays open: every open thread is in this close and none is off screen.
    const leaves = answer.row.type === 'person' && answer.change.notShown === 0 && answer.threads.every((t) => !t.open || ids.includes(t.conversationId))
    // The notice is made from the subjects as they are NOW: the answer may be a different one by the time the inbox replies.
    const subjects = new Map(answer.threads.map((t) => [t.conversationId, t.subject.trim() || '(no subject)']))
    setChanged(null)
    setLastClosed(ids)
    closedAt.current = Date.now()
    return changes.submit({
      kind: 'close',
      ids,
      row: { key: answer.key, leaves },
      hope: sent ? 'Sent and closed.' : 'Closed.',
      run: async (still) => describeClose(await write('/api/close', { mail: marks.filter((m) => still.includes(m.conversationId)) }), { subject: (id) => subjects.get(id) ?? '(no subject)', notShown, sent }),
      settled: (done) => {
        setLastClosed((h) => (done.length > 0 ? [...done] : h.filter((id) => !ids.includes(id))))
        onChanged()
      },
    })
  }

  // REOPEN what `reopenOffer` names: one thread from the Closed view, or exactly what the last Close closed. Pressed while that Close is still out it is queued behind it.
  const offer = answer ? reopenOffer(answer, { fromClosed, lastClosed, threadId }) : null
  const reopenThreads = () => {
    if (offer === null || !answer) return undefined
    const ids = offer.ids
    const subjects = new Map(answer.threads.map((t) => [t.conversationId, t.subject.trim() || '(no subject)']))
    setChanged(null)
    setLastClosed((h) => h.filter((id) => !ids.includes(id)))
    return changes.submit({
      kind: 'reopen',
      ids,
      row: { key: answer.key, leaves: false },
      hope: 'Reopened.',
      run: async (still) => describeReopen(await write('/api/reopen', { mail: still }), { subject: (id) => subjects.get(id) ?? '(no subject)' }),
      settled: () => onChanged(),
    })
  }

  // The key c is Close (or Reopen where that is what is offered), as in the inbox, and never while a letter is being typed or a modal (the phone's
  // Views sheet) is open. It reads the latest of the above.
  const keyed = useRef<() => void>(() => undefined)
  // A second c while the first is still with the inbox is a key pressed twice, not a wish to take the first back: it does nothing (the Reopen button is there for that).
  keyed.current = () => {
    if (answer && answer.change.close.length > 0) {
      if (!changes.busy(answer.change.close.map((m) => m.conversationId))) void closeThreads(answer.change.close, false)
    } else if (offer !== null && !changes.busy(offer.ids)) void reopenThreads()
  }
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || !isCloseKey(e, typingIn(e.target as HTMLElement | null) || modalOpen(document))) return
      e.preventDefault()
      keyed.current()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  // A failure that was shown here is put away when the person leaves the conversation: it was told, and the list shows the true state. One for a conversation that was not open when it came waits until it is.
  const seenFailures = useRef(new Set<number>())
  for (const t of pending.told) if (t.notice.tone !== 'ok' && answer?.threads.some((th) => t.ids.includes(th.conversationId))) seenFailures.current.add(t.seq)
  useEffect(
    () => () => {
      changes.dismiss([...seenFailures.current])
    },
    [],
  )

  const send = async (andClose = false) => {
    if (!answer || busy.current || !canSend(compose)) return
    const aim = replyTarget(answer, way, threadId)
    if (!aim) return
    busy.current = true
    const begun = begin(compose)
    setCompose(begun)
    const req = requestFor(aim.target, begun.key, begun.text)
    // Files go with an email reply only, and only from a business mailbox's thread. Chosen and then moved elsewhere (a direct message, another thread), they are not
    // dropped quietly from a send that goes without them: nothing is sent, and the person is told.
    const files = filesOf(begun)
    const canCarry = aim.target.via === 'email' && answer.threads.some((t) => t.conversationId === (aim.target as { conversationId: string }).conversationId && t.canAttach)
    if (files.length > 0 && !canCarry) {
      setCompose({ ...compose, notice: { tone: 'error', text: 'Files can go with an email reply from a business mailbox only. Take them out, or reply in one of those threads. Nothing was sent.' } })
      busy.current = false
      return
    }
    // A picture goes only in the reply box of a Telegram chat that takes one (a person or a group); chosen and then moved elsewhere (another thread, a direct message) it is not dropped quietly either.
    const picture = begun.picture?.file
    const canCarryPicture = aim.target.via === 'email' && answer.threads.some((t) => t.conversationId === (aim.target as { conversationId: string }).conversationId && t.canPicture === true)
    if (picture !== undefined && !canCarryPicture) {
      setCompose({ ...compose, notice: { tone: 'error', text: 'A picture can go in a Telegram chat only. Take it out, or reply in a Telegram chat. Nothing was sent.' } })
      busy.current = false
      return
    }
    const toSend = picture !== undefined ? [picture] : files
    const outcome = outcomeFromResponse(toSend.length > 0 ? await writeForm('/api/email/files', req.body, toSend) : await write(req.url, req.body))
    const viaTelegram = aim.target.via === 'email' && answer.threads.some((t) => t.conversationId === (aim.target as { conversationId: string }).conversationId && t.kind === 'telegram')
    setCompose(settle(begun, outcome, aim.way, mintKey, viaTelegram ? 'telegram' : undefined))
    busy.current = false
    // Send and close: only an email that is known to have gone, in a thread Close would close (open and on screen), is followed by a close, at the
    // position its reply was written over (our own reply is not mail the inbox counts as arrived). Gmail not saying whether it went is a send to
    // check, not a thread to archive. The close is shown at once and made behind (closeThreads); the read here brings in the reply that went, and the one
    // the close's end asks for is the last word on how it stands.
    const target = aim.target
    const asked = andClose && target.via === 'email' ? target : null
    const went = (outcome.result === 'done' && outcome.status === 'sent') || (outcome.result === 'repeated' && outcome.earlier === 'sent')
    const closes = asked !== null && went && answer.change.close.some((m) => m.conversationId === asked.conversationId)
    if (outcome.result === 'refused' || outcome.result === 'done' || outcome.result === 'repeated') void load(true)
    if (outcome.result === 'done' || outcome.result === 'repeated') onChanged()
    if (asked !== null && closes) void closeThreads([{ conversationId: asked.conversationId, through: asked.through }], true)
    else if (andClose && (outcome.result === 'done' || outcome.result === 'repeated')) {
      // It was asked to close and did not: the person is told so, and why, rather than finding the thread still open.
      setChanged({ tone: 'warn', text: went ? `Sent, but not closed. ${whyNotClosed(answer, asked?.conversationId ?? null)}` : viaTelegram ? 'Not closed: the message is still being sent on Telegram.' : 'Not closed: Gmail did not say whether the email went out.' })
    }
  }

  const sendDraft = async (d: DraftView) => {
    if (busy.current) return
    const held = drafts[d.id] ?? { ...newCompose(mintKey), text: d.text }
    if (held.phase !== 'writing') return
    busy.current = true
    const begun = begin(held)
    setDrafts((m) => ({ ...m, [d.id]: begun }))
    const req = requestFor({ via: 'draft', draftId: d.id, rev: d.rev, through: d.through }, begun.key, '')
    const outcome = outcomeFromResponse(await write(req.url, req.body))
    const after = settle(begun, outcome, EMAIL, mintKey, d.kind === 'telegram' ? 'telegram' : undefined)
    // A draft that went is no longer a draft: its notice is the compose's, and the next read drops the card.
    if (outcome.result === 'done' || outcome.result === 'repeated') {
      setDrafts((m) => {
        const { [d.id]: _gone, ...rest } = m
        return rest
      })
      setCompose((c) => ({ ...c, notice: after.notice }))
      onChanged()
    } else setDrafts((m) => ({ ...m, [d.id]: after }))
    busy.current = false
    if (outcome.result !== 'outcome-unknown') void load(true)
  }

  if (state.kind === 'loading') {
    return (
      <div className="detail-note" role="status" data-testid="convo-loading">
        <p className="sub">Opening the conversation</p>
      </div>
    )
  }
  if (state.kind === 'failed' || !loaded) {
    const f = state.kind === 'failed' ? state : { message: '', signin: false, missing: false }
    // A person may have only the other tab's side (an old bookmark of a direct message, or an email only): say where the other side would be.
    const other: Scope = scope === 'mail' ? 'chat' : 'mail'
    return (
      <div className="detail-note" role="alert" data-testid="convo-failed">
        <p>{f.message}</p>
        {f.missing === true && (
          <p className="sub">
            {scope === 'mail' ? 'If it was a chat, it is in ' : 'If it was an email, it is in '}
            <a href={other === 'chat' ? meetPath(convKey) : inboxPath(convKey)} onClick={(e) => follow(e, other === 'chat' ? meetPath(convKey) : inboxPath(convKey), go)} data-testid="look-elsewhere">
              {tabNameOf(other)}
            </a>
            .
          </p>
        )}
        {f.signin ? (
          <p>
            <button type="button" className="linkish" onClick={() => window.location.reload()}>
              Reload the page
            </button>{' '}
            to sign in again.
          </p>
        ) : (
          <p>
            <button type="button" className="btn" onClick={() => void load(false)}>
              Try again
            </button>
          </p>
        )}
      </div>
    )
  }

  // What is told of closes and reopens is told in the conversation it is about, and nowhere else.
  const here = new Set(loaded.answer.threads.map((t) => t.conversationId))
  const told = pending.told.filter((t) => t.ids.some((id) => here.has(id)))

  return (
    <ConversationView
      me={me}
      scope={scope}
      now={now}
      answer={loaded.answer}
      sources={loaded.sources}
      loadingEarlier={loadingEarlier}
      onEarlier={() => void earlier()}
      way={way}
      onWay={(w) => {
        wayChosen.current = true
        setWay(w)
      }}
      threadId={threadId}
      onThread={setThreadId}
      compose={compose}
      onText={(t) => setCompose((c) => typed(c, t))}
      onAttach={(files) => setCompose((c) => attached(c, files))}
      onDetach={(i) => setCompose((c) => detached(c, i))}
      onPicture={(file) => choosePicture(file, setCompose)}
      onTakeOutPicture={() => setCompose((c) => withoutPicture(c))}
      onSend={() => void send()}
      onSendAndClose={() => void send(true)}
      onClose={() => void closeThreads(loaded.answer.change.close, false)}
      onReopen={(press) => {
        // The second click of a double click on Close lands on the Reopen that replaces it; so does one a moment after. An undo is a deliberate press, later.
        if ((press?.detail ?? 0) > 1 || Date.now() - closedAt.current < REOPEN_AFTER_CLOSE_MS) return
        void reopenThreads()
      }}
      reopen={offer === null ? null : { label: offer.label, title: offer.title }}
      changing={changing}
      spamming={changing}
      onSpam={(id, spam) => void markSpam(id, spam)}
      changed={changed ?? told.find((t) => t.notice.tone === 'ok')?.notice ?? null}
      problems={told.filter((t) => t.notice.tone !== 'ok').map((t) => ({ seq: t.seq, notice: t.notice }))}
      onDismissProblem={(seq) => changes.dismiss([seq])}
      onDismiss={() => setCompose(dismissed())}
      drafts={drafts}
      onSendDraft={(d) => void sendDraft(d)}
      onDismissDraft={(id) =>
        setDrafts((m) => {
          const { [id]: _gone, ...rest } = m
          return rest
        })
      }
      onDraftChanged={() => void load(true)}
      profileOpen={profileOpen}
      onProfile={setProfileOpen}
      timelineRef={timeline}
      calls={calls}
      onOpenCall={(name) => go(callPath(name))}
      channel={{ go, onChanged }}
      chat={{ ...chatTools, newFrom: newFromHeld.current ?? null }}
      onBack={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        go(tabPathOf(scope))
      }}
    />
  )
}

