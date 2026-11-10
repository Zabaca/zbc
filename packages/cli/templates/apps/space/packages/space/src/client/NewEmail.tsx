// A new email from scratch, in the Inbox's detail pane: who it is to (any address, or someone the space already knows), what it is about, the words, the mailbox it goes
// out from, and files where that mailbox allows them. The space only replied before; the inbox's own page was the one place a new email could begin.
//
// `NewEmailView` draws the box from its state and is pure, so the tests draw it with literal ones. `NewEmailPane` keeps the state and sends. Every send carries a key made once for that
// message (compose.ts): pressing Send twice, or after the connection dropped, cannot send twice, and a refusal gives the message back with the same key. The sender is a mailbox the inbox
// lists, never an address typed. NOTHING HERE IS CLAUDE'S: this is the person pressing Send, and Claude's sending switch is not involved.
import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { InboxMailboxes } from '@space/workspace'
import type { PeopleAnswer } from '../people'
import { write, writeForm } from './api'
import { type Compose, EM_DASH, attached, begin, dismissed, detached, filesOf, mintKey, newCompose, outcomeFromResponse, requestFor, settle, typed } from './compose'
import { AttachFiles } from './Files'
import { Glyph } from './icons'
import { AUTOMATIC, type FromChoice, type FromOption, addressOf, canChoose, canSendNew, filesAllowed, fromOf, fromOptions, nameIn, whyNotNew } from './newmailRules'
import { useJson } from './People'
import { INBOX, inboxPath } from './route'
import { useView } from './views'

/** The key the detail pane is on for a new email: not a person's address, so it can never be a conversation's. */
export const NEW_EMAIL = 'new-email'

/** Someone the space knows, to be picked in the To box. */
export interface Suggestion {
  address: string
  name: string
  /** Where a new email to them goes out from when From is left on Automatic (the inbox's rule), when the inbox says. */
  sendsFrom: { name: string; address: string } | null
}

/** The people the space knows by address, once each, the ones with a name first. Automated senders are not offered: nobody writes to a newsletter. */
export function suggestionsOf(people: PeopleAnswer | null): Suggestion[] {
  const seen = new Set<string>()
  const out: Suggestion[] = []
  for (const e of people?.entries ?? []) {
    if (e.automated) continue
    for (const address of e.addresses) {
      if (seen.has(address)) continue
      seen.add(address)
      out.push({ address, name: e.name, sendsFrom: e.sendsFrom })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address))
}

export interface ViewProps {
  to: string
  onTo(to: string): void
  subject: string
  onSubject(subject: string): void
  from: FromChoice
  onFrom(from: FromChoice): void
  options: readonly FromOption[]
  /** Why the From choices are only the automatic one: the inbox's mailboxes could not be read. Null when they were. */
  optionsProblem: string | null
  suggestions: readonly Suggestion[]
  /** The account an email left on Automatic goes from, said under From so the person sees it before Send; null when From names one, or the inbox cannot say. */
  automaticFrom: { name: string; address: string } | null
  compose: Compose
  onText(text: string): void
  onAttach(files: File[]): void
  onDetach(index: number): void
  onSend(): void
  onDismiss(): void
  /** Where the email just sent can be read (its person), when it went but the box stays to say so. */
  sentTo: string | null
  onOpen(address: string): void
  /** Back to the list, on a phone, where the box takes the screen. */
  onBack(e: MouseEvent<HTMLAnchorElement>): void
}

/** Who the To box names, when the space knows them: their name, for the line under the box. */
function knownAs(to: string, suggestions: readonly Suggestion[]): string | null {
  const address = addressOf(to)
  const name = address === null ? null : (suggestions.find((s) => s.address === address)?.name ?? null)
  // A contact the inbox made from an address alone is named by it: saying it again under the box tells the person nothing.
  return name === address ? null : name
}

