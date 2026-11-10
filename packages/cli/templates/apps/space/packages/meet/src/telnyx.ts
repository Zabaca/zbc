// Everything meet says to Telnyx, and everything Telnyx says to meet, in one small typed place (docs/adr/0004).
//
// The phone rules (phone.ts) never name Telnyx: they decide who, which number and whether. This file turns a decision
// into Telnyx's calls (`Telnyx`, arriving in the router's Deps as the SFU client does, with a fake that records what it
// was asked in the tests), checks that a webhook really came from Telnyx, and reads an event into the shape the rules
// take. Swapping to Twilio would replace this file, the page's phone adapter and nothing else.
//
// Every path and field below was read from Telnyx's own docs and none has been run against an account:
// the hand test in docs/adr/0004 lists what to look at first.

import { LINE } from './phone-line'
import { type E911Address, HEADER_TICKET, HEADER_WHO } from './phone-model'

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export const API = 'https://api.telnyx.com/v2'
/** Telnyx's own replay advice is "your window"; five minutes is the usual. */
export const WEBHOOK_WINDOW_MS = 5 * 60_000
const TIMEOUT_MS = 8_000

export class TelnyxError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** The one place a request leaves for Telnyx. The key is a header and nothing else; no body, log or error carries it. */
export interface Http {
  request<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>
  /** For the one answer that is plain text, not JSON (a login token). */
  text(method: 'POST', path: string): Promise<string>
  /**
   * A file at an address Telnyx handed back (a recording's download link), fetched WITHOUT the API key: the link is signed,
   * and the key goes to Telnyx's API alone. Never throws for a status; the caller reads it.
   */
  file(url: string, range: string | null): Promise<Response>
}

export function telnyxHttp(apiKey: string, fetchImpl: Fetch = (u, i) => fetch(u, i)): Http {
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response
    try {
      res = await fetchImpl(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      throw new TelnyxError(0, `Telnyx did not answer ${method} ${path}: ${err instanceof Error ? err.name : 'error'}`)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // Telnyx's own error text is useful in a log; it carries no secret of ours.
      throw new TelnyxError(res.status, `Telnyx answered ${res.status} to ${method} ${path}: ${detail.slice(0, 300)}`)
    }
    return res
  }
  return {
    async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
      const res = await send(method, path, body)
      return (res.status === 204 ? {} : await res.json().catch(() => ({}))) as T
    },
    async text(method, path) {
      return (await send(method, path)).text()
    },
    async file(url, range) {
      try {
        return await fetchImpl(url, { method: 'GET', headers: range ? { range } : {}, signal: AbortSignal.timeout(TIMEOUT_MS * 3) })
      } catch (err) {
        // The message must not carry the link: it is signed, and a log is not a place for it.
        throw new TelnyxError(0, `Telnyx's storage did not answer: ${err instanceof Error ? err.name : 'error'}`)
      }
    },
  }
}

// --- What the Worker asks of Telnyx -----------------------------------------

