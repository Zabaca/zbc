// The People tab (the directory, with some extras): the people the space knows, grouped Clients, Outside and Team (no channels), and a person's
// page. A person's page is their profile: for someone outside the team their inbox contact (name, addresses, Client) with three fields People adds (the business they are with, their
// role there and a note), editable here and beside their conversation (`ProfileFields`); for a teammate the company layer's person. Its buttons open their email (in the Inbox) and their chat (in Meet). The extras are
// the inbox's own: link them to a Client, merge two entries that are one person (and undo it), and the documents out with them.
//
// What the page is told comes from the Worker's two reads (`/api/people`, `/api/person`, src/people.ts) and its writes are the inbox's views (`/api/inbox/contact-profile`,
// `contact-merge`, `contact-unmerge`, `client-link`: src/views.ts). A write is never retried, and a save names the revision the person was shown at: when they have changed since, the
// inbox refuses and nothing is lost, because what was typed stays in the boxes beside the newer details.
import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { Client, DocumentState, InboxClients, InboxContactProfile, InboxMerged, InboxSplitDone, InboxUnmerged } from '@space/workspace'
import { type DocumentsPart, documentLine } from '../documents'
import type { PeopleAnswer, PeopleEntry, PeopleSide, PersonAnswer } from '../people'
import { type Problem, read } from './api'
import { NewClientForm } from './ClientsView'
import { documentPath } from './day'
import { ago, initials, noticesFor } from './format'
import { Glyph } from './icons'
import { useFresh } from './liveHub'
import { inboxPath, meetPath, peoplePath, personKey, settingsItemPath } from './route'
import { Ask, Say, Viewed, useAction, when } from './settings-parts'
import { type Said, postView, useView } from './views'

type Go = (path: string) => void

/** A click inside the space moves without reloading, unless it means "open it somewhere else". */
function follow(e: MouseEvent<HTMLAnchorElement>, path: string, go: Go): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  go(path)
}

// ── Reading from the Worker ───────────────────────────────────────────────────────────────────────────────────────────────

/** What a read holds: the last value (kept while it is read again), why the last read did not come, and whether one is on its way. */
interface Got<T> {
  value: T | null
  problem: { kind: Problem; status?: number; message?: string } | null
  loading: boolean
}

/** A JSON read kept on screen: read when mounted and when `url` changes, and again on `reload`. */
export function useJson<T>(url: string): Got<T> & { reload(): void } {
  const [state, setState] = useState<Got<T>>({ value: null, problem: null, loading: true })
  const [tick, setTick] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is a reload.
  useEffect(() => {
    const ctl = new AbortController()
    setState((s) => ({ ...s, loading: true }))
    void read<T>(url, ctl.signal).then((r) => {
      if (ctl.signal.aborted) return
      if (r.ok) setState({ value: r.value, problem: null, loading: false })
      else setState((s) => ({ value: s.value, problem: { kind: r.problem, ...(r.status !== undefined && { status: r.status }), ...(r.message !== undefined && { message: r.message }) }, loading: false }))
    })
    return () => ctl.abort()
  }, [url, tick])
  const reload = useCallback(() => setTick((n) => n + 1), [])
  return { ...state, reload }
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const SIDE_TITLE: Record<PeopleSide, string> = { client: 'Clients', outside: 'Outside', team: 'Team' }

/** The groups of the list, in order: the three sides without the automated senders, then those, when they are listed. */
const GROUPS: readonly { id: string; title: string; has(e: PeopleEntry): boolean }[] = [
  ...(['client', 'outside', 'team'] as const).map((side) => ({ id: side, title: SIDE_TITLE[side], has: (e: PeopleEntry) => e.side === side && !e.automated })),
  { id: 'automated', title: 'Automated', has: (e) => e.automated },
]

/** What a person is described by under their name: their business and role, else their address, else what they are. */
export function subtitleOf(e: PeopleEntry): string {
  if (e.side === 'team') return e.team ? (e.team.role === 'owner' ? 'Owner' : e.team.role === 'member' ? 'Team member' : 'Teammate') : 'Teammate'
  const work = [e.business, e.role].filter((x) => x !== '').join(', ')
  if (work !== '') return work
  if (e.client) return e.client.name
  return e.addresses[0] ?? (e.guest ? 'Channel guest' : 'No email address')
}

/** The names a merge asks about: "Dana R. (dreyes@mail.example)". */
export const optionName = (e: PeopleEntry): string => `${e.name} (${e.addresses[0] ?? 'no email address'})`

// ── The list ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Mark({ entry }: { entry: Pick<PeopleEntry, 'name' | 'side'> }) {
  const letters = initials(entry.name)
  return (
    <span className={`avatar-lg ${entry.side === 'team' ? 'team' : 'outside'}`} aria-hidden="true">
      {letters || <Glyph name="person" size={14} />}
    </span>
  )
}