export function NewEmailView(p: ViewProps) {
  const locked = p.compose.phase !== 'writing'
  const files = filesOf(p.compose)
  const email = { to: p.to, subject: p.subject, from: p.from }
  const why = whyNotNew(email, p.compose)
  const known = knownAs(p.to, p.suggestions)
  const dash = `${p.subject}${p.compose.text}`.includes(EM_DASH)
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      p.onSend()
    }
  }
  return (
    <form
      className="newmail"
      data-testid="new-email"
      onSubmit={(e) => {
        e.preventDefault()
        p.onSend()
      }}
    >
      <a className="back" href={INBOX} onClick={p.onBack} data-testid="back">
        <Glyph name="back" size={14} />
        Inbox
      </a>
      <div className="d-head e-head">
        <div className="grow">
          <h2 data-testid="new-email-title">New email</h2>
          <div className="sub">Write to anyone. It goes from the mailbox you choose.</div>
        </div>
      </div>
      <div className="newmail-body">
        {p.compose.notice && (
          <p className={`cnotice ${p.compose.notice.tone}`} role={p.compose.notice.tone === 'error' ? 'alert' : 'status'} data-testid="compose-notice" data-tone={p.compose.notice.tone}>
            <Glyph name={p.compose.notice.tone === 'ok' ? 'mail' : 'warn'} size={13} />
            <span>
              {p.compose.notice.text}
              {p.sentTo !== null && (
                <>
                  {' '}
                  <button type="button" className="linkish" onClick={() => p.onOpen(p.sentTo as string)} data-testid="open-sent">
                    Open the conversation with {p.sentTo}
                  </button>
                </>
              )}
            </span>
          </p>
        )}
        <label className="nm-field">
          <span className="nm-label">To</span>
          <input
            type="text"
            inputMode="email"
            autoComplete="off"
            list="new-email-people"
            value={p.to}
            readOnly={locked}
            placeholder="name@example.com"
            onChange={(e) => p.onTo(e.target.value)}
            data-testid="new-to"
            aria-label="To"
          />
          <datalist id="new-email-people">
            {p.suggestions.map((s) => (
              <option key={s.address} value={s.address} label={s.name} />
            ))}
          </datalist>
        </label>
        {known !== null && (
          <p className="sub nm-known" data-testid="new-known">
            {known}
          </p>
        )}
        <label className="nm-field">
          <span className="nm-label">From</span>
          <select value={p.from} disabled={locked} onChange={(e) => p.onFrom(e.target.value as FromChoice)} aria-label="From" data-testid="new-from">
            {p.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {p.from === AUTOMATIC && p.automaticFrom !== null && (
          <p className="sub nm-known" data-testid="new-from-auto">
            Automatic sends this from {p.automaticFrom.name === p.automaticFrom.address ? p.automaticFrom.address : `${p.automaticFrom.name} (${p.automaticFrom.address})`}.
          </p>
        )}
        {p.optionsProblem !== null && (
          <p className="sub nm-known" data-testid="new-from-problem">
            {p.optionsProblem}
          </p>
        )}
        <label className="nm-field">
          <span className="nm-label">Subject</span>
          <input type="text" value={p.subject} readOnly={locked} onChange={(e) => p.onSubject(e.target.value)} data-testid="new-subject" aria-label="Subject" maxLength={300} />
        </label>
        <textarea rows={9} value={p.compose.text} readOnly={locked} onChange={(e) => p.onText(e.target.value)} onKeyDown={onKey} placeholder="Write your email" aria-label="Your email" data-testid="compose-text" />
        {filesAllowed(p.from) ? (
          <AttachFiles files={files} onAdd={p.onAttach} onRemove={p.onDetach} disabled={locked} />
        ) : (
          <p className="sub nm-known" data-testid="new-no-files">
            {files.length > 0 ? 'Files go from a business mailbox only: choose one in From, or take the files out.' : 'To attach files, choose a business mailbox in From.'}
          </p>
        )}
        {dash && (
          <p className="sub nm-known" data-testid="new-dash">
            There is an em dash in this. The inbox will not send it: it reads as machine-written. Use a comma, a colon or a full stop.
          </p>
        )}
        <div className="composer-bar">
          {why !== null && p.compose.phase === 'writing' && (
            <span className="sub" data-testid="new-why">
              {why}
            </span>
          )}
          <span className="grow" />
          {p.compose.phase === 'unknown' ? (
            <button type="button" className="btn" onClick={p.onDismiss} data-testid="write-another">
              Write another email
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={!canSendNew(email, p.compose)} data-testid="send" data-what="new">
              {p.compose.phase === 'sending' ? 'Sending' : 'Send email'}
            </button>
          )}
        </div>
      </div>
    </form>
  )
}

export interface PaneProps {
  /** An address to start with (the page was opened to write to someone). */
  to?: string
  /** Something was sent: the lists and the menu's counts are read again. */
  onChanged(): void
  go(path: string): void
}

/**
 * The box with its state. Sent means the person's conversation opens, where the email is the last thing in it; Gmail or Cloudflare not saying whether it went (`sending`) or the
 * space losing track of it (`unknown`) keep the box, say so in words, and offer no second try with the same words.
 */
