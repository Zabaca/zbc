// The Phone conversation: the voicemails and missed calls of the install's number, with Call back, and the dial pad, which is meet's own phone screen drawn inside the space.
//
// The phone is meet's (its Telnyx account, its rules, the minutes). The Telnyx account is not opened yet, so until it is this says so and offers nothing else: no dial pad, no
// calls to answer. When it is, a call to the number rings the space (PhoneHost), a voicemail lands here and is also emailed by meet (never its sound), and the line's settings and
// each person's 911 address are in Settings, Phone.
import { PhonePanel } from '@space/meet/src/web/phone/Phone'
import type { MeetPhone, MeetPhoneItem } from '@space/workspace'
import { useEffect, useRef, useState } from 'react'
import { write } from './api'
import { agoWords } from './format'
import { Glyph } from './icons'
import { useInstall } from './install'
import { spacePhoneApi } from './phone/api'
import { usePhoneHandle } from './phone/PhoneHost'
import { MEET } from './route'
import { Say, Viewed } from './settings-parts'
import { useView } from './views'

/** What the Phone conversation says when the phone is not set up for this person. */
export const notSetUp = (company: string): string =>
  `The phone is not set up yet. Voicemails and missed calls from the ${company} number will be listed here, each with Call back, and the dial pad will open here, once the line is opened and you are on its list.`

function Item({ item, now, canCall, onCallBack, onDelete }: { item: MeetPhoneItem; now: number; canCall: boolean; onCallBack(number: string): void; onDelete(id: number): Promise<string | null> }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [say, setSay] = useState<string | null>(null)
  const label = item.kind === 'voicemail' ? 'Voicemail' : item.kind === 'missed' ? 'Missed call' : '911 was dialed'
  const remove = async () => {
    setBusy(true)
    const failure = await onDelete(item.id)
    setBusy(false)
    if (failure) setSay(failure)
  }
  return (
    <li className={`phone-item ${item.kind}`} data-testid="phone-item" data-kind={item.kind} data-id={item.id}>
      <div>
        <b>{label}</b>
        {item.display && <span> from {item.display}</span>}
        {item.seconds !== null && <span className="sub">, {Math.floor(item.seconds / 60)}:{String(item.seconds % 60).padStart(2, '0')}</span>}
        <span className="sub"> {agoWords(now, item.at)}</span>
      </div>
      {item.kind === 'emergency' && <p className="sub">{item.text}</p>}
      {item.kind === 'voicemail' && (
        // The sound is meet's, through the space; nothing is loaded until the person presses play, and no Telnyx address is ever in the page.
        // biome-ignore lint/a11y/useMediaCaption: a voicemail is a recording; meet keeps no transcript of it.
        <audio controls preload="none" src={spacePhoneApi.voicemailSrc(item.id)} data-testid="voicemail-audio" />
      )}
      {say && <Say say={{ tone: 'bad', text: say, again: false }} />}
      <div className="phone-item-bar">
        {canCall && item.number?.startsWith('+1') && (
          <button type="button" className="btn" onClick={() => onCallBack(item.number as string)} data-testid="call-back">
            <Glyph name="phone" size={13} />
            Call back
          </button>
        )}
        {item.kind !== 'emergency' &&
          (asking ? (
            <>
              <button type="button" className="btn" onClick={() => void remove()} disabled={busy} data-testid="phone-delete-yes">
                {busy ? 'Deleting' : item.kind === 'voicemail' ? 'Delete it and its recording' : 'Delete it'}
              </button>
              <button type="button" className="btn" onClick={() => setAsking(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => setAsking(true)} data-testid="phone-delete">
              Delete
            </button>
          ))}
      </div>
    </li>
  )
}

export function PhonePaneView({ phone, now, canCall, onCallBack, onDelete, children }: { phone: MeetPhone | null; now: number; canCall: boolean; onCallBack(number: string): void; onDelete(id: number): Promise<string | null>; children?: React.ReactNode }) {
  return (
    <>
      {phone !== null && phone.items.length === 0 && (
        <p className="sub" data-testid="phone-empty">
          No voicemails or missed calls yet.
        </p>
      )}
      {phone !== null && phone.items.length > 0 && (
        <ul className="phone-items" data-testid="phone-items">
          {[...phone.items].reverse().map((i) => (
            <Item key={i.id} item={i} now={now} canCall={canCall} onCallBack={onCallBack} onDelete={onDelete} />
          ))}
        </ul>
      )}
      {children}
    </>
  )
}

export function PhonePane({ refreshes, onChanged, go }: { refreshes: number; onChanged(): void; go(path: string): void }) {
  const handle = usePhoneHandle()
  const { company } = useInstall()
  const status = handle?.status ?? null
  const { state, reload, problem } = useView<MeetPhone>('meet/phone')
  const [now, setNow] = useState(() => Date.now())
  const [prefill, setPrefill] = useState<{ number: string; n: number } | null>(null)
  const marked = useRef(0)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    reload()
  }, [refreshes, reload])
  useEffect(() => setNow(Date.now()), [state])

  // Opening it marks it read, up to the newest item on screen, once for each position.
  const newest = state.kind === 'value' ? (state.value.items.at(-1)?.id ?? 0) : 0
  const unread = state.kind === 'value' ? state.value.unread : 0
  useEffect(() => {
    if (unread === 0 || newest === 0 || marked.current >= newest) return
    marked.current = newest
    void write('/api/meet/phone-read', { upTo: newest }).then(() => onChanged())
  }, [unread, newest, onChanged])

  const del = async (id: number): Promise<string | null> => {
    try {
      await spacePhoneApi.phoneDelete(id)
      reload()
      onChanged()
      return null
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not delete that.'
    }
  }

  return (
    <div className="phone-pane" data-testid="phone-detail">
      <a
        className="back"
        href={MEET}
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          e.preventDefault()
          go(MEET)
        }}
        data-testid="back"
      >
        <Glyph name="back" size={14} />
        Meet
      </a>
      <div className="d-head">
        <span className="avatar-lg" data-mark="phone" aria-hidden="true">
          <Glyph name="phone" size={14} />
        </span>
        <div className="grow">
          <h2 data-testid="phone-title">Phone</h2>
          <div className="sub" data-testid="phone-sub">
            {status ? `Calls show ${status.lineDisplay} as ${company}` : 'Voicemails and missed calls, with Call back'}
          </div>
        </div>
      </div>
      {status === null && (
        <p className="cnotice warn" role="status" data-testid="phone-not-set-up">
          <Glyph name="phone" size={13} />
          <span>{notSetUp(company)}</span>
        </p>
      )}
      <Viewed view={state} problem={problem} reload={reload} loading="Opening the Phone">
        {(phone) => (
          <PhonePaneView phone={phone} now={now} canCall={status !== null} onCallBack={(number) => setPrefill({ number, n: Date.now() })} onDelete={del} />
        )}
      </Viewed>
      {handle && status && (
        <div className="meet-screen" data-testid="dial-pad">
          <PhonePanel phone={handle} inSpace company={company} onBack={() => go(MEET)} prefill={prefill} />
        </div>
      )}
    </div>
  )
}

