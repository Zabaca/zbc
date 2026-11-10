// The browser side of the HTTP API. Every call operation carries the member
// token in a header; the token is made here, per tab, and the server keeps only
// its hash.

import { CALL_API, type ChatDelta, type ChatMessage, type Kind, type RoomInfo, type Snapshot } from '../model'
import type { Pub } from './call/reconcile'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, opts: { body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.token ? { 'x-member-token': opts.token } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const json = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed (${res.status}).`)
  return json as T
}

/** This tab's member token: random, kept in session storage so a refresh lands back as the same person. */
export function memberToken(room: string): string {
  const key = `meet.token.${room}`
  try {
    const held = sessionStorage.getItem(key)
    if (held) return held
  } catch {
    // Storage blocked: a fresh token per load, so a refresh is a new person for up to 30 seconds.
  }
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  try {
    sessionStorage.setItem(key, token)
  } catch {}
  return token
}

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface Joined {
  memberId: string
  generation: number
  snapshot: Snapshot
  /** The newest chat message when you joined. */
  chatLast: number
  iceServers: IceServer[]
}

export interface PausedInfo {
  paused: boolean
  pausedUntil: string | null
}

type WantBody = Array<Pick<Pub, 'memberId' | 'kind' | 'v'>>

export const api = {
  lobby: (room: string) => request<RoomInfo & PausedInfo>('GET', `${CALL_API}/rooms/${room}`),
  join: (room: string, token: string, name: string) => request<Joined>('POST', `${CALL_API}/rooms/${room}/join`, { token, body: { name } }),
  /** `since` is the newest chat message id already held: the reply carries the ones after it. */
  checkIn: (room: string, token: string, generation: number, flags: { muted: boolean; cameraOff: boolean; since: number }) =>
    request<{ snapshot: Snapshot; chat: ChatDelta }>('POST', `${CALL_API}/rooms/${room}/checkin`, { token, body: { generation, ...flags } }),
  chat: (room: string, token: string, generation: number, text: string) =>
    request<{ message: ChatMessage }>('POST', `${CALL_API}/rooms/${room}/chat`, { token, body: { generation, text } }),
  publish: (room: string, token: string, generation: number, offer: string, tracks: Array<{ kind: Kind; mid: string }>) =>
    request<{ answer: string | null; published: Kind[]; failed: Array<{ kind: Kind; error: string }> }>(
      'POST',
      `${CALL_API}/rooms/${room}/publish`,
      {
        token,
        body: { generation, offer, tracks },
      },
    ),
  unpublish: (room: string, token: string, generation: number, kinds: Kind[], offer?: string) =>
    request<{ answer: string | null }>('POST', `${CALL_API}/rooms/${room}/unpublish`, { token, body: { generation, kinds, offer } }),
  subscribe: (room: string, token: string, generation: number, wants: WantBody) =>
    request<{
      offer: string | null
      requiresImmediateRenegotiation: boolean
      tracks: Array<Pub & { mid: string }>
      failed: Array<{ memberId: string; kind: Kind; error: string }>
    }>('POST', `${CALL_API}/rooms/${room}/subscribe`, { token, body: { generation, wants } }),
  renegotiate: (room: string, token: string, generation: number, answer: string) =>
    request<{ ok: true }>('POST', `${CALL_API}/rooms/${room}/renegotiate`, { token, body: { generation, answer } }),
  unsubscribe: (room: string, token: string, generation: number, wants: WantBody) =>
    request<{ answer: string | null }>('POST', `${CALL_API}/rooms/${room}/unsubscribe`, { token, body: { generation, wants } }),
  leave: (room: string, token: string, generation: number) =>
    fetch(`${CALL_API}/rooms/${room}/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-member-token': token },
      body: JSON.stringify({ generation }),
      keepalive: true,
    }).catch(() => null),
}
