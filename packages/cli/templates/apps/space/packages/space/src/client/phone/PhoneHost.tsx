// The browser phone, held by the space's shell so a call goes on while the person reads a conversation, and a call to the install's number rings wherever they are in the
// space (a call to the number rings the pages that carry meet's browser phone, and that is the space).
//
// It is meet's own hook (meet/src/web/phone/usePhone.ts) over this Worker's /api/phone. It asks once whether this person has a phone at all and draws nothing if not (the
// Telnyx account is not opened yet, so today nobody does): no banner, no bar, no request but that one. Only one tab at a time holds the phone's login.
import { useRingTone } from '@space/meet/src/web/phone/ring'
import { phaseText, ringTitle } from '@space/meet/src/web/phone/state'
import { type PhoneHandle, usePhone } from '@space/meet/src/web/phone/usePhone'
import { type ReactNode, createContext, useContext, useEffect } from 'react'
import { Glyph } from '../icons'
import { useInstall } from '../install'
import { spacePhoneApi } from './api'

const PhoneContext = createContext<PhoneHandle | null>(null)

/** The phone, or null outside a host (a test drawing one screen). `status` is null where this person has none. */
export const usePhoneHandle = (): PhoneHandle | null => useContext(PhoneContext)

export function PhoneHost({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const phone = usePhone(spacePhoneApi, enabled)
  // A call to the number is ringing this phone: a ring sound, and the tab's title flashing so it is noticed in another tab.
  const ringing = phone.ringing
  useRingTone(ringing !== null)
  useEffect(() => {
    if (!ringing) return
    const held = document.title
    let on = false
    const id = setInterval(() => {
      on = !on
      document.title = on ? ringTitle(ringing.display) : held
    }, 1000)
    return () => {
      clearInterval(id)
      document.title = held
    }
  }, [ringing])
  return <PhoneContext.Provider value={phone}>{children}</PhoneContext.Provider>
}

/** What is drawn above the screen while the phone rings or a call is on: meet's banner and bar, inside `.meet-screen` for its rules. */
export function PhoneBars({ openPhone }: { openPhone(): void }) {
  const phone = usePhoneHandle()
  const { company } = useInstall()
  if (!phone || !phone.status) return null
  const live = phone.call !== null && phone.call.phase !== 'ended'
  if (!phone.ringing && !live) return null
  return (
    <div className="meet-screen phone-bars">
      {phone.ringing && (
        <div className="ph-ring" role="alert" data-testid="phone-ringing">
          <Glyph name="phone" size={15} />
          <span className="ph-ring-who">
            <strong data-testid="phone-ringing-from">{phone.ringing.display}</strong> is calling {company}
          </span>
          <button type="button" className="btn btn-small btn-primary" onClick={phone.answer} data-testid="phone-answer">
            Answer
          </button>
          <button type="button" className="btn btn-small btn-danger" onClick={phone.decline} data-testid="phone-decline">
            Decline
          </button>
        </div>
      )}
      {live && phone.call && (
        <div className="ph-bar" role="status" data-testid="phone-bar">
          <Glyph name="phone" size={15} />
          <button type="button" className="ws-link-btn ph-bar-open" onClick={openPhone}>
            {phaseText(phone.call.phase)}: {phone.call.display}
          </button>
          <button type="button" className="btn btn-small btn-danger" onClick={phone.hangup} data-testid="phone-bar-hangup">
            Hang up
          </button>
        </div>
      )}
    </div>
  )
}
