// The Worker as the tests drive it: the real router, a real signed-in person per call, and stand-ins behind the bindings.
import { type InboxMailbox, type Install, type MeetChannel, type MeetDirect, type MeetPerson, resetJwksCache, type SignedIn } from '@space/workspace'
import { AUD, T0, team } from '../../workspace/test/helpers'
import { type Deps, type Env, createApp } from '../src/app'
import type { ServiceIdentity } from '@space/inbox/src/app'
import type { Parts } from '../src/parts'
import type { StandInContact, StandInThread } from '../src/stand-ins'

export const NORTHFIELD_TEAM = 'northfield.cloudflareaccess.com'
export const LANE_TEAM = 'brightwater.cloudflareaccess.com'
export const PAGE = '<!doctype html><title>Space</title>'
/** The Forms application's audience: not the space's, because Access answers /forms with its own application. */
export const FORMS_AUD = 'f'.repeat(64)
/** The agent application's audience (Claude's door): not the space's and not Forms', because Access answers /agent/inbox with its own application. */
export const AGENT_AUD = 'd'.repeat(64)
/** The Telegram bridge application's audience: its own, because Access answers /agent/telegram with an application of its own. */
export const TELEGRAM_AUD = 'e'.repeat(64)
/** The Clients door's application audience: its own, because Access answers /agent/clients with an application of its own. */
export const CLIENTS_AUD = 'c'.repeat(64)
/** The client id of the token the Clients door admits (`CLIENTS_ACCESS_CLIENT_ID`), as Access names it in an assertion's `common_name`. */
export const CLIENTS_TOKEN = 'clients123.access'

interface Forwarded {
  method: string
  url: string
  assertion: string | null
  /** For forms' app, which runs in the Worker: the address of the person the one sign-in check named for the request. */
  who?: string
  cookie: string | null
  origin: string | null
  body: string
  headers?: Record<string, string>
}

/** Forms' app in the Worker, stood in for: it records what it was handed and answers as forms does (the admin page is DENY-framed). */
function forms(answer: (req: Request) => Response = () => new Response('forms says hello', { headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'cache-control': 'no-store' } })) {
  const asked: Forwarded[] = []
  return {
    asked,
    api: async (req: Request, who: SignedIn): Promise<Response> => {
      asked.push({
        method: req.method,
        url: req.url,
        assertion: req.headers.get('cf-access-jwt-assertion'),
        who: who.person.address,
        cookie: req.headers.get('cookie'),
        origin: req.headers.get('origin'),
        body: await req.text(),
      })
      return answer(req)
    },
  }
}

/** The inbox's router for Claude's door, in this Worker (`Parts.claude`), stood in for: it records what it was handed, and the token the door's check verified, and answers with a marker. */
function claude(answer: (req: Request) => Response = () => Response.json({ from: 'the inbox' })) {
  const asked: Forwarded[] = []
  return {
    asked,
    door: async (req: Request, who: ServiceIdentity): Promise<Response> => {
      asked.push({
        method: req.method,
        url: req.url,
        assertion: req.headers.get('cf-access-jwt-assertion'),
        who: who.commonName,
        cookie: req.headers.get('cookie'),
        origin: req.headers.get('origin'),
        body: await req.text(),
        headers: Object.fromEntries(req.headers),
      })
      return answer(req)
    },
  }
}

/** The inbox's router for the Telegram bridge's door (`Parts.telegram`), stood in for as Claude's is: it records what it was handed and the token the door's check verified. */
function bridge(answer: (req: Request) => Response = () => Response.json({ from: 'the inbox, for the bridge' })) {
  const asked: Forwarded[] = []
  return {
    asked,
    door: async (req: Request, who: ServiceIdentity): Promise<Response> => {
      asked.push({
        method: req.method,
        url: req.url,
        assertion: req.headers.get('cf-access-jwt-assertion'),
        who: who.commonName,
        cookie: req.headers.get('cookie'),
        origin: req.headers.get('origin'),
        body: await req.text(),
        headers: Object.fromEntries(req.headers),
      })
      return answer(req)
    },
  }
}

/** The asset router's stand-in: it answers every path with the page and counts how often it was asked. */
function assets() {
  const asked: string[] = []
  return {
    asked,
    binding: {
      fetch: async (req: Request) => {
        asked.push(new URL(req.url).pathname)
        // A script (a file of the page, pdf.js's worker) comes back as a script; everything else is the page, as the asset router's fallback gives.
        if (/\.png$/.test(new URL(req.url).pathname)) return new Response('png', { headers: { 'content-type': 'image/png' } })
        return /\.m?js$/.test(new URL(req.url).pathname) ? new Response('export {}', { headers: { 'content-type': 'text/javascript' } }) : new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      },
    } as unknown as Fetcher,
  }
}

