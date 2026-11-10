// The browser's phone, behind one small interface (docs/adr/0004, section 3): Telnyx's own browser SDK (@telnyx/webrtc, MIT)
// in production, a stand-in on a localhost run with the development bypass (fake-sdk.ts, as the stand-in SFU is). The page and
// its tests only ever see `PhoneSdk`, so swapping the provider replaces this file and the Worker's telnyx.ts, nothing else.
//
// The SDK is loaded only in the space, for a person of the company with the phone (never on /w or a call page): a dynamic import, so it is
// a chunk of its own that nobody else downloads.

import { HEADER_TICKET, HEADER_WHO, clientStateOf } from '../../phone-model'

export type Phase = 'dialing' | 'ringing' | 'active' | 'ended'

export interface PhoneCall {
  hangup(): void
  mute(on: boolean): void
  /** One key as a tone: 0 to 9, * or #. */
  dtmf(key: string): void
}

/** A call ringing this browser's phone (a call to the line's number, docs/adr/0005). Once answered it is a PhoneCall like any other. */
export interface IncomingCall extends PhoneCall {
  /** The number that called, as Telnyx names it; '' when it was withheld. */
  from: string
  answer(): void
  /** Let this phone go: the call keeps ringing the others, and moves on when every phone has. */
  decline(): void
  /** How the call goes from here: answered, ended (hung up, answered somewhere else, or nobody was left to talk to). One watcher. */
  watch(onPhase: (phase: Phase, cause?: string) => void): void
}

export interface DialArgs {
  /** What Telnyx is given: +1NXXNXXXXXX, 911 or 933. */
  to: string
  callerNumber: string
  callerName: string
  /** The approval meet's server gave for this call, or null for 911. */
  ticket: string | null
  who: string
}

export interface PhoneSdk {
  /** Log in with a token meet's server made. `closed` is called when the connection to Telnyx is lost. */
  connect(token: string, on: { ready(): void; failed(message: string): void; closed(): void; incoming(call: IncomingCall): void }): void
  dial(a: DialArgs, onPhase: (phase: Phase, cause?: string) => void): PhoneCall
  disconnect(): void
}

/** Telnyx's call states, in the words the page uses. */
export function phaseOf(state: string): Phase | null {
  switch (state) {
    case 'new':
    case 'requesting':
    case 'trying':
    case 'recovering':
      return 'dialing'
    case 'early':
    case 'ringing':
      return 'ringing'
    case 'active':
    case 'answering':
    case 'held':
      return 'active'
    case 'hangup':
    case 'destroy':
    case 'purge':
      return 'ended'
    default:
      return null
  }
}

/** The parts of Telnyx's call object the page uses. */
interface TelnyxCall {
  id: string
  state: string
  direction: string
  cause?: string
  options?: { remoteCallerNumber?: string }
  hangup(): Promise<void>
  answer(): Promise<void>
  muteAudio(): void
  unmuteAudio(): void
  dtmf(key: string): void
}

/** The real phone. `remote` is the audio element the other person's voice plays through. */
async function telnyxSdk(remote: HTMLAudioElement): Promise<PhoneSdk> {
  const { TelnyxRTC } = await import('@telnyx/webrtc')
  let client: InstanceType<typeof TelnyxRTC> | null = null
  let onPhase: ((phase: Phase, cause?: string) => void) | null = null
  return {
    connect(token, on) {
      client?.disconnect().catch(() => undefined)
      const c = new TelnyxRTC({ login_token: token })
      c.remoteElement = remote
      c.on('telnyx.ready', () => on.ready())
      c.on('telnyx.error', (e: { error?: { message?: string } }) => on.failed(e?.error?.message ?? 'The phone could not connect.'))
      c.on('telnyx.socket.close', () => on.closed())
      const ringing = new Map<string, (phase: Phase, cause?: string) => void>()
      c.on('telnyx.notification', (n: { type: string; call?: TelnyxCall }) => {
        if (n.type !== 'callUpdate' || !n.call) return
        const call = n.call
        if (call.direction === 'inbound') {
          const watcher = ringing.get(call.id)
          if (watcher) {
            const phase = phaseOf(call.state)
            if (phase) watcher(phase, phase === 'ended' ? call.cause : undefined)
            if (phase === 'ended') ringing.delete(call.id)
            return
          }
          if (phaseOf(call.state) === 'ended' || ringing.has(call.id)) return
          let watch: (phase: Phase, cause?: string) => void = () => undefined
          ringing.set(call.id, (phase, cause) => watch(phase, cause))
          on.incoming({
            from: call.options?.remoteCallerNumber ?? '',
            answer: () => void call.answer(),
            decline: () => void call.hangup(),
            watch: (cb) => {
              watch = cb
            },
            hangup: () => void call.hangup(),
            mute: (muted) => (muted ? call.muteAudio() : call.unmuteAudio()),
            dtmf: (key) => call.dtmf(key),
          })
          return
        }
        const phase = phaseOf(call.state)
        if (phase) onPhase?.(phase, phase === 'ended' ? call.cause : undefined)
      })
      client = c
      void c.connect()
    },
    dial(a, phaseCb) {
      if (!client) throw new Error('The phone is not connected.')
      onPhase = phaseCb
      const call = client.newCall({
        destinationNumber: a.to,
        callerNumber: a.callerNumber,
        callerName: a.callerName,
        audio: true,
        video: false,
        // The approval rides two ways, and meet's webhook reads either: custom headers and the client state.
        customHeaders: [
          ...(a.ticket ? [{ name: HEADER_TICKET, value: a.ticket }] : []),
          { name: HEADER_WHO, value: a.who },
        ],
        clientState: clientStateOf(a.ticket, a.who),
      })
      return {
        hangup: () => void call.hangup(),
        mute: (on) => (on ? call.muteAudio() : call.unmuteAudio()),
        dtmf: (key) => call.dtmf(key),
      }
    },
    disconnect() {
      void client?.disconnect()
      client = null
    },
  }
}

/** Which phone to run: the one the Worker says. The stand-in is a separate chunk that a deployed page never asks for. */
export async function loadSdk(kind: 'telnyx' | 'fake', remote: HTMLAudioElement): Promise<PhoneSdk> {
  if (kind === 'fake') return (await import('./fake-sdk')).fakeSdk()
  return telnyxSdk(remote)
}
