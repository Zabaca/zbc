// The page's phone: what the space holds while a person of the company is signed in, so a call goes on while they read a
// conversation. It asks meet whether this person has a phone at all, and shows nothing if not; logs the browser's phone in with a
// token meet's server makes; asks meet to approve each call before it dials (911 excepted, which asks nothing first); and
// keeps the call's state for the panel and the bar.

import { useCallback, useEffect, useRef, useState } from 'react'
import { LINE } from '../../phone-line'
import { type CallLogRow, type E911Address, type LineSettings, type PhoneStatus, displayNumber } from '../../phone-model'
import { ApiError } from '../api'
import { type IncomingCall, type Phase, type PhoneCall, type PhoneSdk, loadSdk } from './sdk'
import { isEmergencyTyped, refusalText } from './state'

/** The browser's phone as a person sees it: offline, connecting, ready, or not working. */
export type Line = 'off' | 'connecting' | 'ready' | 'failed' | 'other-tab'

/** A call to the line's number, ringing this person's phone. */
export interface Ringing {
  from: string
  display: string
}

export interface ActiveCall {
  /** A call out is one this person placed; a call in is one they answered. */
  direction: 'out' | 'in'
  to: string
  display: string
  phase: Phase
  cause?: string
  muted: boolean
  /** When it was answered: the timer starts then. */
  since: number | null
  emergency: boolean
}

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)
/** A token lasts 24 hours at Telnyx; the phone logs in again with a fresh one long before. */
const RELOGIN_MS = 20 * 60 * 60 * 1000

/**
 * What the phone asks of its host: the dial pad's own requests, and nothing else. The space answers them at /api/phone (packages/space/src/client/phone/api.ts),
 * which hands them on to meet; meet's own phone rules decide.
 */
export interface PhoneApi {
  phone(): Promise<PhoneStatus | { available: false }>
  phoneAck(): Promise<PhoneStatus>
  phoneAddress(address: E911Address): Promise<PhoneStatus>
  phoneConfirmAddress(): Promise<PhoneStatus>
  phoneToken(): Promise<{ token: string; sdk: 'telnyx' | 'fake'; who: string }>
  /** The approval for one call. A refusal is an ApiError whose message is the reason, in words. */
  phoneCall(to: string): Promise<{ to: string; display: string; emergency: boolean; ticket: string | null }>
  phoneEmergency(): Promise<{ ok: true }>
  phoneCalls(): Promise<{ calls: CallLogRow[] }>
  /** The line's cell and how long meet rings first (docs/adr/0005). */
  phoneSettings(patch: Partial<Pick<LineSettings, 'cell' | 'ringSeconds'>>): Promise<PhoneStatus>
}

