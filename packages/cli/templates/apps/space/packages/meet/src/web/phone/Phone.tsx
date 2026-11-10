// The Phone, for the company's people, drawn in the space (docs/adr/0004): a dial pad, the call in progress (state, timer, mute, tones, hang up),
// the 911 setup a first call needs, the month's minutes, and the log. The hook (usePhone.ts) holds the call, so it goes on
// while the person reads a channel; this is only what they look at.

import { type FormEvent, useEffect, useState } from 'react'
import './phone.css'
import { KEYS, KEY_LETTERS, type E911Address, LINE_RING_RANGE, addressLine } from '../../phone-model'
import { formatWhen } from '../call/chat'
import { Icon } from '../ui'
import type { PhoneHandle } from './usePhone'
import { backspace, cleanTyped, elapsed, isEmergencyTyped, outcomeText, phaseText, press, shown } from './state'

/** The call's timer, ticking while it is answered. */
function Timer({ since }: { since: number | null }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (since === null) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [since])
  return (
    <span className="ph-timer" data-testid="phone-timer">
      {since === null ? '0:00' : elapsed(now - since)}
    </span>
  )
}

function Keypad({ onKey, inCall }: { onKey: (k: string) => void; inCall: boolean }) {
  return (
    <div className="ph-keys" role="group" aria-label="Keypad" data-testid="phone-keys">
      {KEYS.map((k) => (
        <button
          key={k}
          type="button"
          className="ph-key"
          // * and # are tones for a phone menu: there is nothing for them to dial before a call.
          disabled={!inCall && (k === '*' || k === '#')}
          onClick={() => onKey(k)}
          data-testid={`key-${k === '*' ? 'star' : k === '#' ? 'hash' : k}`}
          aria-label={k === '*' ? 'star' : k === '#' ? 'pound' : k}
        >
          <span className="ph-key-digit">{k}</span>
          <span className="ph-key-letters">{KEY_LETTERS[k] ?? ''}</span>
        </button>
      ))}
    </div>
  )
}

const BLANK: E911Address = { street: '', extended: '', city: '', state: '', zip: '' }

