// A stand-in for the SFU for local development and the browser checks that need no
// media (scripts/chat.ts): it accepts every publish and subscribe and carries no
// sound or picture, so two tabs can join one call, see each other in the list and
// exchange chat with no Cloudflare secrets. It answers with no session description,
// which the browser takes as "nothing to apply".
//
// Used only when the dev flag FAKE_REALTIME=1 is set AND the request is for a
// localhost host (index.ts), the same two conditions as the Access bypass. A
// deployed Worker has neither.

import type { IceServer, Realtime, TrackItem, TracksResponse } from './realtime'

export function fakeRealtime(): Realtime {
  let mids = 0
  return {
    async newSession() {
      return crypto.randomUUID()
    },
    async addLocalTracks(_session, _offer, tracks): Promise<TracksResponse> {
      return { tracks: tracks.map((t): TrackItem => ({ trackName: t.trackName, mid: t.mid })) }
    },
    async addRemoteTracks(_session, tracks): Promise<TracksResponse> {
      return { tracks: tracks.map((t): TrackItem => ({ sessionId: t.sessionId, trackName: t.trackName, mid: String(++mids) })) }
    },
    async renegotiate() {},
    async closeTracks(): Promise<TracksResponse> {
      return {}
    },
    async iceServers(): Promise<IceServer[]> {
      return []
    },
  }
}
