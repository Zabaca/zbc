// Channel admin in the space (the retirement of meet's old /start page): New channel and Browse channels above Meet's list, and a channel's people beside the channel
// (Invite a guest, Add someone, Take out, Remove, Rename, Leave, Archive). Meet decides who may do what, in its own words: the screen draws a button only where meet's `may` says the
// person may, and says whatever meet refuses. Nothing here is a rule of the space's.
//
// Every write is one press with a compose key made for that press (compose.ts `mintKey`) where it makes something (a channel, an invitation), and is never retried. THE INVITATION IS AN
// EMAIL: meet sends it from meet@northfield.example when, and only when, the person presses Invite; the page says so beside the button, and says plainly when the email could not be sent.
// A guest signs in at space.northfield.example/w/, a path of the space that needs no sign-in; nothing here lets a guest into the team's pages.
import type { MeetBrowsable, MeetChanged, MeetChannelDetail, MeetInvited, MeetMember, MeetPerson } from '@space/workspace'
import type { Privacy } from '@space/meet/src/workspace-model'
import { type FormEvent, type MouseEvent, useEffect, useRef, useState } from 'react'
import { mintKey } from './compose'
import { Glyph } from './icons'
import { MEET, meetPath } from './route'
import { useInstall } from './install'
import { NewMessagePanel } from './NewMessage'
import { Ask, Done, Say, Viewed, useAction } from './settings-parts'
import { type Said, postView, useView } from './views'

type Go = (path: string) => void

/** A click inside the space moves without reloading, unless it means "open it somewhere else". */
function follow(e: MouseEvent<HTMLAnchorElement>, path: string, go: Go): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  go(path)
}

/** Where a channel opens, in Meet: the key of its row (`chat:channel:<n>`, rows.ts). */
export const channelPath = (conversationId: number): string => meetPath(`chat:channel:${conversationId}`)

/** How a person is tagged, as /start tagged them. */
export const tagOf = (p: Pick<MeetPerson, 'kind'>, company: string, invited = false): string => (p.kind === 'teammate' ? company : invited ? 'Invited' : 'Guest')

const NAME_MAX = 40