/** The 911 notice and address, which a first call waits for. Drawn in meet's own panel, and in the space's Settings. */
export function PhoneSetup({ phone }: { phone: PhoneHandle }) {
  const s = phone.status
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<E911Address>(s?.address ?? BLANK)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  if (!s) return null
  const editing = open || !s.address
  const set = (k: keyof E911Address) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: k === 'state' ? e.target.value.toUpperCase().slice(0, 2) : e.target.value }))

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setProblem(null)
    const failure = await phone.saveAddress(form)
    setSaving(false)
    setProblem(failure)
    if (!failure) setOpen(false)
  }

  return (
    <section className="ph-card" aria-label="911" data-testid="phone-setup">
      <h3>911 from meet</h3>
      <p className="fine">{s.notice}</p>
      {s.acked ? (
        <p className="fine ph-ok" data-testid="phone-acked">
          You acknowledged this.
        </p>
      ) : (
        <button type="button" className="btn btn-small" onClick={() => void phone.ack()} data-testid="phone-ack">
          I understand
        </button>
      )}
      {s.addressCheck && s.address && (
        <div className="notice" role="status" data-testid="address-check">
          <p>You seem to be in a different state than your 911 address. Is it still where you are?</p>
          <div className="row">
            <button type="button" className="btn btn-small" onClick={() => void phone.confirmAddress()} data-testid="address-right">
              It is right
            </button>
            <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
              Change it
            </button>
          </div>
        </div>
      )}
      {!editing && s.address ? (
        <div className="ph-address" data-testid="phone-address">
          <p>
            <strong>Your 911 address</strong>
            <br />
            {addressLine(s.address)}
          </p>
          <p className="fine">{s.registered ? 'Registered for 911.' : 'Waiting for the phone company to hold it.'}</p>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => (setForm(s.address ?? BLANK), setOpen(true))}
            data-testid="address-change"
          >
            Change address
          </button>
        </div>
      ) : (
        <form className="ph-form" onSubmit={(e) => void save(e)} data-testid="address-form">
          <p className="fine">The address where you use meet. 911 sends help here, so keep it right when you move.</p>
          <label className="field">
            Street
            <input value={form.street} onChange={set('street')} autoComplete="street-address" maxLength={100} data-testid="addr-street" />
          </label>
          <label className="field">
            Apartment or suite (if any)
            <input value={form.extended} onChange={set('extended')} maxLength={60} data-testid="addr-extended" />
          </label>
          <div className="ph-form-row">
            <label className="field ph-grow">
              City
              <input value={form.city} onChange={set('city')} autoComplete="address-level2" maxLength={100} data-testid="addr-city" />
            </label>
            <label className="field ph-state">
              State
              <input value={form.state} onChange={set('state')} autoComplete="address-level1" maxLength={2} placeholder="CA" data-testid="addr-state" />
            </label>
            <label className="field ph-zip">
              ZIP
              <input value={form.zip} onChange={set('zip')} autoComplete="postal-code" inputMode="numeric" maxLength={10} data-testid="addr-zip" />
            </label>
          </div>
          {problem && (
            <p className="notice notice-error" role="alert" data-testid="addr-error">
              {problem}
            </p>
          )}
          <div className="row">
            <button type="submit" className="btn btn-primary btn-small" disabled={saving} data-testid="addr-save">
              {saving ? 'Saving' : 'Save address'}
            </button>
            {s.address && (
              <button type="button" className="btn btn-small" onClick={() => setOpen(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  )
}

/** What the line does with a call nobody picks up at once: the cell that rings next (or none), and how long meet rings first. Drawn in meet's own panel, and in the space's Settings. */
export function PhoneLineSettings({ phone }: { phone: PhoneHandle }) {
  const s = phone.status
  const [cell, setCell] = useState(s?.settings.cellDisplay ?? '')
  const [ring, setRing] = useState(String(s?.settings.ringSeconds ?? 20))
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  // The saved values are what the form shows again after a save or from another tab.
  useEffect(() => {
    if (!s) return
    setCell(s.settings.cellDisplay ?? '')
    setRing(String(s.settings.ringSeconds))
  }, [s?.settings.cell, s?.settings.ringSeconds])
  if (!s) return null

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setNote(null)
    const failure = await phone.saveSettings({ cell: cell.trim() === '' ? null : cell, ringSeconds: Number(ring) })
    setSaving(false)
    setNote(failure ? { ok: false, text: failure } : { ok: true, text: 'Saved.' })
  }

  // Only the line's owner changes where its calls go; everyone else with the phone sees where they go.
  if (!s.canEditLine) {
    return (
      <section className="ph-card" aria-label="When nobody answers" data-testid="phone-settings-readonly">
        <h3>Calls to the number</h3>
        <p className="fine">
          A call rings everyone's meet for {s.settings.ringSeconds} seconds, then {s.settings.cellDisplay ? `the cell ${s.settings.cellDisplay}` : 'no cell (there is none set)'}, then takes a voicemail
          that lands in the Phone conversation. The line's owner sets these.
        </p>
      </section>
    )
  }

  return (
    <section className="ph-card" aria-label="When nobody answers" data-testid="phone-settings">
      <h3>Calls to the number</h3>
      <p className="fine">
        A call rings everyone's meet at once, then the cell below if there is one, then takes a voicemail that lands in the Phone conversation.
        The cell is asked to press 1, so its own voicemail cannot answer instead. Calls are never recorded; voicemails are.
      </p>
      <form className="ph-form" onSubmit={(e) => void save(e)}>
        <label className="field">
          Ring meet for (seconds)
          <input value={ring} onChange={(e) => setRing(e.target.value.replace(/\D/g, '').slice(0, 2))} inputMode="numeric" data-testid="settings-ring" aria-describedby="ring-range" />
        </label>
        <p className="fine" id="ring-range">
          {LINE_RING_RANGE}
        </p>
        <label className="field">
          Then ring this cell (leave empty for none)
          <input type="tel" value={cell} onChange={(e) => setCell(e.target.value)} autoComplete="off" placeholder="No cell" data-testid="settings-cell" />
        </label>
        {note && (
          <p className={`notice ${note.ok ? '' : 'notice-error'}`} role={note.ok ? 'status' : 'alert'} data-testid="settings-note">
            {note.text}
          </p>
        )}
        <div className="row">
          <button type="submit" className="btn btn-primary btn-small" disabled={saving} data-testid="settings-save">
            {saving ? 'Saving' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  )
}

/**
 * The dial pad and the log. In meet's own page it has a header with the line's state and carries the 911 notice and the line's settings beside it. In the space
 * (`inSpace`) the pane around it draws the header, and the notice, the 911 address and the line's settings are in the space's Settings, so only the dial pad,
 * the month's minutes and the log are here.
 */
export function PhonePanel({
  phone,
  onBack,
  prefill,
  inSpace = false,
  company,
}: {
  phone: PhoneHandle
  onBack: () => void
  prefill?: { number: string; n: number } | null
  inSpace?: boolean
  /** The company's name, which the line shows its number as (the install's, read by the space). */
  company: string
}) {
  const s = phone.status
  const [typed, setTyped] = useState('')
  const [keypad, setKeypad] = useState(false)
  const [sent, setSent] = useState('')
  const call = phone.call
  const live = call !== null && call.phase !== 'ended'

  // Call back, from a voicemail or a missed call: the number goes in the box, ready to press Call.
  useEffect(() => {
    if (prefill) setTyped(shown(prefill.number.startsWith('+1') ? prefill.number.slice(2) : prefill.number))
  }, [prefill?.n])

  // A new call starts with the tone pad shut and nothing sent.
  useEffect(() => {
    if (!call) {
      setKeypad(false)
      setSent('')
    }
  }, [call === null])

  if (!s) return null
  const emergency = isEmergencyTyped(typed)
  const ready = phone.line === 'ready'
  const lineText =
    phone.line === 'ready' ? 'Ready' : phone.line === 'connecting' ? 'Connecting' : phone.line === 'other-tab' ? 'Open in another tab' : phone.line === 'failed' ? 'Not connected' : 'Off'

  function place(e?: FormEvent) {
    e?.preventDefault()
    if (typed && !live && !phone.busy) void phone.dial(typed)
  }

  return (
    <div className={inSpace ? 'ph' : 'ws-pane ph'} data-testid="phone" data-line={phone.line}>
      {inSpace ? (
        <p className="fine ph-line" data-testid="phone-line">
          Calls show {s.lineDisplay} as {company}.{' '}
          <span className={`ph-chip ph-chip-${phone.line}`} data-testid="phone-state" data-line={phone.line}>
            {lineText}
          </span>
        </p>
      ) : (
        <header className="ws-conv-head">
          <button type="button" className="ws-icon-btn ws-back" onClick={onBack} aria-label="Back to conversations">
            <Icon name="back" />
          </button>
          <div className="ws-conv-title">
            <h2>Phone</h2>
            <p className="fine" data-testid="phone-line">
              Calls show {s.lineDisplay} as {company}
            </p>
          </div>
          <span className={`ph-chip ph-chip-${phone.line}`} data-testid="phone-state" data-line={phone.line}>
            {lineText}
          </span>
        </header>
      )}

      <div className="ph-body">
        {phone.error && (
          <p className="notice notice-error ph-notice" role="alert" data-testid="phone-error">
            {phone.error}{' '}
            <button type="button" className="ws-link-btn" onClick={phone.clearError}>
              Dismiss
            </button>
          </p>
        )}
        {phone.line === 'other-tab' && <p className="notice ph-notice">The phone is open in another tab of this browser. Use it there, or close that tab and reload this one.</p>}
        {phone.line === 'failed' && (
          <p className="notice ph-notice">
            The phone is not connected.{' '}
            <button type="button" className="ws-link-btn" onClick={phone.retry} data-testid="phone-retry">
              Try again
            </button>
          </p>
        )}

        <div className="ph-grid">
          <section className="ph-card ph-dial" aria-label="Dial pad" data-testid="dialer">
            {live && call ? (
              <div className="ph-call" data-testid="phone-call-bar" data-phase={call.phase}>
                <p className="ph-call-who" data-testid="phone-call-number">
                  {call.display}
                </p>
                <p className="ph-call-state">
                  <span data-testid="phone-call-state">{phaseText(call.phase, call.cause)}</span>
                  {call.phase === 'active' && <Timer since={call.since} />}
                </p>
                {keypad && (
                  <>
                    <p className="ph-sent" aria-live="polite" data-testid="phone-sent">
                      {sent || ' '}
                    </p>
                    <Keypad
                      inCall
                      onKey={(k) => {
                        phone.tone(k)
                        setSent((t) => `${t}${k}`.slice(-24))
                      }}
                    />
                  </>
                )}
                <div className="ph-call-actions">
                  <button type="button" className={`ph-round ${call.muted ? 'ph-round-on' : ''}`} onClick={phone.mute} aria-pressed={call.muted} data-testid="phone-mute">
                    <Icon name={call.muted ? 'micOff' : 'mic'} />
                    <span>{call.muted ? 'Unmute' : 'Mute'}</span>
                  </button>
                  <button type="button" className={`ph-round ${keypad ? 'ph-round-on' : ''}`} onClick={() => setKeypad((v) => !v)} aria-pressed={keypad} data-testid="phone-keypad-toggle">
                    <Icon name="keypad" />
                    <span>Keypad</span>
                  </button>
                  <button type="button" className="ph-round ph-round-end" onClick={phone.hangup} data-testid="phone-hangup">
                    <Icon name="phone" />
                    <span>Hang up</span>
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={place}>
                {call?.phase === 'ended' && (
                  <p className="ph-ended" role="status" data-testid="phone-ended">
                    {phaseText('ended', call.cause)}
                  </p>
                )}
                <div className="ph-entry">
                  <input
                    className="ph-number"
                    type="tel"
                    inputMode="tel"
                    autoComplete="off"
                    value={typed}
                    onChange={(e) => setTyped(shown(cleanTyped(e.target.value)))}
                    placeholder="Enter a number"
                    aria-label="Number to call"
                    data-testid="phone-number"
                  />
                  <button type="button" className="ws-icon-btn" onClick={() => setTyped(backspace(typed))} disabled={!typed} aria-label="Delete the last digit" data-testid="phone-backspace">
                    <Icon name="backspace" />
                  </button>
                </div>
                <Keypad inCall={false} onKey={(k) => setTyped((t) => press(t, k))} />
                <button type="submit" className={`btn btn-big ph-call ${emergency ? 'btn-danger' : 'btn-primary'}`} disabled={!typed || phone.busy || (!ready && !emergency)} data-testid="phone-call">
                  <Icon name="phone" />
                  <span>{phone.busy ? 'Checking' : emergency ? 'Call 911' : 'Call'}</span>
                </button>
                <p className="fine ph-hint">911 dials straight away and always works, even when the month's minutes are used up. A cell phone is the better phone for an emergency.</p>
              </form>
            )}
          </section>

          <div className="ph-side">
            {!inSpace && <PhoneLineSettings phone={phone} />}
            {!inSpace && <PhoneSetup phone={phone} />}
            <p className="meter ph-minutes" data-testid="phone-minutes">
              {s.minutes.used} of {s.minutes.cap.toLocaleString()} minutes used this month
            </p>
            <section className="ph-card" aria-label="Recent calls">
              <h3>Recent calls</h3>
              {phone.log.length === 0 && <p className="fine">No calls yet.</p>}
              <ul className="ph-log" data-testid="phone-log">
                {phone.log.map((r) => (
                  <li key={r.id} className="ph-log-row" data-testid="phone-log-row" data-outcome={r.outcome}>
                    <div>
                      <div className="ph-log-number">
                        {r.display}
                        {r.emergency && <span className="ph-tag">911</span>}
                        {r.direction === 'in' && <span className="ph-tag ph-tag-in">In</span>}
                      </div>
                      <div className="fine">
                        {formatWhen(r.at)} · {outcomeText(r)}
                      </div>
                    </div>
                    {!r.emergency && r.number.startsWith('+1') && (
                      <button type="button" className="btn btn-small" onClick={() => setTyped(shown(r.number.slice(2)))} disabled={live} data-testid="phone-callback">
                        Call back
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