export interface Telnyx {
  /** A phone's login: one credential per person on the connection, kept by id. */
  createCredential(name: string): Promise<{ id: string; sipUsername: string }>
  /** A token the browser's phone logs in with. Telnyx's own API makes them, good for 24 hours. */
  loginToken(credentialId: string): Promise<string>
  /** Dial a number and bridge it to the parked browser leg when it answers. */
  dial(a: { to: string; from: string; fromName: string; linkTo: string; clientState: string; timeLimitSecs: number }): Promise<{ leg: string }>
  hangup(leg: string): Promise<void>
  /**
   * A call in (docs/adr/0005). Ring one more leg for a call that is parked at Telnyx: a browser phone (a SIP address) or the
   * cell. It is linked to the parked leg with the intent to bridge, so Telnyx shows the caller's own number, but it is NOT
   * bridged on answer: meet decides who wins and bridges that leg itself.
   */
  ring(a: { to: string; from: string; fromName: string; linkTo: string; clientState: string; timeoutSecs: number; timeLimitSecs: number }): Promise<{ leg: string }>
  /** Answer the parked incoming leg (billing for it starts). Commands on an incoming call need it answered first. */
  answer(leg: string, clientState: string): Promise<void>
  /** Join two answered legs. */
  bridge(leg: string, withLeg: string, clientState: string): Promise<void>
  /** Say `text` on a leg and wait for one key; the result arrives as call.gather.ended. */
  screen(leg: string, text: string, clientState: string): Promise<void>
  /** Say `text` on a leg; call.speak.ended follows. */
  speak(leg: string, text: string, clientState: string): Promise<void>
  /** Record the leg: the voicemail, and nothing else in meet is ever recorded. A beep first, at most `maxSecs`. */
  record(leg: string, maxSecs: number, clientState: string): Promise<void>
  /** A voicemail's sound, fetched by its id each time: the answer is the file's own response, which meet passes on and never links to. */
  recordingAudio(recordingId: string, range: string | null): Promise<Response>
  /** Delete a voicemail at Telnyx. A recording that is already gone is what was wanted. */
  deleteRecording(recordingId: string): Promise<void>
  /** Put an address on a number for 911, replacing what is there. `name` is the person's, with the business the line is (the install's company). */
  registerEmergencyAddress(number: string, address: E911Address, name: { first: string; last: string; business: string }): Promise<{ addressId: string }>
  /** What is left to spend. */
  balance(): Promise<{ availableUsd: number }>
}

const data = <T>(r: unknown): T => ((r as { data?: T }).data ?? ({} as T))

