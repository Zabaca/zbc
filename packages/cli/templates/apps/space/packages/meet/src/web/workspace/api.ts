// The workspace's requests, at the guests' door: /w/api (GUEST_API), with meet's session cookie, which the browser sends by itself
// (src/workspace-routes.ts). The company's people have no page of meet's any more: they work in the space.

import { GUEST_API } from '../../model'
import type { Bootstrap, ConversationView, MeView, PersonView, WMessage } from '../../workspace-model'
import { ApiError } from '../api'
import { TicketFailure, afterTicketFailure } from './connection'

export interface Session {
  id: string
  label: string
  createdAt: number
  lastUsedAt: number
  current: boolean
}

export class WorkspaceApi {
  readonly base = GUEST_API

  /** One request. A guest whose session ended is answered with a 401, which is told apart from a network that is down. */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new ApiError(0, 'You seem to be offline.')
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed (${res.status}).`)
    return json as T
  }

  bootstrap = () => this.request<Bootstrap>('GET', '/bootstrap')

  /** A socket ticket, or a `TicketFailure` saying what the page should do instead. */
  async ticket(): Promise<string> {
    try {
      return (await this.request<{ ticket: string }>('POST', '/ticket')).ticket
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      throw new TicketFailure(afterTicketFailure(err.status === 0 ? { network: true } : { status: err.status }))
    }
  }

  history = (conv: number, before?: number) =>
    this.request<{ messages: WMessage[]; more: boolean }>('GET', `/conversations/${conv}/messages${before ? `?before=${before}` : ''}`)
  send = (conv: number, text: string) => this.request<{ message: WMessage }>('POST', `/conversations/${conv}/messages`, { text })
  edit = (id: number, text: string) => this.request<{ message: WMessage }>('PATCH', `/messages/${id}`, { text })
  remove = (id: number) => this.request<{ ok: true }>('DELETE', `/messages/${id}`)
  read = (conv: number, upTo: number) => this.request<{ ok: true }>('POST', `/conversations/${conv}/read`, { upTo })

  leave = (conv: number) => this.request<{ ok: true }>('POST', `/channels/${conv}/leave`)
  rename = (conv: number, name: string) => this.request<{ ok: true }>('PATCH', `/channels/${conv}`, { name })
  archive = (conv: number) => this.request<{ ok: true }>('POST', `/channels/${conv}/archive`)
  addMember = (conv: number, person: string) => this.request<{ ok: true }>('POST', `/channels/${conv}/members`, { person })
  removeMember = (conv: number, person: string) => this.request<{ ok: true }>('DELETE', `/channels/${conv}/members/${person}`)
  invite = (conv: number, email: string, name: string) => this.request<{ person: PersonView; mailed: boolean }>('POST', `/channels/${conv}/invite`, { email, name })
  /** Start a huddle in a conversation you are in (a guest too). The call's message arrives like any other; this answers its link. */
  huddle = (conv: number) =>
    this.request<{ name: string; link: string; repeated: boolean }>('POST', `/conversations/${conv}/huddle`, { key: crypto.randomUUID().replace(/-/g, '') })
  openDm = (person: string) => this.request<{ conversation: ConversationView }>('POST', '/dms', { person })

  updateMe = (patch: { name?: string; nudgesOff?: boolean }) => this.request<{ me: MeView }>('PATCH', '/me', patch)
  ackPrivacy = () => this.request<{ ok: true }>('POST', '/privacy-ack')
  removePerson = (person: string) => this.request<{ ok: true }>('POST', `/people/${person}/remove`)
  deletePerson = (person: string) => this.request<{ ok: true }>('DELETE', `/people/${person}`)

  sessions = () => this.request<{ sessions: Session[] }>('GET', '/sessions')
  endSession = (id: string) => this.request<{ ok: true }>('DELETE', `/sessions/${id}`)
  signOut = () => this.request<{ ok: true }>('POST', '/signout')
}

/** The guests' sign-in: no session yet, so these are not the workspace's own routes. */
export const guestAuth = {
  async request(email: string): Promise<void> {
    const res = await fetch(`${GUEST_API}/auth/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new ApiError(res.status, json.error ?? 'Could not send a code.')
  },
  async verify(email: string, code: string): Promise<void> {
    const res = await fetch(`${GUEST_API}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) })
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new ApiError(res.status, json.error ?? 'That code did not work.')
  },
}