function Row({ entry, on, go }: { entry: PeopleEntry; on: boolean; go: Go }) {
  return (
    <li>
      <a className={`row${on ? ' on' : ''}`} href={peoplePath(entry.key)} onClick={(e) => follow(e, peoplePath(entry.key), go)} aria-current={on ? 'true' : undefined} data-testid="person" data-key={entry.key} data-side={entry.side}>
        <Mark entry={entry} />
        <span className="row-main">
          <span className="row-top">
            <span className="row-title">{entry.name}</span>
          </span>
          <span className="sub clamp">{subtitleOf(entry)}</span>
          <span className="row-badges">
            {entry.client && (
              <span className="clientpill" title={`Linked to ${entry.client.name}`} data-testid="client-pill">
                {entry.client.name}
              </span>
            )}
            {!entry.client && entry.suggestedClient && (
              <span className="clientpill suggested" title={`The inbox suggests ${entry.suggestedClient.name}. Not counted until it is linked.`} data-testid="client-suggested">
                {entry.suggestedClient.name} ?
              </span>
            )}
            {entry.guest && <span className="kindtag">Channel guest</span>}
          </span>
        </span>
      </a>
    </li>
  )
}

const matches = (e: PeopleEntry, q: string): boolean => {
  const needle = q.trim().toLowerCase()
  if (needle === '') return true
  return [e.name, e.business, e.role, e.client?.name ?? '', ...e.addresses].some((x) => x.toLowerCase().includes(needle))
}

export interface ScreenProps {
  answer: PeopleAnswer | null
  loading: boolean
  problem: Problem | null
  query: string
  onQuery(q: string): void
  selected: string | null
  /** Whether the automated senders are listed (under Automated). They are counted and left out until asked for, so a real person the inbox misjudged can still be found. */
  showAutomated: boolean
  onShowAutomated(show: boolean): void
  detail?: ReactNode
  go: Go
}

