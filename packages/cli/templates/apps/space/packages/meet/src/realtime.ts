// A small typed client for Cloudflare's Realtime SFU (sessions and tracks) and
// its TURN credential call. The router receives it as a dependency; the tests
// hand in a fake that records what it was asked.
//
// Endpoints (developers.cloudflare.com/realtime/sfu/https-api):
//   POST /apps/{app}/sessions/new
//   POST /apps/{app}/sessions/{session}/tracks/new     publish (local) or subscribe (remote)
//   PUT  /apps/{app}/sessions/{session}/renegotiate    the browser's answer to the SFU's offer
//   PUT  /apps/{app}/sessions/{session}/tracks/close
//   POST /turn/keys/{key}/credentials/generate-ice-servers
//
// A response can mix successes and failures: the HTTP status says the request
// was understood, and each track item carries its own errorCode.

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface SessionDescription {
  type: 'offer' | 'answer'
  sdp: string
}

export interface TrackItem {
  mid?: string | null
  trackName: string
  sessionId?: string
  errorCode?: string
  errorDescription?: string
}

export interface TracksResponse {
  sessionDescription?: SessionDescription
  tracks?: TrackItem[]
  requiresImmediateRenegotiation?: boolean
}

export interface Realtime {
  newSession(): Promise<string>
  /** Publish: the browser's whole current offer, plus the names and mids of the new local tracks. */
  addLocalTracks(sessionId: string, offerSdp: string, tracks: Array<{ trackName: string; mid: string }>): Promise<TracksResponse>
  /** Subscribe: pull other sessions' tracks into this one. */
  addRemoteTracks(sessionId: string, tracks: Array<{ sessionId: string; trackName: string }>): Promise<TracksResponse>
  renegotiate(sessionId: string, answerSdp: string): Promise<void>
  /** Close tracks by mid. With an offer the SFU answers it; with `force` it closes with no renegotiation. */
  closeTracks(sessionId: string, mids: string[], opts?: { offerSdp?: string; force?: boolean }): Promise<TracksResponse>
  /** Relay credentials that last `ttlSeconds`, STUN included. */
  iceServers(ttlSeconds: number): Promise<IceServer[]>
}

export class RealtimeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface RealtimeConfig {
  appId: string
  appSecret: string
  turnKeyId: string
  turnToken: string
  fetch?: typeof fetch
  /** How long one request to Cloudflare may take, reading its body included. A hung SFU must not stall a check-in. */
  timeoutMs?: number
}

export const SFU_TIMEOUT_MS = 10_000

const API = 'https://rtc.live.cloudflare.com/v1'

/** Browsers block port 53, so an address on it only delays the connection. */
export function withoutPort53(servers: IceServer[]): IceServer[] {
  return servers.map((s) => ({ ...s, urls: s.urls.filter((u) => !/:53(\?|$)/.test(u)) })).filter((s) => s.urls.length > 0)
}

export function cloudflareRealtime(cfg: RealtimeConfig): Realtime {
  const doFetch = cfg.fetch ?? fetch
  async function call<T>(url: string, token: string, method: string, body?: unknown): Promise<T> {
    const signal = AbortSignal.timeout(cfg.timeoutMs ?? SFU_TIMEOUT_MS)
    let res: Response
    let text: string
    try {
      res = await doFetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
      text = await res.text()
    } catch (err) {
      if (signal.aborted) throw new RealtimeError(504, 'Cloudflare did not answer in time')
      throw err
    }
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      // A non-JSON body is reported below with its status.
    }
    if (!res.ok) {
      const detail = (json as { errorDescription?: string } | null)?.errorDescription ?? text.slice(0, 200)
      throw new RealtimeError(res.status, `Cloudflare answered ${res.status}: ${detail}`)
    }
    return json as T
  }
  const sfu = (path: string, method: string, body?: unknown) =>
    call<TracksResponse>(`${API}/apps/${cfg.appId}${path}`, cfg.appSecret, method, body)
  return {
    async newSession() {
      const r = await call<{ sessionId?: string }>(`${API}/apps/${cfg.appId}/sessions/new`, cfg.appSecret, 'POST')
      if (!r?.sessionId) throw new RealtimeError(502, 'Cloudflare returned no session')
      return r.sessionId
    },
    addLocalTracks: (sessionId, offerSdp, tracks) =>
      sfu(`/sessions/${sessionId}/tracks/new`, 'POST', {
        sessionDescription: { type: 'offer', sdp: offerSdp },
        tracks: tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName })),
      }),
    addRemoteTracks: (sessionId, tracks) =>
      sfu(`/sessions/${sessionId}/tracks/new`, 'POST', {
        tracks: tracks.map((t) => ({ location: 'remote', sessionId: t.sessionId, trackName: t.trackName })),
      }),
    async renegotiate(sessionId, answerSdp) {
      await sfu(`/sessions/${sessionId}/renegotiate`, 'PUT', { sessionDescription: { type: 'answer', sdp: answerSdp } })
    },
    closeTracks: (sessionId, mids, opts = {}) =>
      sfu(`/sessions/${sessionId}/tracks/close`, 'PUT', {
        tracks: mids.map((mid) => ({ mid })),
        force: opts.force ?? false,
        ...(opts.offerSdp ? { sessionDescription: { type: 'offer', sdp: opts.offerSdp } } : {}),
      }),
    async iceServers(ttlSeconds) {
      const r = await call<{ iceServers?: IceServer[] }>(
        `${API}/turn/keys/${cfg.turnKeyId}/credentials/generate-ice-servers`,
        cfg.turnToken,
        'POST',
        { ttl: ttlSeconds },
      )
      if (!Array.isArray(r?.iceServers)) throw new RealtimeError(502, 'Cloudflare returned no relay credentials')
      return withoutPort53(r.iceServers)
    },
  }
}
