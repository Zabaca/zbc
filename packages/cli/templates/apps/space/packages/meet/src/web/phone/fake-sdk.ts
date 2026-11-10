// The stand-in phone for a localhost run with the development bypass (the Worker says `sdk: 'fake'` only when it has the
// stand-in Telnyx, which it allows on a localhost host alone). It makes no sound and reaches no phone. What it does do is
// what the real phone does to meet: a call is "parked" by reporting it to the Worker's own webhook route as Telnyx would
// (/api/phone/dev/event, unsigned, localhost only), so the check drives the REAL approval, rules, meter and 911 notice.
//
// What it records for the check to read: `window.__phone` has the calls it was asked to place (with their headers), the tones
// sent and the mute state.

import { clientStateOf } from '../../phone-model'
import type { DialArgs, IncomingCall, Phase, PhoneCall, PhoneSdk } from './sdk'

interface Recorded {
  /** Calls that rang this phone, and what was done with each: 'ringing', 'answered', 'declined', 'ended'. */
  incoming: Array<{ from: string; leg: string; result: string }>
  dials: Array<DialArgs & { at: number }>
  tones: string[]
  muted: boolean
  hungUp: number
}

const record = (): Recorded => {
  const w = window as unknown as { __phone?: Recorded }
  return (w.__phone ??= { incoming: [], dials: [], tones: [], muted: false, hungUp: 0 })
}

/** A Telnyx event as the Worker's webhook takes it. */
const event = (type: string, payload: Record<string, unknown>) => ({
  data: { id: crypto.randomUUID(), event_type: type, occurred_at: new Date().toISOString(), payload },
})

async function report(body: unknown): Promise<{ dials: Array<{ callId: number; leg: string; clientState: string }>; hangups: string[] }> {
  const res = await fetch('/api/phone/dev/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return (await res.json()) as { dials: Array<{ callId: number; leg: string; clientState: string }>; hangups: string[] }
}

/** What the stand-in Telnyx has been asked (the Worker keeps it; /api/phone/dev/telnyx is how the check reads it too). */
async function asked(): Promise<Array<{ op: string; leg?: string; to?: string; from?: string; clientState?: string }>> {
  const res = await fetch('/api/phone/dev/telnyx')
  return ((await res.json()) as { calls: Array<{ op: string; leg?: string; to?: string; from?: string; clientState?: string }> }).calls
}

export function fakeSdk(): PhoneSdk {
  let poll: ReturnType<typeof setInterval> | null = null
  const seen = new Set<string>()
  return {
    connect(_token, on) {
      setTimeout(() => on.ready(), 150)
      // The real phone is rung by Telnyx; this one learns of a ring from the stand-in Telnyx, which records each leg meet rings.
      if (poll) clearInterval(poll)
      poll = setInterval(() => {
        void (async () => {
          let calls: Awaited<ReturnType<typeof asked>>
          try {
            calls = await asked()
          } catch {
            return
          }
          const gone = new Set(calls.filter((c) => c.op === 'hangup').map((c) => c.leg))
          for (const c of calls) {
            if (c.op !== 'ring' || !c.to?.startsWith('sip:') || !c.leg || seen.has(c.leg) || gone.has(c.leg)) continue
            seen.add(c.leg)
            const leg = c.leg
            const state = c.clientState ?? ''
            const rec = record()
            const entry = { from: c.from ?? '', leg, result: 'ringing' }
            rec.incoming.push(entry)
            let watcher: ((phase: Phase, cause?: string) => void) | null = null
            let over = false
            const finish = (phase: Phase, cause?: string, result?: string) => {
              if (over) return
              if (phase === 'ended') over = true
              if (result) entry.result = result
              watcher?.(phase, cause)
            }
            // Meet lets this phone go (another phone answered, the caller hung up): the next look at the stand-in's record sees the hang-up.
            const watchGone = setInterval(() => {
              void asked().then((all) => {
                if (all.some((x) => x.op === 'hangup' && x.leg === leg)) {
                  clearInterval(watchGone)
                  finish('ended', 'normal_clearing', entry.result === 'ringing' ? 'ended' : undefined)
                }
              }).catch(() => undefined)
            }, 400)
            const incoming: IncomingCall = {
              from: c.from ?? '',
              answer() {
                if (over) return
                void report(event('call.answered', { call_control_id: leg, client_state: state }))
                finish('active', undefined, 'answered')
              },
              decline() {
                if (over) return
                clearInterval(watchGone)
                void report(event('call.hangup', { call_control_id: leg, client_state: state, hangup_cause: 'call_rejected' }))
                finish('ended', 'call_rejected', 'declined')
              },
              watch(cb) {
                watcher = cb
              },
              hangup() {
                if (over) return
                clearInterval(watchGone)
                rec.hungUp += 1
                void report(event('call.hangup', { call_control_id: leg, client_state: state }))
                finish('ended', 'normal_clearing')
              },
              mute(on) {
                rec.muted = on
              },
              dtmf(key) {
                rec.tones.push(key)
              },
            }
            on.incoming(incoming)
          }
        })()
      }, 400)
    },
    dial(a, onPhase) {
      const rec = record()
      rec.dials.push({ ...a, at: Date.now() })
      const leg = `fake-${crypto.randomUUID().slice(0, 8)}`
      const state = clientStateOf(a.ticket, a.who)
      let dialed: { leg: string; clientState: string } | null = null
      let over = false
      const finish = (phase: Phase, cause?: string) => {
        if (over) return
        if (phase === 'ended') over = true
        onPhase(phase, cause)
      }
      onPhase('dialing')
      void (async () => {
        try {
          const done = await report(event('call.initiated', { call_control_id: leg, to: a.to, direction: 'outgoing', state: 'parked', client_state: state }))
          if (over) return
          const first = done.dials[0]
          if (!first) return finish('ended', 'refused')
          dialed = { leg: first.leg, clientState: first.clientState }
          setTimeout(() => !over && finish('ringing'), 250)
          setTimeout(() => {
            if (over || !dialed) return
            void report(event('call.answered', { call_control_id: dialed.leg, client_state: dialed.clientState }))
            finish('active')
          }, 700)
        } catch {
          finish('ended', 'network')
        }
      })()
      const call: PhoneCall = {
        hangup() {
          if (over) return
          rec.hungUp += 1
          const d = dialed
          void (async () => {
            if (d) await report(event('call.hangup', { call_control_id: d.leg, client_state: d.clientState }))
            await report(event('call.hangup', { call_control_id: leg, client_state: state }))
          })()
          finish('ended', 'normal_clearing')
        },
        mute(on) {
          rec.muted = on
        },
        dtmf(key) {
          rec.tones.push(key)
        },
      }
      return call
    },
    disconnect() {
      if (poll) clearInterval(poll)
      poll = null
    },
  }
}
