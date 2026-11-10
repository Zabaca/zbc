// The workspace's small dialogs: make a channel, start a direct message, your settings, and the privacy note.

import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { CHANNEL_NAME_MAX, type MeView, type PersonView } from '../../workspace-model'
import { ApiError } from '../api'
import { Icon } from '../ui'
import type { Session, WorkspaceApi } from './api'
import { formatWhen } from '../call/chat'
import { useSite } from '../site'
import { personTag } from './store'

export function Modal({ title, onClose, children, testid }: { title: string; onClose: () => void; children: ReactNode; testid?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="ws-modal-back" onClick={onClose} role="presentation">
      <div className="ws-modal" role="dialog" aria-modal="true" aria-label={title} data-testid={testid} onClick={(e) => e.stopPropagation()}>
        <header className="ws-modal-head">
          <h2>{title}</h2>
          <button type="button" className="ws-icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  )
}

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

export function NewDm({ people, onPick, onClose }: { people: PersonView[]; onPick: (id: string) => void; onClose: () => void }) {
  const { company } = useSite()
  const [q, setQ] = useState('')
  const shown = people.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <Modal title="New message" onClose={onClose} testid="new-dm">
      <div className="ws-form">
        <label className="field">
          To
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" autoFocus data-testid="dm-search" />
        </label>
        {shown.length === 0 ? (
          <p className="fine">{people.length === 0 ? 'There is no one to message yet. People appear here once they share a channel with you.' : 'No one by that name.'}</p>
        ) : (
          <ul className="ws-people" data-testid="dm-people">
            {shown.map((p) => (
              <li key={p.id}>
                <button type="button" className="ws-person" onClick={() => onPick(p.id)} data-testid="dm-person" data-person={p.id}>
                  <span className="ws-avatar">{p.name.charAt(0).toUpperCase()}</span>
                  <span className="ws-person-name">{p.name}</span>
                  <span className="ws-tag">{personTag(p, company)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

export function Privacy({ onClose, onAck, owner }: { onClose: () => void; onAck?: () => void; owner: { name: string; address: string } | null }) {
  const { company } = useSite()
  const who = company === '' ? 'The company' : company
  const people = company === '' ? 'The people who run this workspace' : `${company} people`
  return (
    <Modal title="Your privacy on meet" onClose={onClose} testid="privacy">
      <div className="ws-form ws-note">
        <p>
          <strong>What is kept.</strong> Your name, your email address, the messages you write, the devices you are signed in on and when each was last used.
        </p>
        <p>
          <strong>Who sees what.</strong> Your messages are seen by the people in the channel or direct message you wrote them in, and by no one else in the
          workspace. You see only your channels and the people who share one with you. {people} can see who is in the channels they are in.
        </p>
        <p>
          <strong>How long.</strong> Messages are kept until they are deleted. You can edit or delete your own at any time. To have your account and everything you
          wrote deleted, ask {owner ? `${owner.name} at ${owner.address}` : 'the person who invited you'}.
        </p>
        <p>
          <strong>Where.</strong> {who} runs meet on Cloudflare and can reach what is stored. Messages are encrypted on their way to you, not end to end. meet sends
          you email only for your sign-in code, an invitation, and a note when a direct message has waited a while; those emails never contain what a message says.
        </p>
        <p>
          <strong>Calls.</strong> Calls are not recorded.
        </p>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => (onAck ? onAck() : onClose())} data-testid="privacy-ok">
            {onAck ? 'I understand' : 'Close'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export function Settings({
  me,
  api,
  onSaved,
  onClose,
  onPrivacy,
  onSignOut,
}: {
  me: MeView
  api: WorkspaceApi
  onSaved: (me: MeView) => void
  onClose: () => void
  onPrivacy: () => void
  onSignOut: () => void
}) {
  const [name, setName] = useState(me.name)
  const [error, setError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Session[] | null>(null)

  useEffect(() => {
    if (me.kind === 'guest') api.sessions().then((r) => setSessions(r.sessions)).catch(() => setSessions([]))
  }, [api, me.kind])

  async function save(patch: { name?: string; nudgesOff?: boolean }) {
    setError(null)
    try {
      onSaved((await api.updateMe(patch)).me)
    } catch (e) {
      setError(message(e, 'Could not save that.'))
    }
  }
  async function end(id: string) {
    try {
      await api.endSession(id)
      setSessions((held) => held?.filter((s) => s.id !== id) ?? null)
    } catch (e) {
      setError(message(e, 'Could not sign that device out.'))
    }
  }

  return (
    <Modal title="Settings" onClose={onClose} testid="settings">
      <div className="ws-form">
        <form
          className="ws-inline"
          onSubmit={(e) => {
            e.preventDefault()
            void save({ name })
          }}
        >
          <label className="field">
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} data-testid="settings-name" />
          </label>
          <button type="submit" className="btn" disabled={name.trim() === '' || name.trim() === me.name}>
            Save
          </button>
        </form>
        <p className="fine">{me.email}</p>
        <label className="ws-check">
          <input type="checkbox" checked={!me.nudgesOff} onChange={(e) => void save({ nudgesOff: !e.target.checked })} data-testid="settings-nudges" />
          <span>
            Email me when a direct message has waited 15 minutes
            <small>At most one an hour. It says who wrote, never what.</small>
          </span>
        </label>
        {me.kind === 'guest' && (
          <section aria-label="Signed-in devices">
            <h3 className="ws-h3">Signed-in devices</h3>
            {sessions === null ? (
              <p className="fine">Loading</p>
            ) : (
              <ul className="ws-sessions" data-testid="sessions">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <span>
                      {s.label || 'A browser'}
                      {s.current ? ' (this one)' : ''}
                      <small>Last used {formatWhen(s.lastUsedAt)}</small>
                    </span>
                    {!s.current && (
                      <button type="button" className="btn btn-small" onClick={() => void end(s.id)}>
                        Sign out
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button type="button" className="btn" onClick={onPrivacy}>
            Privacy note
          </button>
          {me.kind === 'guest' && (
            <button type="button" className="btn" onClick={onSignOut} data-testid="sign-out">
              Sign out
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
