// A stand-in for Telnyx for local development and the browser check (scripts/phone.ts): it accepts every request, carries no
// sound and costs nothing, and keeps what it was asked in `calls` so the check can see that a call was dialed (or not).
//
// Used only when the dev flag FAKE_TELNYX=1 is set AND the request is for a localhost host (index.ts), the same two
// conditions as the Access bypass and the stand-in SFU. A deployed Worker has neither. The page runs its own stand-in phone
// (src/web/phone/fake-sdk.ts) when the Worker says `sdk: 'fake'`.

import type { Telnyx } from './telnyx'

export type DevTelnyx = Telnyx & { calls: Array<{ op: string; [k: string]: unknown }> }

/** 8 kHz mono 16-bit PCM, one second of zeros, with its WAV header. */
function silence(): Uint8Array<ArrayBuffer> {
  const rate = 8000
  const bytes = rate * 2
  const out = new Uint8Array(new ArrayBuffer(44 + bytes))
  const v = new DataView(out.buffer)
  const tag = (at: number, text: string) => [...text].forEach((c, i) => out.set([c.charCodeAt(0)], at + i))
  tag(0, 'RIFF')
  v.setUint32(4, 36 + bytes, true)
  tag(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  tag(36, 'data')
  v.setUint32(40, bytes, true)
  return out
}

export function devTelnyx(): DevTelnyx {
  let n = 0
  const calls: DevTelnyx['calls'] = []
  return {
    calls,
    async createCredential(name) {
      calls.push({ op: 'createCredential', name })
      return { id: `dev-cred-${++n}`, sipUsername: `gencreddev${n}` }
    },
    async loginToken(credentialId) {
      calls.push({ op: 'loginToken', credentialId })
      return 'dev-login-token'
    },
    async dial(a) {
      calls.push({ op: 'dial', to: a.to, from: a.from, fromName: a.fromName, linkTo: a.linkTo })
      return { leg: `dev-leg-${++n}` }
    },
    async hangup(leg) {
      calls.push({ op: 'hangup', leg })
    },
    async ring(a) {
      const leg = `dev-leg-${++n}`
      calls.push({ op: 'ring', leg, to: a.to, from: a.from, linkTo: a.linkTo, timeoutSecs: a.timeoutSecs, clientState: a.clientState })
      return { leg }
    },
    async answer(leg) {
      calls.push({ op: 'answer', leg })
    },
    async bridge(leg, withLeg) {
      calls.push({ op: 'bridge', leg, withLeg })
    },
    async screen(leg, text) {
      calls.push({ op: 'screen', leg, text })
    },
    async speak(leg, text) {
      calls.push({ op: 'speak', leg, text })
    },
    async record(leg, maxSecs) {
      calls.push({ op: 'record', leg, maxSecs })
    },
    async recordingAudio(recordingId) {
      calls.push({ op: 'recordingAudio', recordingId })
      // One second of silence as a WAV, so the page's player has something to play on a localhost run.
      return new Response(silence(), { status: 200, headers: { 'content-type': 'audio/wav' } })
    },
    async deleteRecording(recordingId) {
      calls.push({ op: 'deleteRecording', recordingId })
    },
    async registerEmergencyAddress(number, address) {
      calls.push({ op: 'registerEmergencyAddress', number, street: address.street })
      return { addressId: `dev-addr-${++n}` }
    },
    async balance() {
      return { availableUsd: 100 }
    },
  }
}