export function telnyxClient(http: Http, cfg: { connectionId: string }): Telnyx {
  return {
    async createCredential(name) {
      // `tag` marks ours; the connection can hold many credentials.
      const d = data<{ id: string; sip_username: string }>(await http.request('POST', '/telephony_credentials', { connection_id: cfg.connectionId, name, tag: 'meet' }))
      if (!d.id || !d.sip_username) throw new TelnyxError(502, 'Telnyx made a credential without an id')
      return { id: d.id, sipUsername: d.sip_username }
    },
    async loginToken(credentialId) {
      const token = (await http.text('POST', `/telephony_credentials/${encodeURIComponent(credentialId)}/token`)).trim()
      if (!token) throw new TelnyxError(502, 'Telnyx made an empty login token')
      return token
    },
    async dial(a) {
      const d = data<{ call_control_id: string }>(
        await http.request('POST', '/calls', {
          connection_id: cfg.connectionId,
          to: a.to,
          from: a.from,
          from_display_name: a.fromName,
          link_to: a.linkTo,
          bridge_on_answer: true,
          time_limit_secs: a.timeLimitSecs,
          client_state: a.clientState,
        }),
      )
      if (!d.call_control_id) throw new TelnyxError(502, 'Telnyx dialed without returning a call id')
      return { leg: d.call_control_id }
    },
    async hangup(leg) {
      try {
        await http.request('POST', `/calls/${encodeURIComponent(leg)}/actions/hangup`, {})
      } catch (err) {
        // A leg that is already gone is what was wanted.
        if (!(err instanceof TelnyxError && (err.status === 404 || err.status === 422))) throw err
      }
    },
    async ring(a) {
      const d = data<{ call_control_id: string }>(
        await http.request('POST', '/calls', {
          connection_id: cfg.connectionId,
          to: a.to,
          from: a.from,
          from_display_name: a.fromName,
          link_to: a.linkTo,
          bridge_intent: true,
          timeout_secs: a.timeoutSecs,
          time_limit_secs: a.timeLimitSecs,
          client_state: a.clientState,
        }),
      )
      if (!d.call_control_id) throw new TelnyxError(502, 'Telnyx rang without returning a call id')
      return { leg: d.call_control_id }
    },
    async answer(leg, clientState) {
      await http.request('POST', `/calls/${encodeURIComponent(leg)}/actions/answer`, { client_state: clientState })
    },
    async bridge(leg, withLeg, clientState) {
      await http.request('POST', `/calls/${encodeURIComponent(leg)}/actions/bridge`, { call_control_id: withLeg, client_state: clientState })
    },
    async screen(leg, text, clientState) {
      await http.request('POST', `/calls/${encodeURIComponent(leg)}/actions/gather_using_speak`, {
        payload: text,
        voice: LINE.inbound.voice,
        language: LINE.inbound.language,
        minimum_digits: 1,
        maximum_digits: 1,
        valid_digits: '1',
        maximum_tries: 1,
        timeout_millis: 6000,
        client_state: clientState,
      })
    },
    async speak(leg, text, clientState) {
      await http.request('POST', `/calls/${encodeURIComponent(leg)}/actions/speak`, { payload: text, voice: LINE.inbound.voice, language: LINE.inbound.language, client_state: clientState })
    },
    async record(leg, maxSecs, clientState) {
      await http.request('POST', `/calls/${encodeURIComponent(leg)}/actions/record_start`, { format: 'mp3', channels: 'single', play_beep: true, max_length: maxSecs, client_state: clientState })
    },
    async recordingAudio(recordingId, range) {
      const d = data<{ download_urls?: { mp3?: string; wav?: string } }>(await http.request('GET', `/recordings/${encodeURIComponent(recordingId)}`))
      const url = d.download_urls?.mp3 ?? d.download_urls?.wav
      if (!url || !/^https:\/\//i.test(url)) throw new TelnyxError(502, 'Telnyx has no file for that recording')
      return http.file(url, range)
    },
    async deleteRecording(recordingId) {
      try {
        await http.request('DELETE', `/recordings/${encodeURIComponent(recordingId)}`)
      } catch (err) {
        if (!(err instanceof TelnyxError && err.status === 404)) throw err
      }
    },
    async registerEmergencyAddress(number, address, name) {
      const found = data<Array<{ id: string }>>(await http.request('GET', `/phone_numbers?filter[phone_number]=${encodeURIComponent(number)}`))
      const numberId = found[0]?.id
      if (!numberId) throw new TelnyxError(404, `Telnyx has no number ${number} on this account`)
      const made = data<{ id: string }>(
        await http.request('POST', '/addresses', {
          first_name: name.first,
          last_name: name.last,
          business_name: name.business,
          street_address: address.street,
          extended_address: address.extended || undefined,
          locality: address.city,
          administrative_area: address.state,
          postal_code: address.zip,
          country_code: 'US',
        }),
      )
      if (!made.id) throw new TelnyxError(502, 'Telnyx made an address without an id')
      await http.request('POST', `/phone_numbers/${encodeURIComponent(numberId)}/actions/enable_emergency`, { emergency_enabled: true, emergency_address_id: made.id })
      return { addressId: made.id }
    },
    async balance() {
      const d = data<{ available_credit?: string | number; balance?: string | number }>(await http.request('GET', '/balance'))
      const n = Number(d.available_credit ?? d.balance)
      if (!Number.isFinite(n)) throw new TelnyxError(502, 'Telnyx gave no balance')
      return { availableUsd: n }
    },
  }
}

// --- Webhooks ------------------------------------------------------------------

const b64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.trim().replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Telnyx signs `<telnyx-timestamp>|<raw body>` with Ed25519; the signature header is base64 and the account's public key
 * (portal, Keys and Credentials) is base64 of the 32 raw bytes. A timestamp outside the window is refused as a replay.
 * Never throws: anything malformed is simply "not Telnyx".
 */
export async function verifyWebhook(a: { publicKey: string; signature: string | undefined; timestamp: string | undefined; body: string; now: number }): Promise<boolean> {
  try {
    if (!a.signature || !a.timestamp || !/^\d{9,12}$/.test(a.timestamp)) return false
    if (Math.abs(a.now - Number(a.timestamp) * 1000) > WEBHOOK_WINDOW_MS) return false
    const key = await crypto.subtle.importKey('raw', b64(a.publicKey), { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, b64(a.signature), new TextEncoder().encode(`${a.timestamp}|${a.body}`))
  } catch {
    return false
  }
}

/** One Telnyx event, as the phone rules take it. */
export interface PhoneEvent {
  id: string
  type: string
  /** When it happened, ms. */
  at: number
  /** The call leg's id (Telnyx's call_control_id). */
  leg: string
  to: string
  /** Who called, as Telnyx names the caller (a call in); '' when it does not say. */
  from: string
  direction: string
  /** The connection the call is on (Telnyx's connection_id), if it says. */
  connection: string | null
  /** Telnyx's state for the leg ("parked" for a browser call held for meet), if it says. */
  state: string | null
  /**
   * What the leg's client state says when it is the form meet makes for the leg it dials ("meet:<call id>:<nonce>"). A
   * claim, not a fact: the browser sets its own call's client state too, so the phone core trusts it only with the nonce.
   */
  ours: { id: number; nonce: string; leg: number | null } | null
  /** call.gather.ended: the key pressed (the screening) and how the gather ended; call.recording.saved: the recording's id and its times. */
  digits: string | null
  gather: string | null
  recordingId: string | null
  recordingStart: number | null
  recordingEnd: number | null
  /** What the page sent with a call: the approval ticket and the person's opaque id. */
  ticket: string | null
  who: string | null
  start: number | null
  end: number | null
  cause: string | null
}

const OURS = /^meet:(\d{1,12}):([0-9a-f]{16})(?::(\d{1,12}))?$/
/**
 * The client state meet puts on a leg it dials or commands: the call's id and its random nonce, and for a call in the id of
 * the leg's own row (the leg id Telnyx gives is not known until the dial request returns, and an event can beat it).
 */
export const ourState = (callId: number, nonce: string, leg?: number): string => btoa(`meet:${callId}:${nonce}${leg === undefined ? '' : `:${leg}`}`)

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length < 4096 ? v : null)
const ms = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN
  return Number.isFinite(t) ? t : null
}

