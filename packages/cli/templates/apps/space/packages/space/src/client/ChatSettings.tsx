// Settings, Chat: a person's own settings in chat, as /start's Settings had them: their name, the email that says a direct message has waited 15 minutes, and the
// privacy note with its acknowledgement. They are meet's, kept in meet, and changed through meet's rules and words; this draws them. Each press is one call, never retried, and none sends anything:
// the nudge is meet's own, on its own timer, and the switch only says whether it is wanted.
//
// The name is the one chat messages carry (it is not the name the space calls the person by on the left; that is the company's list). The privacy note is /start's, word for word.
import type { MeetMe } from '@space/workspace'
import { type FormEvent, useState } from 'react'
import { useInstall } from './install'
import { useOwner } from './owner'
import { Block, Done, Say, Switch, Viewed, useAction } from './settings-parts'
import { type Said, postView, useView } from './views'

const NAME_MAX = 40

/** /start's privacy note, word for word (packages/meet/src/web/workspace/Panels.tsx), with the install's company and owner named. */
export const privacyNote = (company: string, owner: { name: string; address: string }): ReadonlyArray<{ lead: string; body: string }> => [
  { lead: 'What is kept.', body: 'Your name, your email address, the messages you write, the devices you are signed in on and when each was last used.' },
  {
    lead: 'Who sees what.',
    body: `Your messages are seen by the people in the channel or direct message you wrote them in, and by no one else in the workspace. You see only your channels and the people who share one with you. ${company} people can see who is in the channels they are in.`,
  },
  {
    lead: 'How long.',
    body: `Messages are kept until they are deleted. You can edit or delete your own at any time. To have your account and everything you wrote deleted, ask ${owner.name}${owner.address ? ` at ${owner.address}` : ''}.`,
  },
  {
    lead: 'Where.',
    body: `${company} runs meet on Cloudflare and can reach what is stored. Messages are encrypted on their way to you, not end to end. meet sends you email only for your sign-in code, an invitation, and a note when a direct message has waited a while; those emails never contain what a message says.`,
  },
  { lead: 'Calls.', body: 'Calls are not recorded.' },
]

/** Pure: the settings as meet answered them, and what each press asks. */
export function ChatSettingsPanel({
  me,
  busy,
  say,
  done,
  onName,
  onNudges,
  onAcknowledge,
}: {
  me: MeetMe
  busy: boolean
  say: Said | null
  done: string | null
  onName(name: string): void
  /** `wanted`: the person wants the email. */
  onNudges(wanted: boolean): void
  onAcknowledge(): void
}) {
  const { company } = useInstall()
  const owner = useOwner()
  const [name, setName] = useState(me.person.name)
  const unchanged = name.trim() === me.person.name
  return (
    <div className="chat-settings" data-testid="chat-settings">
      <form
        className="chat-name"
        onSubmit={(e: FormEvent) => {
          e.preventDefault()
          if (!busy && name.trim() !== '' && !unchanged) onName(name)
        }}
      >
        <label className="field">
          <span className="s-lead">Your name</span>
          <span className="sub">The name your messages carry in chat.</span>
          <input value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} data-testid="chat-name" />
        </label>
        <button type="submit" className="btn" disabled={busy || name.trim() === '' || unchanged} data-testid="chat-name-save">
          Save
        </button>
      </form>
      {me.person.address && <p className="sub">{me.person.address}</p>}

      <div className="s-switchrow s-ruled">
        <Switch on={!me.nudgesOff} label="Email me when a direct message has waited 15 minutes" busy={busy} onChange={onNudges} testid="chat-nudges" />
        <div>
          <p className="s-lead">Email me when a direct message has waited 15 minutes</p>
          <p className="sub">At most one an hour. It says who wrote, never what.</p>
        </div>
      </div>

      <section className="chat-privacy s-ruled" aria-label="Your privacy on meet" data-testid="privacy-note" data-acked={me.privacyAcked}>
        <h3 className="s-sub">Your privacy on meet</h3>
        {privacyNote(company, owner).map((p) => (
          <p key={p.lead}>
            <b>{p.lead}</b> {p.body}
          </p>
        ))}
        {me.privacyAcked ? (
          <p className="sub" data-testid="privacy-acked">
            You have acknowledged this note.
          </p>
        ) : (
          <div className="s-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={onAcknowledge} data-testid="privacy-ok">
              I understand
            </button>
          </div>
        )}
      </section>

      {say && <Say say={say} />}
      <Done text={done} />
    </div>
  )
}

export function ChatSection() {
  const view = useView<MeetMe>('meet/me')
  const act = useAction()
  const change = async (patch: { name?: string; nudgesOff?: boolean }, words: string) => {
    const ok = await act.run(() => postView<MeetMe>('meet/me-update', patch), words)
    view.reload()
    return ok
  }
  return (
    <Block title="Chat" testid="section-chat">
      <Viewed view={view.state} problem={view.problem} reload={view.reload} loading="Loading your chat settings">
        {(me) => (
          <ChatSettingsPanel
            // A name saved is the name shown: the form starts again from what meet now holds.
            key={me.person.name}
            me={me}
            busy={act.busy}
            say={act.say}
            done={act.done}
            onName={(name) => void change({ name }, 'Saved your name.')}
            onNudges={(wanted) => void change({ nudgesOff: !wanted }, wanted ? 'You will be emailed when a direct message has waited 15 minutes.' : 'You will not be emailed about a waiting direct message.')}
            onAcknowledge={() => {
              void act.run(() => postView<MeetMe>('meet/privacy-ack', {}), 'Noted.').then(view.reload)
            }}
          />
        )}
      </Viewed>
    </Block>
  )
}
