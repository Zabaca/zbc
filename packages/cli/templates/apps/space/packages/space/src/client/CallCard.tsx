// A call as a card: in a direct message or channel for a huddle, in an email conversation for a call link or a meeting, on Today's list for a meeting, and on a
// call's own screen. It says who is in the call now, how long it ran once everyone left, or when a meeting starts, with Join and Copy link.
//
// THE LINK IS MEET'S. `call.link` is made by meet on the space's address (space.northfield.example/r/<name>, open to anyone), so Copy link copies exactly that and Join opens it in a tab of its own: a guest
// needs no sign-in there, and nothing here builds an address from the page's own. Join adds the person's name to the address so the lobby is not asked for one.
import type { MeetCall } from '@space/workspace'
import { useState } from 'react'
import { CARD_LABEL, joinHref, lengthWords, ranFor, whenWords } from './invite'
import { Glyph } from './icons'
import { agoWords, plural } from './format'

/** What a card says about the call's state, in one line, and the state the styling keys on. */
export function stateOf(call: MeetCall, now: number, zone: string | undefined): { line: string; state: 'live' | 'ended' | 'waiting' } {
  if (call.present > 0) return { line: `${plural(call.present, 'person is', 'people are')} in it now`, state: 'live' }
  if (call.endedAt !== null && call.people > 0) {
    const ran = ranFor(call)
    const joined = plural(call.people, 'person', 'people')
    return { line: `Call ended${ran === null ? '' : `, ${lengthWords(ran)}`}. ${joined} joined${call.messages > 0 ? `, ${plural(call.messages, 'chat message', 'chat messages')} saved` : ''}`, state: 'ended' }
  }
  if (call.kind === 'meeting' && call.startsAt !== null) return { line: call.startsAt > now ? `Starts ${whenWords(call.startsAt, zone ?? 'UTC')}` : 'Nobody has joined yet', state: 'waiting' }
  return { line: 'Nobody has joined yet', state: 'waiting' }
}

/** Who made it, as the card says it. */
function byLine(call: MeetCall): string {
  const who = call.madeBy.mine ? 'You' : call.madeBy.name
  switch (call.kind) {
    case 'huddle':
      return `${who} started it`
    case 'link':
      return `${call.madeBy.mine ? 'You made' : `${call.madeBy.name} made`} this call link`
    case 'meeting':
      return `${who} booked it`
    case 'new':
      return `${who} made it`
  }
}

export function CopyLink({ link, label = 'Copy link' }: { link: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setState('copied')
      setTimeout(() => setState('idle'), 2500)
    } catch {
      // A browser that will not write to the clipboard (a page not in focus, a blocked permission): the link is shown, to be copied by hand.
      setState('failed')
    }
  }
  return (
    <>
      <button type="button" className="btn" onClick={() => void copy()} data-testid="call-copy">
        <Glyph name={state === 'copied' ? 'check' : 'link'} size={13} />
        {state === 'copied' ? 'Copied' : label}
      </button>
      {state === 'failed' && <input className="call-link-box" readOnly value={link} aria-label="The call's link" onFocus={(e) => e.currentTarget.select()} data-testid="call-link-box" />}
    </>
  )
}

export interface CallCardProps {
  call: MeetCall
  now: number
  /** The company's time zone, so a meeting's time reads the same wherever the browser is. */
  zone: string | undefined
  /** The signed-in person's name: Join carries it to the lobby. */
  name: string
  /** A link to the call's own screen (its saved chat), when it has one to open. */
  chatHref?: string
  onOpenChat?(): void
}

export function CallCard({ call, now, zone, name, chatHref, onOpenChat }: CallCardProps) {
  const { line, state } = stateOf(call, now, zone)
  const title = call.title ? `${CARD_LABEL[call.kind]}: ${call.title}` : CARD_LABEL[call.kind]
  const withWho = call.kind === 'meeting' && call.invitees.length > 0 ? call.invitees.map((i) => i.name).join(', ') : null
  return (
    <div className={`card call-card ${state}`} data-testid="call-card" data-call={call.name} data-kind={call.kind} data-state={state}>
      <span className="card-ico">
        {state === 'live' ? <span className="livedot" aria-hidden="true" /> : <Glyph name="video" size={15} />}
      </span>
      <div className="card-main">
        <div className="card-title" data-testid="call-title">
          {title}
        </div>
        <div className="sub" data-testid="call-by">
          {byLine(call)}
          {call.kind === 'meeting' && call.startsAt !== null && state !== 'waiting' ? `, for ${whenWords(call.startsAt, zone ?? 'UTC')}` : ''}
          {call.kind !== 'meeting' ? `, ${agoWords(now, call.madeAt)}` : ''}
        </div>
        {call.kind === 'meeting' && call.startsAt !== null && state === 'waiting' && (
          <div className="call-when" data-testid="call-when">
            {whenWords(call.startsAt, zone ?? 'UTC')}
          </div>
        )}
        <div className={`call-state ${state}`} data-testid="call-state">
          {line}
        </div>
        {withWho && (
          <div className="sub" data-testid="call-with">
            With {withWho}
          </div>
        )}
      </div>
      <div className="card-act">
        <a className={`btn${state === 'ended' ? '' : ' primary'}`} href={joinHref(call, name)} target="_blank" rel="noopener noreferrer" data-testid="call-join">
          {state === 'ended' ? 'Join again' : 'Join'}
        </a>
        <CopyLink link={call.link} />
        {call.messages > 0 && chatHref !== undefined && (
          <a
            className="btn"
            href={chatHref}
            onClick={(e) => {
              if (onOpenChat && !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                e.preventDefault()
                onOpenChat()
              }
            }}
            data-testid="call-chat"
          >
            Chat ({call.messages})
          </a>
        )}
      </div>
    </div>
  )
}