/**
 * Telnyx's JSON into a PhoneEvent, or null for a shape that is not a call event. The approval can ride two ways and
 * both are read: custom SIP headers (a list of {header_name, header_value} in events, {name, value} in commands) and
 * the client state the page set (base64 of {t, w}). Which one a parked browser call arrives with is the first thing the
 * hand test looks at.
 */
export function parseEvent(raw: unknown): PhoneEvent | null {
  const d = (raw as { data?: Record<string, unknown> } | null)?.data
  if (!d || typeof d !== 'object') return null
  const p = d.payload as Record<string, unknown> | undefined
  const id = str(d.id)
  const type = str(d.event_type)
  const leg = str(p?.call_control_id)
  if (!p || !id || !type || !leg) return null

  let ours: { id: number; nonce: string; leg: number | null } | null = null
  let ticket: string | null = null
  let who: string | null = null
  const state = str(p.client_state)
  if (state) {
    try {
      const text = atob(state)
      const m = OURS.exec(text)
      if (m) ours = { id: Number(m[1]), nonce: m[2] as string, leg: m[3] === undefined ? null : Number(m[3]) }
      else {
        const j = JSON.parse(text) as { t?: unknown; w?: unknown }
        ticket = str(j.t)
        who = str(j.w)
      }
    } catch {
      // Not ours and not the page's: ignored.
    }
  }
  if (Array.isArray(p.custom_headers)) {
    for (const h of p.custom_headers as Array<Record<string, unknown>>) {
      const name = str(h?.header_name ?? h?.name)?.toLowerCase()
      const value = str(h?.header_value ?? h?.value)
      if (name === HEADER_TICKET.toLowerCase()) ticket = value ?? ticket
      else if (name === HEADER_WHO.toLowerCase()) who = value ?? who
    }
  }
  return {
    id,
    type,
    at: ms(d.occurred_at) ?? Date.now(),
    leg,
    to: str(p.to) ?? '',
    from: str(p.from) ?? '',
    direction: str(p.direction) ?? '',
    state: str(p.state),
    connection: str(p.connection_id),
    ours,
    ticket,
    who,
    start: ms(p.start_time),
    end: ms(p.end_time),
    cause: str(p.hangup_cause),
    digits: str(p.digits),
    gather: str(p.status),
    recordingId: str(p.recording_id),
    recordingStart: ms(p.recording_started_at),
    recordingEnd: ms(p.recording_ended_at),
  }
}
