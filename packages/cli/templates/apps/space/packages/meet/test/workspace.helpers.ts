// What the workspace tests share: a way to act as a teammate (a signed Access assertion on the test-only teammates' door), as
// a guest (the session cookie on the guests' door), to invite and sign in a guest by reading the code out of the
// fake mailer, and to look at what the fake adapter was told.

import { expect } from 'bun:test'
import { type Harness, T0, TEAMMATE_DOOR } from './helpers'

export const W = TEAMMATE_DOOR
export const G = '/w/api'
export const HOUR = 3_600_000
export const DAY = 24 * HOUR

type Call = { status: number; json: any; headers: Headers }

export interface Actors {
  /** A teammate's request: a freshly signed assertion for `email`, good for an hour from the harness's clock. */
  tm(email: string, method: string, path: string, body?: unknown, extra?: { headers?: Record<string, string>; origin?: string }): Promise<Call>
  /** A guest's request on the guests' door, carrying the session token as its cookie. */
  gu(token: string, method: string, path: string, body?: unknown, extra?: { headers?: Record<string, string>; origin?: string }): Promise<Call>
  assertion(email: string, exp?: number): Promise<string>
  /** Ask for a code, read it from the email, enter it: the token the cookie carries. */
  signIn(email: string): Promise<string>
  /** The newest email to this address. */
  mailTo(email: string): { subject: string; text: string } | undefined
}

export function actors(h: Harness & { access: { sign: (claims: Record<string, unknown>, opts?: { exp?: number }) => Promise<string> } }): Actors {
  // A browser keeps the cookie until its Max-Age runs out, counted from the last time a response set it, and then stops
  // sending it. Each token's cookie is held here the same way, so a test cannot lean on a session the browser lost.
  const cookieEnds = new Map<string, number>()
  const learn = (token: string, res: { headers: Headers }) => {
    const set = res.headers.get('set-cookie') ?? ''
    const age = /Max-Age=(\d+)/i.exec(set)?.[1]
    if (set.startsWith('meet_guest=') && age !== undefined) cookieEnds.set(token, h.clock.now + Number(age) * 1000)
  }
  const assertion = (email: string, exp = Math.floor((h.clock.now + HOUR) / 1000)) => h.access.sign({ email }, { exp })
  const mailTo = (email: string) => [...h.mail].reverse().find((m) => m.to === email)
  return {
    assertion,
    mailTo,
    async tm(email, method, path, body, extra = {}) {
      return h.callTeammate(method, `${W}${path}`, body, {
        headers: { 'cf-access-jwt-assertion': await assertion(email), ...(extra.headers ?? {}) },
        ...(extra.origin ? { origin: extra.origin } : {}),
      })
    },
    async gu(token, method, path, body, extra = {}) {
      const held = (cookieEnds.get(token) ?? Number.POSITIVE_INFINITY) > h.clock.now
      const res = await h.call(method, `${G}${path}`, body, {
        headers: { ...(held ? { cookie: `meet_guest=${token}` } : {}), ...(extra.headers ?? {}) },
        ...(extra.origin ? { origin: extra.origin } : {}),
      })
      if (held) learn(token, res)
      return res
    },
    async signIn(email) {
      const before = h.mail.length
      const asked = await h.call('POST', `${G}/auth/request`, { email })
      expect(asked.status).toBe(200)
      expect(h.mail.length).toBe(before + 1)
      const code = /sign-in code: (\d{6})/.exec(h.mail[before]?.subject ?? '')?.[1]
      expect(code).toMatch(/^\d{6}$/)
      const r = await h.call('POST', `${G}/auth/verify`, { email, code })
      expect(r.status).toBe(200)
      const token = /meet_guest=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1]
      expect(token).toBeTruthy()
      learn(token as string, r)
      return token as string
    },
  }
}

export { T0 }