// ── New channel ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function NewChannelForm({ onMade, onCancel }: { onMade(channel: MeetChannelDetail): void; onCancel(): void }) {
  const { company } = useInstall()
  const [name, setName] = useState('')
  const [privacy, setPrivacy] = useState<Privacy>('private')
  const act = useAction()
  function submit(e: FormEvent) {
    e.preventDefault()
    if (act.busy || name.trim() === '') return
    void act.run(
      () => postView<MeetChannelDetail>('meet/channel-create', { key: mintKey(), name, privacy }),
      (made) => `Made #${made.name}.`,
      onMade,
    )
  }
  return (
    <form className="chan-card" aria-label="New channel" data-testid="new-channel" onSubmit={submit}>
      <h3>New channel</h3>
      <label className="field">
        <span className="sub">Name</span>
        <input value={name} maxLength={NAME_MAX} placeholder="acme" autoFocus onChange={(e) => setName(e.target.value)} data-testid="channel-name" />
      </label>
      <fieldset className="chan-choice">
        <legend className="sub">Who can see it</legend>
        <label>
          <input type="radio" name="privacy" checked={privacy === 'private'} onChange={() => setPrivacy('private')} data-testid="privacy-private" />
          <span>
            <b>Private</b>
            <span className="sub"> Only the people you add. A good fit for one client.</span>
          </span>
        </label>
        <label>
          <input type="radio" name="privacy" checked={privacy === 'open'} onChange={() => setPrivacy('open')} data-testid="privacy-open" />
          <span>
            <b>Open</b>
            <span className="sub"> Every {company} person can see it and join.</span>
          </span>
        </label>
      </fieldset>
      {act.say && <Say say={act.say} />}
      <div className="chan-bar">
        <button type="submit" className="btn primary" disabled={act.busy || name.trim() === ''} data-testid="channel-make">
          {act.busy ? 'Making' : 'Make channel'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={act.busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ── Browse channels ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function BrowseChannels({ onJoined, onClose }: { onJoined(conversationId: number): void; onClose(): void }) {
  const { state, reload, problem } = useView<MeetBrowsable[]>('meet/browse')
  const act = useAction()
  const [joining, setJoining] = useState<number | null>(null)
  function join(c: MeetBrowsable) {
    if (act.busy) return
    setJoining(c.conversationId)
    void act.run(
      () => postView<MeetChanged>('meet/channel-change', { do: 'join', conversationId: c.conversationId }),
      () => `Joined #${c.name}.`,
      () => onJoined(c.conversationId),
    )
  }
  return (
    <section className="chan-card" aria-label="Browse channels" data-testid="browse">
      <h3>Browse channels</h3>
      <p className="sub">Open channels you can join.</p>
      <Viewed view={state} problem={problem} reload={reload} loading="Reading the open channels">
        {(channels) =>
          channels.length === 0 ? (
            <p className="sub" data-testid="browse-none">
              There are no open channels to join.
            </p>
          ) : (
            <ul className="chan-list" data-testid="browse-list">
              {channels.map((c) => (
                <li key={c.conversationId} data-testid="browse-channel" data-channel={c.conversationId}>
                  <Glyph name="hash" size={13} />
                  <span className="chan-name">
                    {c.name}
                    <span className="sub">
                      {' '}
                      {c.memberCount} {c.memberCount === 1 ? 'person' : 'people'}
                    </span>
                  </span>
                  <button type="button" className="btn" disabled={act.busy && joining === c.conversationId} onClick={() => join(c)} data-testid="join-channel">
                    Join
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </Viewed>
      {act.say && <Say say={act.say} />}
      <div className="chan-bar">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  )
}

/** The two buttons above Meet's list, and the panel each opens. */
export function ChannelTools({ go, onChanged }: { go: Go; onChanged(): void }) {
  const [panel, setPanel] = useState<'new' | 'browse' | 'message' | null>(null)
  const open = (id: number) => {
    setPanel(null)
    onChanged()
    go(channelPath(id))
  }
  return (
    <div className="chan-tools" data-testid="channel-tools">
      <div className="chan-buttons">
        <button type="button" className="btn" aria-pressed={panel === 'message'} onClick={() => setPanel(panel === 'message' ? null : 'message')} data-testid="new-message-button">
          <Glyph name="chat" size={13} />
          New message
        </button>
        <button type="button" className="btn" aria-pressed={panel === 'new'} onClick={() => setPanel(panel === 'new' ? null : 'new')} data-testid="new-channel-button">
          <Glyph name="plus" size={13} />
          New channel
        </button>
        <button type="button" className="btn" aria-pressed={panel === 'browse'} onClick={() => setPanel(panel === 'browse' ? null : 'browse')} data-testid="browse-button">
          <Glyph name="hash" size={13} />
          Browse channels
        </button>
      </div>
      {panel === 'message' && <NewMessagePanel go={go} onChanged={onChanged} onClose={() => setPanel(null)} />}
      {panel === 'new' && <NewChannelForm onMade={(c) => open(c.conversationId)} onCancel={() => setPanel(null)} />}
      {panel === 'browse' && <BrowseChannels onJoined={open} onClose={() => setPanel(null)} />}
    </div>
  )
}

// ── A channel's people ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Confirming = { person: MeetMember; purge: boolean }

function MemberRow({ m, go, onTakeOut, onAsk, busy }: { m: MeetMember; go: Go; onTakeOut(): void; onAsk(c: Confirming): void; busy: boolean }) {
  const { company } = useInstall()
  const path = m.person.address ? meetPath(m.person.address) : null
  return (
    <li className="chan-member" data-testid="member" data-person={m.person.id} data-kind={m.person.kind}>
      <span className="chan-who">
        <b>
          {m.person.name}
          {m.you ? ' (you)' : ''}
        </b>
        {m.person.address && <span className="sub chan-addr">{m.person.address}</span>}
      </span>
      <span className="pill" data-testid="member-tag">
        {tagOf(m.person, company, m.invited)}
      </span>
      {!m.you && (
        <span className="chan-acts">
          {m.direct && path && (
            <a className="btn" href={path} onClick={(e) => follow(e, path, go)} data-testid="member-message">
              Message
            </a>
          )}
          {m.may.takeOut && (
            <button type="button" className="btn" disabled={busy} onClick={onTakeOut} data-testid="member-remove">
              Take out
            </button>
          )}
          {m.may.removeFromWorkspace && (
            <button type="button" className="btn" disabled={busy} onClick={() => onAsk({ person: m, purge: false })} data-testid="member-remove-all">
              Remove from workspace
            </button>
          )}
          {m.may.deleteEverything && (
            <button type="button" className="btn" disabled={busy} onClick={() => onAsk({ person: m, purge: true })} data-testid="member-delete">
              Delete everything
            </button>
          )}
        </span>
      )}
    </li>
  )
}

/**
 * Pure: a channel as meet answered it, and what to do about each press. The panel below fetches; the tests draw this with literal answers.
 */
export function ChannelPeople({
  channel,
  busy,
  go,
  onChange,
  onInvite,
  say,
  done,
}: {
  channel: MeetChannelDetail
  busy: boolean
  go: Go
  onChange(change: Record<string, unknown>, words: string | null): void
  /** Answers whether the form's boxes are to be cleared (the invitation went through and the email left). */
  onInvite(name: string, address: string): Promise<boolean>
  say: Said | null
  done: string | null
}) {
  const { company, host, meetSender } = useInstall()
  const [pick, setPick] = useState('')
  const [guest, setGuest] = useState('')
  const [address, setAddress] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [asking, setAsking] = useState<Confirming | 'archive' | null>(null)
  // A question asked in the page is brought into view, since the button that asked it may be a screen away from where it is drawn.
  const question = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (asking !== null) question.current?.scrollIntoView?.({ block: 'nearest' })
  }, [asking])
  const c = channel
  const id = c.conversationId
  const confirming = asking !== null && asking !== 'archive' ? asking : null
  return (
    <section className="chan-people" aria-label="People in this channel" data-testid="members">
      <h3>People ({c.members.length})</h3>
      <ul className="chan-members">
        {c.members.map((m) => (
          <MemberRow
            key={m.person.id}
            m={m}
            go={go}
            busy={busy}
            onTakeOut={() => onChange({ do: 'take-out', conversationId: id, personId: m.person.id }, `${m.person.name} is out of this channel.`)}
            onAsk={setAsking}
          />
        ))}
      </ul>
      {confirming && (
        <div ref={question}>
          <Ask
            question={
              confirming.purge
                ? `Delete ${confirming.person.person.name} and every message they wrote, for good? This cannot be undone.`
                : `Remove ${confirming.person.person.name} from the workspace? They are signed out everywhere and see nothing more; their messages stay under their name.`
            }
            yes={confirming.purge ? 'Delete for good' : 'Remove'}
            no="Keep them"
            danger
            busy={busy}
            onYes={() => {
              setAsking(null)
              onChange({ do: confirming.purge ? 'delete-person' : 'remove-guest', conversationId: id, personId: confirming.person.person.id }, null)
            }}
            onNo={() => setAsking(null)}
          />
        </div>
      )}

      {c.may.add && (
        <form
          className="chan-form"
          aria-label="Add someone"
          onSubmit={(e) => {
            e.preventDefault()
            if (pick) {
              onChange({ do: 'add', conversationId: id, personId: pick }, 'Added.')
              setPick('')
            }
          }}
        >
          <label className="field">
            <span className="sub">Add someone you can see</span>
            <select value={pick} onChange={(e) => setPick(e.target.value)} data-testid="add-person">
              <option value="">Choose</option>
              {c.addable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({tagOf(p, company)})
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn" disabled={!pick || busy} data-testid="add-person-go">
            Add
          </button>
        </form>
      )}

      {c.may.invite && (
        <form
          className="chan-form chan-invite"
          aria-label="Invite a guest"
          data-testid="invite-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (busy || guest.trim() === '' || address.trim() === '') return
            void onInvite(guest, address).then((clear) => {
              if (clear) {
                setGuest('')
                setAddress('')
              }
            })
          }}
        >
          <h4>Invite a guest</h4>
          <label className="field">
            <span className="sub">Name</span>
            <input value={guest} maxLength={NAME_MAX} onChange={(e) => setGuest(e.target.value)} data-testid="invite-name" />
          </label>
          <label className="field">
            <span className="sub">Email address</span>
            <input type="email" value={address} onChange={(e) => setAddress(e.target.value)} data-testid="invite-email" />
          </label>
          <p className="sub" data-testid="invite-note">
            Pressing Invite sends them an email from {meetSender} with a link to sign in at {host}/w/. Nothing is sent until you press it.
          </p>
          <button type="submit" className="btn primary" disabled={busy || guest.trim() === '' || address.trim() === ''} data-testid="invite-go">
            Invite
          </button>
        </form>
      )}

      {done && <Done text={done} />}
      {say && <Say say={say} />}

      <div className="chan-manage" data-testid="channel-manage">
        {renaming === null ? (
          <>
            {c.may.rename && (
              <button type="button" className="btn" disabled={busy} onClick={() => setRenaming(c.name)} data-testid="rename">
                Rename
              </button>
            )}
            {c.may.leave && (
              <button type="button" className="btn" disabled={busy} onClick={() => onChange({ do: 'leave', conversationId: id }, null)} data-testid="leave">
                Leave
              </button>
            )}
            {c.may.archive && (
              <button type="button" className="btn" disabled={busy} onClick={() => setAsking('archive')} data-testid="archive">
                Archive
              </button>
            )}
          </>
        ) : (
          <form
            className="chan-form chan-rename"
            aria-label="Rename the channel"
            onSubmit={(e) => {
              e.preventDefault()
              onChange({ do: 'rename', conversationId: id, name: renaming }, 'Renamed.')
              setRenaming(null)
            }}
          >
            <input value={renaming} maxLength={NAME_MAX} aria-label="Channel name" autoFocus onChange={(e) => setRenaming(e.target.value)} data-testid="rename-input" />
            <button type="submit" className="btn" disabled={busy || renaming.trim() === ''} data-testid="rename-save">
              Save
            </button>
            <button type="button" className="btn" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </form>
        )}
      </div>
      {asking === 'archive' && (
        <div ref={question}>
          <Ask
            question="Archive this channel? It leaves everyone's list and takes no new messages."
            yes="Archive"
            no="Keep it"
            danger
            busy={busy}
            onYes={() => {
              setAsking(null)
              onChange({ do: 'archive', conversationId: id }, null)
            }}
            onNo={() => setAsking(null)}
          />
        </div>
      )}
    </section>
  )
}

/** The panel beside a channel: meet's answer for the channel, and what each press asks of meet. `onChanged` is the Conversations list to read again; `onGone` where the person is out of the channel. */
export function ChannelPanel({ conversationId, go, onChanged }: { conversationId: number; go: Go; onChanged(): void }) {
  const install = useInstall()
  const { state, reload, problem } = useView<MeetChannelDetail>('meet/channel', { conversation: String(conversationId) })
  const act = useAction()
  /** An invitation whose email did not leave: the guest is in the channel, and the person is told to press Invite again (a new press is a new key, so it sends again). */
  const [unsent, setUnsent] = useState<string | null>(null)
  function change(body: Record<string, unknown>, words: string | null) {
    if (act.busy) return
    setUnsent(null)
    void act.run(
      () => postView<MeetChanged>('meet/channel-change', body),
      () => words ?? '',
      (changed) => {
        onChanged()
        // The person is out of the channel (they left it, or it was archived): it is no longer theirs to look at.
        if (changed.channel === null) go(MEET)
        else reload()
      },
    )
  }
  /**
   * THE KEY IS THE FORM'S, as a reply's is the message's (compose.ts): one key for the filled-in form, kept through a refusal (meet releases it) and through an outcome the
   * page could not read (meet may hold it, and a second press with it is then answered as the first, so the guest is emailed once), and a new one only after the invitation
   * went through. Answers whether the boxes are to be cleared: only after success, and not when the email did not leave (the boxes stay, so Invite again is one press).
   */
  const [inviteKey, setInviteKey] = useState(() => mintKey())
  async function invite(name: string, address: string): Promise<boolean> {
    if (act.busy) return false
    setUnsent(null)
    let clear = false
    await act.run(
      () => postView<MeetInvited>('meet/channel-invite', { key: inviteKey, conversationId, name, address }),
      (done) => (done.mailed ? `Invited ${done.person.name}. They get an email from ${install.meetSender}.` : ''),
      (done) => {
        setInviteKey(mintKey())
        clear = done.mailed
        if (!done.mailed) setUnsent(`${done.person.name} is in the channel, but the invitation email could not be sent. Press Invite again to send it.`)
        onChanged()
        reload()
      },
    )
    return clear
  }
  const say = act.say ?? (unsent === null ? null : { tone: 'bad' as const, text: unsent, again: false })
  return (
    <Viewed view={state} problem={problem} reload={reload} loading="Reading the channel’s people">
      {(channel) => <ChannelPeople channel={channel} busy={act.busy} go={go} onChange={change} onInvite={invite} say={say} done={act.done === '' ? null : act.done} />}
    </Viewed>
  )
}