export function NewEmailPane({ to: start = '', onChanged, go }: PaneProps) {
  const [to, setTo] = useState(start)
  const [subject, setSubject] = useState('')
  const [from, setFrom] = useState<FromChoice>(AUTOMATIC)
  const [compose, setCompose] = useState<Compose>(() => newCompose(mintKey))
  const [sentTo, setSentTo] = useState<string | null>(null)
  const busy = useRef(false)
  const people = useJson<PeopleAnswer>('/api/people')
  const mailboxes = useView<InboxMailboxes>('mailboxes')

  // The address in the page's own address changes (a link to write to someone else): the box starts on it, unless words are being written.
  useEffect(() => {
    if (start !== '' && compose.text === '' && subject === '') setTo(start)
  }, [start, compose.text, subject])

  const options = useMemo(() => fromOptions(mailboxes.state.kind === 'value' ? mailboxes.state.value : null), [mailboxes.state])
  const suggestions = useMemo(() => suggestionsOf(people.value), [people.value])
  // What Automatic means for the address typed: the account that person last wrote to (the people list says), else the inbox's default Gmail account.
  const automaticFrom = useMemo(() => {
    const typed = addressOf(to)
    const known = typed === null ? undefined : suggestions.find((s) => s.address === typed)?.sendsFrom
    if (known) return known
    const accounts = mailboxes.state.kind === 'value' ? mailboxes.state.value.gmailAccounts : []
    const fallback = accounts.find((g) => g.sendsByDefault === true && g.connected && g.state !== 'lapsed')
    return fallback ? { name: fallback.name, address: fallback.address } : null
  }, [to, suggestions, mailboxes.state])
  // A choice the inbox no longer lists (a mailbox that went) is not kept: the box falls back to automatic rather than sending from something it cannot name.
  useEffect(() => {
    if (!options.some((o) => o.value === from)) setFrom(AUTOMATIC)
  }, [options, from])

  const reset = () => {
    setTo('')
    setSubject('')
    setFrom(AUTOMATIC)
  }

  const send = async () => {
    const email = { to, subject, from }
    if (busy.current || !canSendNew(email, compose)) return
    const address = addressOf(to)
    if (address === null) return
    busy.current = true
    const begun = begin(compose)
    setCompose(begun)
    const name = nameIn(to)
    const sender = fromOf(from)
    const req = requestFor({ via: 'new', address, subject: subject.trim(), ...(name !== null && { name }), ...(sender !== undefined && { from: sender }) }, begun.key, begun.text)
    const files = filesOf(begun)
    const outcome = outcomeFromResponse(files.length > 0 ? await writeForm('/api/email/files', req.body, files) : await write(req.url, req.body))
    const after = settle(begun, outcome, 'email')
    busy.current = false
    const went = (outcome.result === 'done' && outcome.status === 'sent') || (outcome.result === 'repeated' && outcome.earlier === 'sent')
    // The space lost track of it: it may have gone, so the person is pointed at the conversation to look, and offered no second try with the same words.
    if (outcome.result === 'outcome-unknown') setSentTo(address)
    if (outcome.result === 'done' || outcome.result === 'repeated') {
      onChanged()
      // It went: the person's conversation opens with it in. Not said to have gone (Gmail never said): the box stays to say so, and points at the conversation.
      if (went) return go(inboxPath(address))
      reset()
      setSentTo(address)
    }
    setCompose(after)
  }

  // Only Automatic is offered when the inbox's mailboxes could not be read, or when the inbox does not say it can honour a chosen mailbox and files (an older inbox would ignore both).
  const problem =
    mailboxes.state.kind === 'said'
      ? 'The inbox’s mailboxes could not be read, so only Automatic is offered. It goes from the mailbox they last wrote to, else your Gmail.'
      : mailboxes.state.kind === 'value' && !canChoose(mailboxes.state.value)
        ? 'The inbox has not been updated to send from a mailbox you choose or with files, so only Automatic is offered. It goes from the mailbox they last wrote to, else your Gmail.'
        : null
  return (
    <NewEmailView
      to={to}
      onTo={setTo}
      subject={subject}
      onSubject={setSubject}
      from={from}
      onFrom={setFrom}
      options={options}
      optionsProblem={problem}
      suggestions={suggestions}
      automaticFrom={automaticFrom}
      compose={compose}
      onText={(t) => setCompose((c) => typed(c, t))}
      onAttach={(files) => setCompose((c) => attached(c, files))}
      onDetach={(i) => setCompose((c) => detached(c, i))}
      onSend={() => void send()}
      onDismiss={() => {
        setCompose(dismissed())
        reset()
        setSentTo(null)
      }}
      sentTo={sentTo}
      onOpen={(address) => go(inboxPath(address))}
      onBack={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        go(INBOX)
      }}
    />
  )
}