/** The environment a test gives the Worker, and the parts that run in it (meet's, forms' reads and app, the knowledge app), as stand-ins. `meet` and `inbox` are the stand-ins for meet's and the inbox's parts. */
export type WorldEnv = Partial<Env> & { parts?: Partial<Parts>; meet?: Parts['meet']; inbox?: Parts['inbox'] }

export async function world(install: Install, teamDomain: string, worldEnv: WorldEnv = {}, formsAnswers?: (req: Request) => Response, more: Partial<Deps> = {}) {
  resetJwksCache() // each world has its own keys under the same team name
  const access = await team(teamDomain)
  const a = assets()
  const f = forms(formsAnswers)
  const c = claude()
  const b = bridge()
  const { parts, meet, inbox, ...env } = worldEnv
  // The Forms stand-in is there unless a test says there is none (`parts: { formsApi: undefined }`).
  const held: Parts = { formsApi: f.api, claude: c.door, telegram: b.door, ...(meet ? { meet } : {}), ...(inbox ? { inbox } : {}), ...parts }
  const app = createApp({ fetch: access.fetch as never, now: () => T0, install, parts: () => held, ...more })
  const call = (path: string, init: RequestInit & { jwt?: string; cookieJwt?: string; host?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.jwt) headers.set('cf-access-jwt-assertion', init.jwt)
    if (init.cookieJwt) headers.set('cookie', `CF_Authorization=${init.cookieJwt}`)
    const url = `https://${init.host ?? install.declaration.space.host}${path}`
    return app.fetch(new Request(url, { ...init, headers, redirect: 'manual' }), { ASSETS: a.binding, CF_ACCESS_AUD: AUD, CF_ACCESS_AUD_FORMS: FORMS_AUD, CF_ACCESS_AUD_AGENT: AGENT_AUD, CF_ACCESS_AUD_TELEGRAM: TELEGRAM_AUD, CF_ACCESS_AUD_CLIENTS: CLIENTS_AUD, CLIENTS_ACCESS_CLIENT_ID: CLIENTS_TOKEN, ...env })
  }
  /** An assertion for the space's application (every path but /forms), and for the Forms application (the Forms tab). */
  const signIn = (email: string) => access.sign({ email })
  const signInForms = (email: string) => access.sign({ email, aud: [FORMS_AUD] })
  /** An assertion for the agent application (Claude's door): a service token's, as Access mints it for the token, unless the test names other claims. */
  const signInAgent = (claims: Record<string, unknown> = { common_name: 'abc123.access' }, aud: string = AGENT_AUD) => access.sign({ ...claims, aud: [aud] })
  /** An assertion for the Telegram bridge's application: a service token's, as Access mints it for the bridge's token, unless the test names other claims. */
  const signInBridge = (claims: Record<string, unknown> = { common_name: 'bridge123.access' }, aud: string = TELEGRAM_AUD) => access.sign({ ...claims, aud: [aud] })
  /** An assertion for the Clients door's application: a service token's, as Access mints it for the door's token, unless the test names other claims. */
  const signInClients = (claims: Record<string, unknown> = { common_name: CLIENTS_TOKEN }, aud: string = CLIENTS_AUD) => access.sign({ ...claims, aud: [aud] })
  return { access, asked: a.asked, forwarded: f.asked, handedToClaude: c.asked, handedToBridge: b.asked, call, signIn, signInForms, signInAgent, signInBridge, signInClients }
}


// ── Literal stand-in data ─────────────────────────────────────────────────────────────────────────────────────────────────
export const MIN = 60_000
export const ago = (minutes: number) => T0 - minutes * MIN
export const RIDGEWAY: InboxMailbox = { id: 'ridgeway', name: 'Ridgeway Cycles', address: 'info@ridgewaycycles.example' }

export const contact = (id: string, name: string, ...addresses: string[]): StandInContact => ({ id, name, addresses })
export const thread = (id: string, at: number, on: string[], extra: Partial<StandInThread> = {}): StandInThread => ({
  id,
  subject: `Subject of ${id}`,
  at,
  snippet: `Words of ${id}`,
  on,
  ...extra,
})
export const person = (id: string, name: string, address: string | null, kind: MeetPerson['kind'] = 'guest'): MeetPerson => ({ id, name, kind, address })
export const dm = (conversationId: number, who: MeetPerson, at: number | null, unread = 0, text = 'Hello there'): MeetDirect => ({
  conversationId,
  person: who,
  newest: at === null ? null : { messageId: conversationId * 10, at, text, authorId: who.id, authorName: who.name, mine: false },
  unread,
})
export const channel = (conversationId: number, name: string, at: number | null, unread = 0): MeetChannel => ({
  conversationId,
  name,
  privacy: 'open',
  memberCount: 4,
  newest: at === null ? null : { messageId: conversationId * 10, at, text: `Latest in ${name}`, authorId: 'p-x', authorName: 'Priya', mine: false },
  unread,
})