export function usePhone(api: PhoneApi, enabled: boolean) {
  const [status, setStatus] = useState<PhoneStatus | null>(null)
  const [line, setLine] = useState<Line>('off')
  const [call, setCall] = useState<ActiveCall | null>(null)
  const [ringing, setRinging] = useState<Ringing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<CallLogRow[]>([])
  const [busy, setBusy] = useState(false)
  const sdk = useRef<PhoneSdk | null>(null)
  const pc = useRef<PhoneCall | null>(null)
  const ringCall = useRef<IncomingCall | null>(null)
  const callRef = useRef<ActiveCall | null>(null)
  const statusRef = useRef<PhoneStatus | null>(null)
  const lineRef = useRef<Line>('off')
  const audio = useRef<HTMLAudioElement | null>(null)
  const logRef = useRef<CallLogRow[]>([])
  const loggedInAt = useRef(0)
  const retries = useRef(0)
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])

  const setCallBoth = useCallback((next: ActiveCall | null) => {
    callRef.current = next
    setCall(next)
  }, [])
  const setLineBoth = useCallback((next: Line) => {
    lineRef.current = next
    setLine(next)
  }, [])
  const setStatusBoth = useCallback((next: PhoneStatus | null) => {
    statusRef.current = next
    setStatus(next)
  }, [])

  /** What meet holds now: the minutes, the setup, the log. */
  const refresh = useCallback(async (): Promise<CallLogRow[] | null> => {
    try {
      const s = await api.phone()
      setStatusBoth('available' in s && s.available ? (s as PhoneStatus) : null)
      const rows = (await api.phoneCalls()).calls
      logRef.current = rows
      setLog(rows)
      return rows
    } catch {
      // The panel keeps what it has; the next call tries again.
      return null
    }
  }, [api, setStatusBoth])

  const connect = useCallback(async () => {
    setLineBoth('connecting')
    try {
      const t = await api.phoneToken()
      if (!audio.current) {
        audio.current = new Audio()
        audio.current.autoplay = true
      }
      sdk.current ??= await loadSdk(t.sdk, audio.current)
      sdk.current.connect(t.token, {
        ready: () => {
          retries.current = 0
          loggedInAt.current = Date.now()
          setLineBoth('ready')
        },
        failed: (message) => {
          setLineBoth('failed')
          setError(message)
        },
        incoming: (c) => {
          // One call at a time. A second ring while one is ringing or a call is on is let go: the other phones ring on, and then the cell or
          // the voicemail takes it.
          if (ringCall.current || (callRef.current && callRef.current.phase !== 'ended')) return c.decline()
          ringCall.current = c
          setRinging({ from: c.from, display: c.from ? displayNumber(c.from) : 'Unknown number' })
          c.watch((phase, cause) => {
            if (phase === 'ended') {
              // Hung up, answered at another phone, or nobody left for the caller to talk to: the ring stops either way.
              if (ringCall.current === c) {
                ringCall.current = null
                setRinging(null)
                void refresh()
              }
              if (pc.current === c) {
                pc.current = null
                const cur = callRef.current
                if (cur) setCallBoth({ ...cur, phase: 'ended', cause })
                timers.current.push(
                  setTimeout(() => {
                    if (callRef.current?.phase === 'ended') setCallBoth(null)
                  }, 2800),
                )
                void refresh()
                if (lineRef.current !== 'ready') void connect()
              }
            }
          })
        },
        closed: () => {
          // Lost the connection. Log in again by itself, slowly, unless a call is on (the call's own end brings it back).
          if (callRef.current) return
          setLineBoth('connecting')
          retries.current += 1
          if (retries.current > 6) return setLineBoth('failed')
          timers.current.push(setTimeout(() => void connect(), Math.min(30_000, 1500 * 2 ** retries.current)))
        },
      })
    } catch (e) {
      setLineBoth('failed')
      setError(errorText(e, 'The phone could not connect.'))
    }
  }, [api, setLineBoth])

  // Ask once whether this person has a phone, and if so, log in. Only one tab at a time holds the phone's login.
  useEffect(() => {
    if (!enabled) return
    let gone = false
    void (async () => {
      let s: Awaited<ReturnType<typeof api.phone>>
      try {
        s = await api.phone()
      } catch {
        return
      }
      if (gone || !('available' in s) || !s.available) return
      setStatusBoth(s as PhoneStatus)
      const first = (await api.phoneCalls().catch(() => ({ calls: [] as CallLogRow[] }))).calls
      logRef.current = first
      setLog(first)
      const locks = (navigator as Navigator & { locks?: LockManager }).locks
      if (!locks) return void connect()
      // Held until this page goes away: the lock IS the claim to be the one tab with the phone.
      void locks.request('meet-phone', { ifAvailable: true }, (lock) => {
        if (!lock) {
          setLineBoth('other-tab')
          return undefined
        }
        if (!gone) void connect()
        return new Promise<void>(() => undefined)
      })
    })()
    return () => {
      gone = true
    }
  }, [enabled, api, connect, setLineBoth, setStatusBoth])

  // A login older than 20 hours is renewed when no call is on.
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => {
      if (lineRef.current === 'ready' && !callRef.current && Date.now() - loggedInAt.current > RELOGIN_MS) void connect()
    }, 10 * 60_000)
    return () => clearInterval(id)
  }, [enabled, connect])

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t)
      sdk.current?.disconnect()
      sdk.current = null
    },
    [],
  )

  const dial = useCallback(
    async (typed: string) => {
      const st = statusRef.current
      // A call that has just ended stays on screen a moment; it does not stand in the way of the next one.
      if ((callRef.current && callRef.current.phase !== 'ended') || !st) return
      setError(null)
      if (callRef.current) setCallBoth(null)
      const emergency = isEmergencyTyped(typed)
      if (lineRef.current !== 'ready' || !sdk.current) {
        setError(emergency ? 'The phone is not connected. Use your cell phone to call 911.' : 'The phone is not connected yet.')
        return
      }
      let approval: { to: string; display: string; emergency: boolean; ticket: string | null }
      if (emergency) {
        // Nothing is asked of meet before 911 goes out: the report to the owner is sent alongside, and the call does not wait for it.
        approval = { to: '911', display: '911', emergency: true, ticket: null }
        void api.phoneEmergency().catch(() => undefined)
      } else {
        setBusy(true)
        try {
          approval = await api.phoneCall(typed)
        } catch (e) {
          setError(errorText(e, 'meet could not check that call. Try again.'))
          return
        } finally {
          setBusy(false)
        }
      }
      // Rows newer than this are this call's: if meet's webhook refused it, the reason is in one of them.
      const newerThan = logRef.current[0]?.id ?? 0
      setCallBoth({ direction: 'out', to: approval.to, display: approval.display, phase: 'dialing', muted: false, since: null, emergency: approval.emergency })
      try {
        pc.current = sdk.current.dial({ to: approval.to, callerNumber: st.line, callerName: st.callerName, ticket: approval.ticket, who: st.who }, (phase, cause) => {
          const cur = callRef.current
          if (!cur) return
          if (phase === 'ended') {
            setCallBoth({ ...cur, phase, cause })
            pc.current = null
            timers.current.push(
              setTimeout(() => {
                if (callRef.current?.phase === 'ended') setCallBoth(null)
              }, 2800),
            )
            void refresh().then((rows) => {
              const why = rows?.filter((r) => r.id > newerThan).map(refusalText).find((t) => t !== null)
              if (why) setError(why)
            })
            // A call that was on kept the phone from logging in again; if the connection dropped meanwhile, do it now.
            if (lineRef.current !== 'ready') void connect()
          } else setCallBoth({ ...cur, phase, since: phase === 'active' && cur.since === null ? Date.now() : cur.since })
        })
      } catch (e) {
        setCallBoth(null)
        setError(errorText(e, 'The call could not start.'))
      }
    },
    [api, connect, refresh, setCallBoth],
  )

  return {
    /** null: no phone for this person (or not yet known): show nothing. */
    status,
    /** A call to the number is ringing this phone, or null. */
    ringing,
    answer: () => {
      const c = ringCall.current
      if (!c || (callRef.current && callRef.current.phase !== 'ended')) return
      ringCall.current = null
      const r = ringing
      setRinging(null)
      pc.current = c
      setCallBoth({ direction: 'in', to: c.from, display: r?.display ?? 'Unknown number', phase: 'active', muted: false, since: Date.now(), emergency: false })
      c.answer()
    },
    decline: () => {
      const c = ringCall.current
      if (!c) return
      ringCall.current = null
      setRinging(null)
      c.decline()
    },
    /** Save the line's cell and ring time. The message to show, or null when kept. */
    saveSettings: async (patch: Partial<Pick<LineSettings, 'cell' | 'ringSeconds'>>): Promise<string | null> => {
      try {
        setStatusBoth(await api.phoneSettings(patch))
        return null
      } catch (e) {
        return errorText(e, 'Could not save that.')
      }
    },
    line,
    call,
    error,
    log,
    busy,
    dial,
    hangup: () => pc.current?.hangup(),
    mute: () => {
      const cur = callRef.current
      if (!cur || !pc.current) return
      pc.current.mute(!cur.muted)
      setCallBoth({ ...cur, muted: !cur.muted })
    },
    tone: (key: string) => pc.current?.dtmf(key),
    clearError: () => setError(null),
    retry: () => {
      retries.current = 0
      setError(null)
      void connect()
    },
    ack: async () => {
      try {
        setStatusBoth(await api.phoneAck())
      } catch (e) {
        setError(errorText(e, 'Could not save that.'))
      }
    },
    /** The message to show under the form, or null when the address was kept and registered. */
    saveAddress: async (address: E911Address): Promise<string | null> => {
      try {
        setStatusBoth(await api.phoneAddress(address))
        // The refusal that sent the person here ("set up your 911 address") is answered.
        setError(null)
        return null
      } catch (e) {
        void refresh()
        return errorText(e, 'Could not save the address.')
      }
    },
    confirmAddress: async () => {
      try {
        setStatusBoth(await api.phoneConfirmAddress())
      } catch {
        // Asked again next time.
      }
    },
  }
}

export type PhoneHandle = ReturnType<typeof usePhone>