/** The directory beside a person's page. Pure: the tests draw it with literal answers. */
export function PeopleScreen(p: ScreenProps) {
  const shown = p.answer ? p.answer.entries.filter((e) => matches(e, p.query)) : []
  const notices = p.answer ? noticesFor(p.answer.parts) : []
  return (
    <div className={`split${p.selected !== null ? ' open' : ''}`}>
      <section className="list" aria-labelledby="h-people" aria-busy={p.loading}>
        <header className="list-head">
          <h1 id="h-people">People</h1>
          {p.answer && (
            <span className="sub" data-testid="count">
              {p.answer.entries.filter((e) => !e.automated).length} {p.answer.entries.filter((e) => !e.automated).length === 1 ? 'person' : 'people'}
            </span>
          )}
        </header>
        <form className="search" role="search" onSubmit={(e) => e.preventDefault()}>
          <Glyph name="search" size={13} />
          <input type="search" name="q" value={p.query} onChange={(e) => p.onQuery(e.target.value)} placeholder="Find a person" aria-label="Find a person" autoComplete="off" data-testid="find" />
          {p.query !== '' && (
            <button type="button" className="clear" aria-label="Clear the search" onClick={() => p.onQuery('')}>
              <Glyph name="x" size={12} />
            </button>
          )}
        </form>
        {p.problem === 'signin' && (
          <p className="notice unreachable" role="alert" data-notice="signin">
            <Glyph name="warn" size={13} />
            <span>Your sign-in may have ended. Reload the page to sign in again.</span>
          </p>
        )}
        {p.problem === 'network' && (
          <p className="notice unreachable" role="status" data-notice="network">
            <Glyph name="warn" size={13} />
            <span>The space could not be reached just now. {p.answer ? 'This is the last list it had.' : 'It will be tried again.'}</span>
          </p>
        )}
        {notices.length > 0 && (
          <div className="notices">
            {notices.map((n) => (
              <p key={n.part} className={`notice ${n.kind}`} role="status" data-notice={n.kind} data-part={n.part}>
                <Glyph name={n.kind === 'unreachable' ? 'warn' : 'lock'} size={13} />
                <span>{n.text}</span>
              </p>
            ))}
          </div>
        )}
        {!p.answer && p.loading && (
          <p className="empty-line sub" role="status" data-testid="loading">
            Loading people
          </p>
        )}
        {p.answer && shown.length === 0 && p.answer.parts.every((x) => x.state === 'ok') && (
          <p className="empty-line sub" data-testid="empty-people">
            {p.query.trim() === '' ? 'No one is listed yet. Clients, outside people and your team will be here, each with a profile.' : `No one matches “${p.query.trim()}”.`}
          </p>
        )}
        {GROUPS.map(({ id, title, has }) => {
          const group = shown.filter(has)
          if (group.length === 0) return null
          return (
            <section key={id} aria-label={title} data-testid={`group-${id}`}>
              <h2 className="p-group">
                {title} <span className="sub">{group.length}</span>
              </h2>
              <ul className="rows">
                {group.map((e) => (
                  <Row key={e.key} entry={e} on={e.key === p.selected} go={p.go} />
                ))}
              </ul>
            </section>
          )
        })}
        {p.answer && p.answer.automated > 0 && (
          <p className="foot sub" data-testid="automated">
            {p.answer.automated} automated {p.answer.automated === 1 ? 'sender' : 'senders'} (newsletters, receipts, no-reply addresses) {p.answer.automated === 1 ? 'is' : 'are'} {p.showAutomated ? 'listed above' : 'not listed'}.{' '}
            <button type="button" className="linkish" onClick={() => p.onShowAutomated(!p.showAutomated)} data-testid="toggle-automated">
              {p.showAutomated ? 'Hide automated' : `Show automated (${p.answer.automated})`}
            </button>
          </p>
        )}
      </section>
      <div className="detail" data-testid="detail">
        {p.detail ?? (
          <div className="detail-note">
            <p>Pick a person.</p>
            <p className="sub">Who they are, their documents, and a button to their email or their chat.</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── The three fields ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Fields {
  business: string
  role: string
  notes: string
}

const fieldsOf = (p: Fields): Fields => ({ business: p.business, role: p.role, notes: p.notes })
const sameFields = (a: Fields, b: Fields): boolean => a.business === b.business && a.role === b.role && a.notes === b.notes

/**
 * Business, role and a note, for someone outside the team: three boxes and Save. The save names the revision the boxes were started from (`synced`), so the inbox refuses it when
 * the person has changed since; nothing typed is then lost, because the boxes keep it and the newer details are shown under them with a way to take them instead. A save that
 * goes through leaves the boxes as they were saved and tells the page to read again (`onChanged`).
 */
export function ProfileEditor({ profile, onChanged, compact = false }: { profile: InboxContactProfile; onChanged(): void; compact?: boolean }) {
  const [draft, setDraft] = useState<Fields>(fieldsOf(profile))
  const [base, setBase] = useState<{ rev: number; fields: Fields }>({ rev: profile.rev, fields: fieldsOf(profile) })
  const action = useAction()
  const dirty = !sameFields(draft, base.fields)
  const newer = profile.rev > base.rev
  // Nothing typed and the person moved on: take the newer details without asking. Only a NEWER revision is taken: right after a save the boxes are at the saved revision and the
  // page still holds the one before it until it has read again, and that older one must not put the old text back.
  useEffect(() => {
    if (profile.rev > base.rev && !dirty) {
      setBase({ rev: profile.rev, fields: fieldsOf(profile) })
      setDraft(fieldsOf(profile))
    }
  }, [profile, base.rev, dirty])

  const save = async () => {
    await action.run(
      () => postView<InboxContactProfile>('contact-profile', { contactId: profile.contactId, rev: base.rev, ...draft }),
      'Saved.',
      (saved) => {
        setBase({ rev: saved.rev, fields: fieldsOf(saved) })
        setDraft(fieldsOf(saved))
      },
    )
    // Saved or refused, the page reads the person again: a refusal is the person having moved on, and the newer details are what the boxes are shown beside.
    onChanged()
  }
  const set = (key: keyof Fields) => (e: { target: { value: string } }) => {
    action.clear()
    setDraft((d) => ({ ...d, [key]: e.target.value }))
  }
  return (
    <form
      className={`p-fields${compact ? ' compact' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (dirty && !action.busy) void save()
      }}
      data-testid="profile-fields"
    >
      <label className="p-field">
        <span className="sub">Business</span>
        <input value={draft.business} onChange={set('business')} maxLength={200} autoComplete="off" placeholder="The business they are with" data-testid="field-business" />
      </label>
      <label className="p-field">
        <span className="sub">Role</span>
        <input value={draft.role} onChange={set('role')} maxLength={200} autoComplete="off" placeholder="What they do there" data-testid="field-role" />
      </label>
      <label className="p-field">
        <span className="sub">Notes</span>
        <textarea value={draft.notes} onChange={set('notes')} rows={compact ? 4 : 5} maxLength={10_000} placeholder="Add a note about this person" data-testid="field-notes" />
      </label>
      {newer && dirty && (
        <div className="cnotice warn p-newer" role="status" data-testid="newer">
          <Glyph name="warn" size={13} />
          <div>
            <p>
              This person was changed since you opened them, so nothing you typed was saved. It is still in the boxes. As they are now: business “{profile.business}”, role “{profile.role}”, notes “{profile.notes}”.
            </p>
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setBase({ rev: profile.rev, fields: fieldsOf(profile) })
                setDraft(fieldsOf(profile))
                action.clear()
              }}
              data-testid="take-newer"
            >
              Use these instead of what I typed
            </button>
          </div>
        </div>
      )}
      <div className="s-actions">
        <button type="submit" className="btn primary" disabled={!dirty || action.busy || newer} data-testid="save-profile">
          {action.busy ? 'Saving' : 'Save'}
        </button>
        {dirty && !action.busy && !newer && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setDraft(base.fields)
              action.clear()
            }}
          >
            Discard
          </button>
        )}
      </div>
      {action.say && !action.say.conflict && <Say say={action.say} />}
      {action.say?.conflict && !newer && <Say say={action.say} />}
      {action.done && !dirty && (
        <p className="sub" role="status" data-testid="saved">
          {action.done}
        </p>
      )}
    </form>
  )
}

// ── The Client ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function ClientPicker({ busy, onLink, onMake, makeSay, madeCount, onCancel }: { busy: boolean; onLink(id: number): void; onMake(names: { name: string; legalName: string }): void; makeSay: Said | null; madeCount: number; onCancel(): void }) {
  const view = useView<InboxClients>('clients')
  // A Client made in Settings (or sent in by its source) is offered at once; one made from here is offered even where the link that followed it failed.
  useFresh(['clients'], view.reload)
  const { reload } = view
  useEffect(() => {
    if (madeCount > 0) reload()
  }, [madeCount, reload])
  const [choice, setChoice] = useState('')
  const [making, setMaking] = useState(false)
  return (
    <Viewed view={view.state} problem={view.problem} reload={view.reload} loading="Loading the Clients">
      {(answer) => (
        <div className="p-pick">
          {!answer.directory.available && (
            <p className="cnotice warn" role="status" data-testid="directory-down">
              {answer.directory.error ?? 'The Client list did not answer, so nothing can be linked just now.'}
            </p>
          )}
          <select aria-label="Client" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={!answer.directory.available} data-testid="client-select">
            <option value="">Choose a Client</option>
            {answer.clients
              .filter((c) => c.listed && !c.archived)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <div className="s-actions">
            <button type="button" className="btn primary" disabled={busy || choice === '' || !answer.directory.available} onClick={() => onLink(Number(choice))} data-testid="link-client">
              Link
            </button>
            <button type="button" className="btn" onClick={() => setMaking(true)} disabled={busy || making} data-testid="new-client-here">
              New Client
            </button>
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
          {making && <NewClientForm onCancel={() => setMaking(false)} say={makeSay} busy={busy} submit={onMake} />}
        </div>
      )}
    </Viewed>
  )
}

/** The Client a person is linked to, the one the inbox only suggests, and the way to link or take them out, or to make a Client and link them in one press. A Client the Clients part does not hold, or holds archived, cannot be linked. */
export function ClientSection({ profile, onChanged, go }: { profile: InboxContactProfile; onChanged(): void; go?: Go }) {
  const action = useAction()
  const [picking, setPicking] = useState(false)
  const [makeBusy, setMakeBusy] = useState(false)
  const [madeSay, setMadeSay] = useState<Said | null>(null)
  const [madeDone, setMadeDone] = useState<string | null>(null)
  const [madeCount, setMadeCount] = useState(0)
  const link = async (clientId: number | null, done: string) => {
    setMadeDone(null)
    const ok = await action.run(() => postView('client-link', { contactId: profile.contactId, clientId }), done)
    if (ok) {
      setPicking(false)
      onChanged()
    }
  }
  // New Client from here is two writes, the Client in the Clients part's store and the link in the inbox's, not one transaction: if the second fails the Client exists, the sentence says the person was not linked, and the
  // Client is in the picker to link by hand.
  const makeAndLink = async (names: { name: string; legalName: string }) => {
    setMadeSay(null)
    setMadeDone(null)
    action.clear()
    setMakeBusy(true)
    try {
      const made = await postView<Client>('clients/make', { name: names.name, legalName: names.legalName.trim() === '' ? null : names.legalName })
      if (!made.ok) return setMadeSay(made.say)
      setMadeCount((n) => n + 1)
      const linked = await postView('client-link', { contactId: profile.contactId, clientId: made.value.number })
      if (!linked.ok) return setMadeSay({ tone: 'warn', text: `${made.value.name} was made, but ${profile.name} was not linked to it: ${linked.say.text} The Client is in the list above to link by hand.`, again: false })
      setPicking(false)
      setMadeDone(`Made ${made.value.name} and linked ${profile.name} to it.`)
      onChanged()
    } finally {
      setMakeBusy(false)
    }
  }
  const busy = action.busy || makeBusy
  return (
    <section className="p-section" aria-label="Client" data-testid="client-section">
      <h3 className="s-cap">Client</h3>
      {profile.client ? (
        <div className="p-line">
          <p data-testid="client-name">
            Linked to{' '}
            {go ? (
              <a href={settingsItemPath('clients', profile.client.id)} onClick={(e) => follow(e, settingsItemPath('clients', (profile.client as { id: number }).id), go)} data-testid="client-link">
                <b>{profile.client.name}</b>
              </a>
            ) : (
              <b>{profile.client.name}</b>
            )}
            .
          </p>
          <button type="button" className="btn" disabled={busy} onClick={() => void link(null, 'Taken out of that Client.')} data-testid="unlink-client">
            Take out
          </button>
        </div>
      ) : (
        <>
          <p className="sub">Not linked to a Client.</p>
          {profile.suggestedClient && (
            <div className="p-line dashed" data-testid="suggestion">
              <p>
                The inbox suggests <b>{profile.suggestedClient.name}</b>. It counts for nothing until you link them.
              </p>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void link((profile.suggestedClient as { id: number }).id, `Linked to ${profile.suggestedClient?.name}.`)} data-testid="link-suggested">
                Link to {profile.suggestedClient.name}
              </button>
            </div>
          )}
          {picking ? (
            <ClientPicker busy={busy} onLink={(id) => void link(id, 'Linked. They count as that Client’s people now.')} onMake={(names) => void makeAndLink(names)} makeSay={madeSay} madeCount={madeCount} onCancel={() => setPicking(false)} />
          ) : (
            <div className="s-actions">
              <button type="button" className="btn" onClick={() => setPicking(true)} data-testid="choose-client">
                Link to a Client
              </button>
            </div>
          )}
        </>
      )}
      {action.say && <Say say={action.say} />}
      {(action.done ?? madeDone) && (
        <p className="sub" role="status" data-testid="client-done">
          {action.done ?? madeDone}
        </p>
      )}
    </section>
  )
}

// ── Merging ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Two entries that are one person: pick the other, read what will happen, say yes. The inbox merges them at the revisions shown here, and the page can undo it straight after. */
export function MergeSection({ profile, entries, onMerged, onRefused }: { profile: InboxContactProfile; entries: readonly PeopleEntry[]; onMerged(m: InboxMerged): void; onRefused(): void }) {
  const action = useAction()
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState('')
  const [sure, setSure] = useState(false)
  const options = entries.filter((e) => e.contact !== null && e.contact.id !== profile.contactId && e.side !== 'team')
  const other = options.find((e) => e.contact?.id === choice)
  if (options.length === 0) return null
  const merge = async () => {
    if (!other?.contact) return
    const ok = await action.run(
      () => postView<InboxMerged>('contact-merge', { survivorId: profile.contactId, survivorRev: profile.rev, absorbedId: other.contact?.id, absorbedRev: other.contact?.rev }),
      (m) => `Merged ${m.absorbedName} into ${m.survivor.name}.`,
      onMerged,
    )
    if (ok) {
      setSure(false)
      setOpen(false)
      setChoice('')
    } else {
      // Refused (the usual reason: one of the two changed since they were shown) or not known to have gone through: the refusal says "shown as they are now", so they are read
      // again, the list and this person, and the next try names the revisions they have now. The question stays open and the refusal stays on screen.
      onRefused()
    }
  }
  return (
    <section className="p-section" aria-label="Merge" data-testid="merge-section">
      <h3 className="s-cap">Same person twice?</h3>
      {!open ? (
        <div className="s-actions">
          <button type="button" className="btn" onClick={() => setOpen(true)} data-testid="open-merge">
            Merge with another entry
          </button>
        </div>
      ) : (
        <>
          <select
            aria-label="The other entry"
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value)
              setSure(false)
              action.clear()
            }}
            data-testid="merge-select"
          >
            <option value="">Same person as</option>
            {options.map((e) => (
              <option key={e.key} value={e.contact?.id}>
                {optionName(e)}
              </option>
            ))}
          </select>
          {!sure && (
            <div className="s-actions">
              <button type="button" className="btn" disabled={other === undefined} onClick={() => setSure(true)} data-testid="merge-ask">
                Merge...
              </button>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          )}
          {sure && other && (
            <Ask question={`Merge ${other.name} into ${profile.name}?`} yes="Yes, merge" busy={action.busy} onYes={() => void merge()} onNo={() => setSure(false)}>
              <p className="sub">
                Their addresses and conversations move to {profile.name}, who keeps their own name and Client; a business, role or note left blank is filled from {other.name}. You can undo it right after.
              </p>
            </Ask>
          )}
        </>
      )}
      {action.say && <Say say={action.say} />}
    </section>
  )
}

// ── Documents ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function DocumentsSection({ part }: { part: DocumentsPart }) {
  return (
    <section className="p-section" aria-label="Documents" data-testid="documents">
      <h3 className="s-cap">Documents</h3>
      {part.state !== 'ok' && (
        <p className="notice unreachable" role="status" data-notice={part.state}>
          <Glyph name={part.state === 'not-open-to-you' ? 'lock' : 'warn'} size={13} />
          <span>{part.message}</span>
        </p>
      )}
      {part.state === 'ok' && part.documents.length === 0 && <p className="sub">No documents are out with them, and none came back.</p>}
      {part.state === 'ok' && part.documents.length > 0 && (
        <ul className="s-list">
          {part.documents.map((d) => (
            <li key={d.id} className="s-item" data-testid="document" data-state={d.state}>
              <div className="s-item-main">
                <p className="s-item-title">{d.title}</p>
                <p className="sub">
                  {documentLine(d)} · {when(d.at)}
                </p>
              </div>
              <a className="btn" href={documentPath(d.id)} data-testid="document-open">
                Open in Forms
              </a>
            </li>
          ))}
        </ul>
      )}
      {part.state === 'ok' && part.more && <p className="sub">Showing the newest. Older ones are in Forms.</p>}
    </section>
  )
}

// ── A person's page ───────────────────────────────────────────────────────────────────────────────────────────────────────

function TeamFactsList({ entry }: { entry: PeopleEntry }) {
  const t = entry.team
  const rows: [string, string][] = [
    ['Role', t ? (t.role === 'owner' ? 'Owner' : t.role === 'member' ? 'Team member' : 'Teammate') : 'Teammate'],
    ['Email', t?.address ?? entry.addresses[0] ?? 'No email address on file'],
    ...(t && t.signIn !== t.address ? ([['Signs in with', t.signIn]] as [string, string][]) : []),
    ...(t && t.sharedAddresses.length > 0 ? ([['Works', t.sharedAddresses.join(', ')]] as [string, string][]) : []),
  ]
  return (
    <dl className="facts" data-testid="team-facts">
      {rows.map(([k, v]) => (
        <div key={k} className="fact">
          <dt className="sub">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The ways to reach them. With two or more, each can be split off onto a contact of its own (the inbox's Split off, the way back from a wrong merge): its conversations go with it, and the person
 * keeps the rest. The inbox keeps a contact's only address, so none is offered for one. The split names the revision the person was shown, and the page then opens the new contact.
 */
export function Identities({ profile, onChanged, go }: { profile: InboxContactProfile; onChanged(): void; go: Go }) {
  const action = useAction()
  const split = async (identityId: string) => {
    let opened = null as string | null
    const ok = await action.run(
      () => postView<InboxSplitDone>('contact-split', { contactId: profile.contactId, rev: profile.rev, identityId }),
      (done) => `Split ${done.contact.name} off into a contact of its own.`,
      (done) => {
        opened = done.contact.addresses[0] ?? `mail:${done.contact.contactId}`
      },
    )
    // Split or refused, the person is read again (a refusal means they changed since they were shown); a split then opens the contact it made.
    onChanged()
    if (ok && opened !== null) go(peoplePath(opened))
  }
  return (
    <>
      <dl className="facts" data-testid="identities">
        {profile.identities.map((i) => (
          <div key={i.id} className="fact">
            <dt className="sub">{i.kind === 'email' ? 'Email' : i.kind === 'sms' ? 'Number' : i.kind === 'telegram' ? 'Telegram' : 'Handle'}</dt>
            <dd>
              {i.address}
              {profile.identities.length > 1 && (
                <button type="button" className="btn split" disabled={action.busy} aria-label={`Split ${i.address} off into its own contact`} onClick={() => void split(i.id)} data-testid="split-off">
                  Split off
                </button>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {action.say && <Say say={action.say} />}
    </>
  )
}

/** Rename them, at the revision shown: the inbox's own Rename, with its refusal of an empty name. */
export function RenameButton({ profile, onChanged }: { profile: InboxContactProfile; onChanged(): void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(profile.name)
  const action = useAction()
  if (!editing) {
    return (
      <button
        type="button"
        className="btn"
        onClick={() => {
          // The box starts from the name as it is NOW, never from the name this screen first saw.
          setName(profile.name)
          action.clear()
          setEditing(true)
        }}
        data-testid="rename"
      >
        Rename
      </button>
    )
  }
  const save = async () => {
    const ok = await action.run(() => postView<InboxContactProfile>('contact-rename', { contactId: profile.contactId, rev: profile.rev, name }), 'Renamed.')
    // Renamed or refused, the person is read again: a refusal because they changed since is then seen as they are now.
    onChanged()
    if (ok) setEditing(false)
  }
  return (
    <form
      className="p-rename"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      data-testid="rename-form"
    >
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" readOnly={action.busy} data-testid="rename-name" />
      <button type="submit" className="btn primary" disabled={action.busy} data-testid="rename-save">
        {action.busy ? 'Saving' : 'Save'}
      </button>
      <button type="button" className="btn" disabled={action.busy} onClick={() => setEditing(false)} data-testid="rename-cancel">
        Cancel
      </button>
      {action.say && <Say say={action.say} />}
    </form>
  )
}

/**
 * The Telegram groups they write in, newest first, each opening the group's row in the Inbox. Their own conversation holds what passed between the
 * two of you and the group's chatter is not in it, so this is where the groups are found from them. Nothing when they write in none.
 */
export function WritesIn({ groups, go }: { groups: InboxContactProfile['groups']; go?: Go }) {
  if (!groups || groups.length === 0) return null
  return (
    <section className="writes-in" data-testid="writes-in" aria-label="Telegram groups they write in">
      <h3 className="sub">Writes in</h3>
      <ul>
        {groups.map((g) => {
          const path = inboxPath(`mail:${g.contactId}`)
          return (
            <li key={g.contactId}>
              <a href={path} onClick={go ? (e) => follow(e, path, go) : undefined} data-testid="writes-in-group">
                <Glyph name="chat" size={13} />
                {g.name}
              </a>
              <span className="sub"> last wrote {ago(Date.now(), g.lastWroteAt)}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Their email conversation (in the Inbox) and their direct message (in Meet), whichever have something in them, or why there is none to open. A person may have both. */
function OpenConversation({ entry, go }: { entry: PeopleEntry; go: Go }) {
  if (entry.conversationKey === null) {
    return (
      <span className="sub" data-testid="no-conversation">
        Nothing has been said with them yet, so there is no conversation to open.
      </span>
    )
  }
  const email = inboxPath(entry.conversationKey)
  const chat = meetPath(entry.conversationKey)
  return (
    <>
      {entry.said.mail && (
        <a className="btn primary" href={email} onClick={(e) => follow(e, email, go)} data-testid="open-email">
          <Glyph name="mail" size={14} />
          Open email
        </a>
      )}
      {entry.said.chat && (
        <a className={`btn${entry.said.mail ? '' : ' primary'}`} href={chat} onClick={(e) => follow(e, chat, go)} data-testid="open-chat">
          <Glyph name="chat" size={14} />
          Open chat
        </a>
      )}
    </>
  )
}

export interface PersonViewProps {
  answer: PersonAnswer
  entries: readonly PeopleEntry[]
  go: Go
  onChanged(): void
  onMerged(m: InboxMerged): void
}

/** The page of one person, from the Worker's answer. */
export function PersonView({ answer, entries, go, onChanged, onMerged }: PersonViewProps) {
  const { entry, profile } = answer
  const notices = noticesFor(answer.parts).filter((n) => n.part === 'mail' && entry.side !== 'team')
  return (
    <div className="p-page" data-testid="person-page" data-side={entry.side}>
      <a className="back" href="/people" onClick={(e) => follow(e, '/people', go)} data-testid="back-to-people">
        <Glyph name="back" size={14} />
        People
      </a>
      <header className="p-head">
        <Mark entry={entry} />
        <h2 data-testid="person-name">{entry.name}</h2>
        <div className="sub">{subtitleOf(entry)}</div>
        <div className="tags">
          {entry.side === 'team' && <span className="pill accent">Teammate</span>}
          {entry.side === 'client' && <span className="pill accent">Client</span>}
          {entry.side === 'outside' && !entry.guest && <span className="pill">Not a client</span>}
          {entry.guest && <span className="pill">Channel guest</span>}
          {entry.automated && <span className="pill" title="The inbox judges this an automated sender. If it is a real person, their business, role and notes still work.">Automated sender</span>}
          {entry.client && (
            <a className="clientpill" href={settingsItemPath('clients', entry.client.id)} onClick={(e) => follow(e, settingsItemPath('clients', entry.client?.id ?? 0), go)} title="Open this Client’s page" data-testid="client-pill">
              {entry.client.name}
            </a>
          )}
        </div>
        <div className="p-head-acts">
          <OpenConversation entry={entry} go={go} />
          {profile && entry.side !== 'team' && <RenameButton profile={profile} onChanged={onChanged} />}
        </div>
      </header>

      {entry.side === 'team' ? (
        <TeamFactsList entry={entry} />
      ) : profile ? (
        <>
          {profile.sendsFrom != null && (
            <p className="sub" data-testid="sends-from">
              A new email to them goes from {profile.sendsFrom.name} ({profile.sendsFrom.address}) unless you choose another account.
            </p>
          )}
          <ProfileEditor profile={profile} onChanged={onChanged} />
          <Identities profile={profile} onChanged={onChanged} go={go} />
          <WritesIn groups={profile.groups} go={go} />
          <ClientSection profile={profile} onChanged={onChanged} go={go} />
          <MergeSection profile={profile} entries={entries} onMerged={onMerged} onRefused={onChanged} />
        </>
      ) : answer.profileState === 'none' ? (
        <p className="sub" data-testid="no-contact">
          They are in a channel but have not written, so there are no details to keep yet. Their business, role and notes are kept once they have an email conversation.
        </p>
      ) : (
        notices.map((n) => (
          <p key={n.part} className={`notice ${n.kind}`} role="status" data-notice={n.kind}>
            <Glyph name={n.kind === 'unreachable' ? 'warn' : 'lock'} size={13} />
            <span>{n.text}</span>
          </p>
        ))
      )}
      {entry.side !== 'team' && !profile && answer.profileState !== 'none' && answer.profileState !== 'ok' && (
        <p className="notice unreachable" role="status" data-notice={answer.profileState}>
          <Glyph name={answer.profileState === 'not-open-to-you' ? 'lock' : 'warn'} size={13} />
          <span>{answer.profileState === 'not-open-to-you' ? 'Their details are not open to you.' : 'Email could not be reached just now, so their details are not shown.'}</span>
        </p>
      )}

      <DocumentsSection part={answer.documents} />
    </div>
  )
}

function PersonPane({ pkey, entries, go, onChanged, onMerged }: { pkey: string; entries: readonly PeopleEntry[]; go: Go; onChanged(): void; onMerged(m: InboxMerged): void }) {
  const got = useJson<PersonAnswer>(`/api/person?key=${encodeURIComponent(pkey)}`)
  // A person's page draws their emails, chats and documents: it is read again when any of them moves.
  useFresh(['mail', 'chat', 'documents', 'clients'], got.reload)
  const changed = () => {
    got.reload()
    onChanged()
  }
  if (got.value === null) {
    if (got.problem?.kind === 'signin') {
      return (
        <div className="p-page">
          <p className="notice unreachable" role="alert" data-testid="person-problem">
            <Glyph name="warn" size={13} />
            <span>Your sign-in may have ended. Reload the page to sign in again.</span>
          </p>
        </div>
      )
    }
    if (got.problem) {
      return (
        <div className="p-page">
          <a className="back" href="/people" onClick={(e) => follow(e, '/people', go)}>
            <Glyph name="back" size={14} />
            People
          </a>
          <p className="notice unreachable" role="status" data-testid="person-problem">
            <Glyph name="warn" size={13} />
            <span>{got.problem.message ?? 'The space could not be reached just now.'}</span>
          </p>
        </div>
      )
    }
    return (
      <div className="p-page">
        <p className="empty-line sub" role="status" data-testid="loading-person">
          Opening the person
        </p>
      </div>
    )
  }
  return <PersonView answer={got.value} entries={entries} go={go} onChanged={changed} onMerged={onMerged} />
}

// ── Beside a conversation ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The same three fields, editable beside a person's conversation (Conversation.tsx's profile). Read by the conversation's own key, which the Worker finds the person by. It draws
 * nothing until the person is read, and nothing for someone with no contact to keep them on (a teammate, a channel guest the inbox never heard from).
 */
export function ProfileFields({ convKey, go }: { convKey: string; go?: Go }) {
  const got = useJson<PersonAnswer>(`/api/person?key=${encodeURIComponent(convKey)}`)
  const profile = got.value?.profile
  if (!profile) return null
  return (
    <div className="p-beside" data-testid="profile-beside">
      <ProfileEditor profile={profile} onChanged={got.reload} compact />
      <WritesIn groups={profile.groups} go={go} />
    </div>
  )
}

// ── The tab ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How a merge is shown after it is made, with the way back. */
function Merged({ merged, busy, say, onUndo, onDismiss }: { merged: InboxMerged; busy: boolean; say: ReactNode; onUndo(): void; onDismiss(): void }) {
  return (
    <div className="p-merged cnotice ok" role="status" data-testid="merged">
      <Glyph name="check" size={13} />
      <span>
        Merged {merged.absorbedName} into {merged.survivor.name}
      </span>
      <button type="button" className="linkish" disabled={busy} onClick={onUndo} data-testid="undo-merge">
        Undo
      </button>
      <button type="button" className="linkish" onClick={onDismiss} aria-label="Dismiss">
        Dismiss
      </button>
      {say}
    </div>
  )
}

export function People({ pathname, go }: { pathname: string; go: Go }) {
  const [showAutomated, setShowAutomated] = useState(false)
  const list = useJson<PeopleAnswer>(showAutomated ? '/api/people?automated=1' : '/api/people')
  // The directory is the inbox's contacts, meet's people and the Clients' names on their pills: it is read again when any moves, when the page is shown again, and every ten minutes.
  useFresh(['mail', 'chat', 'clients'], list.reload)
  const [query, setQuery] = useState('')
  const [merged, setMerged] = useState<InboxMerged | null>(null)
  // Bumped by a merge and its undo, so the open person is read afresh even when their key did not change.
  const [version, setVersion] = useState(0)
  const undo = useAction()
  const select = useRef<string | null>(null)
  const key = personKey(pathname)

  // After a merge or its undo the person's key may have changed (their first address is another): go to them by contact once the list says so.
  useEffect(() => {
    const id = select.current
    if (id === null || !list.value) return
    const entry = list.value.entries.find((e) => e.contact?.id === id)
    if (entry) {
      select.current = null
      go(peoplePath(entry.key))
    }
  }, [list.value, go])

  const entries = list.value?.entries ?? []
  const onMerged = (m: InboxMerged) => {
    setMerged(m)
    select.current = m.survivor.contactId
    setVersion((n) => n + 1)
    list.reload()
  }
  const onUndo = async () => {
    if (!merged) return
    const ok = await undo.run(
      () => postView<InboxUnmerged>('contact-unmerge', { mergeId: merged.mergeId }),
      (u) => `Undone. ${u.restored.name} is a separate entry again.`,
      (u) => {
        select.current = u.survivor.contactId
      },
    )
    if (ok) {
      setMerged(null)
      setVersion((n) => n + 1)
      list.reload()
    }
  }
  const detail =
    key !== null ? (
      <>
        {merged && <Merged merged={merged} busy={undo.busy} say={undo.say ? <Say say={undo.say} /> : null} onUndo={() => void onUndo()} onDismiss={() => setMerged(null)} />}
        {!merged && undo.done && <p className="cnotice ok" role="status" data-testid="undone">{undo.done}</p>}
        <PersonPane key={`${key}#${version}`} pkey={key} entries={entries} go={go} onChanged={list.reload} onMerged={onMerged} />
      </>
    ) : undefined
  const selected = key !== null ? (entries.find((e) => e.key === key || e.conversationKey === key)?.key ?? key) : null
  return <PeopleScreen answer={list.value} loading={list.loading} problem={list.problem?.kind ?? null} query={query} onQuery={setQuery} selected={selected} showAutomated={showAutomated} onShowAutomated={setShowAutomated} {...(detail && { detail })} go={go} />
}
