// The workspace's HTTP routes for guests (docs/adr/0003). The company's people have no door here:
// they work in the space, which calls meet in-process (space-meet.ts). What is mounted, by path, at the guests' base
// (`GUEST_API`, `/w/api`, where the space's guest door answers; space-guests.ts):
//
//   /w/api/auth/*    anyone      the guest sign-in: asking for a code, entering it
//   /w/api/*         guests      meet's session cookie, whose hash the workspace holds. An assertion header on
//                                this path is not looked at.
//   /w/api/socket    guests      a socket ticket, spent once, and an Origin of this site
//
// (A teammate has no socket here: the space's live object holds the team's.)

// The handlers are `workspaceHandlers`, which take the way to find who is asking; the guests' door is the one place
// production mounts them. The core checks the Actor's kind again for what only one kind may do.

import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Deps } from './app'
import { TOKEN_SHAPE, crossSite, isLocal, newToken, sha256Hex } from './door'
import { callLink, makeKeyedCall } from './calls'
import { codeEmail, inviteEmail } from './mail'
import { CHAT_MAX } from './model'
import { RoomError } from './room'
import type { Actor } from './workspace'
import { GUEST_SESSION_MS, TICKET_TTL_MS, newCode, normalizeEmail, readCode } from './workspace-model'

/** The guest session cookie. Scoped to the guests' API path (the base they are mounted at), so a browser sends it nowhere else. */
export const GUEST_COOKIE = 'meet_guest'

export interface Door {
  actor: Actor
  /** When this sign-in ends. A guest's is the session's, which the core knows (0). */
  endsAt: number
}

/** The caller's address for the sign-in's rate limit. Behind Cloudflare it is always set; a local run has none. */
const clientIp = (c: Context): string => c.req.header('cf-connecting-ip') ?? 'local'

/** The guest cookie, set (or set again, which pushes its end out) for the session whose token this is. */
function setSessionCookie(c: Context, token: string, base: string): void {
  setCookie(c, GUEST_COOKIE, token, {
    httpOnly: true,
    // Not on a localhost run: a browser may refuse a Secure cookie on plain http there.
    secure: !isLocal(c),
    sameSite: 'Lax',
    path: base,
    maxAge: GUEST_SESSION_MS / 1000,
  })
}

const intParam = (v: string | undefined): number => (v !== undefined && /^\d{1,12}$/.test(v) ? Number(v) : Number.NaN)

async function json(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json()
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A short, plain name for a device: the browser and the system, not the whole user-agent string. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser'
  const system = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return system ? `${browser} on ${system}` : browser
}

/**
 * The handlers behind the guests' door, for whoever the `door` function says is asking. Production mounts them once, behind the guests' session
 * (below); the tests mount them behind a signed assertion as well, to drive the Workspace's rules as a teammate through a route (test/helpers.ts).
 */
export function workspaceHandlers(deps: (c: Context) => Deps, door: (c: Context) => Door): Hono {
  const shared = new Hono()
  shared.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && crossSite(c)) return c.json({ error: 'Cross-site write refused' }, 403)
    await next()
    c.header('cache-control', 'no-store')
  })
  const now = (c: Context) => deps(c).now()
  const ws = (c: Context) => deps(c).workspace()

  shared.get('/bootstrap', async (c) => {
    const { actor } = door(c)
    return c.json(await ws(c).bootstrap(actor, now(c)))
  })

  shared.post('/ticket', async (c) => {
    const d = deps(c)
    const { actor, endsAt } = door(c)
    const ticket = newToken(d.randomBytes)
    const made = await d.workspace().issueTicket(actor, await sha256Hex(ticket), endsAt, d.now())
    return c.json({ ticket, endsAt: made.endsAt, ttlMs: TICKET_TTL_MS })
  })

  shared.get('/conversations/:id/messages', async (c) => {
    const before = c.req.query('before')
    const beforeId = before === undefined ? null : intParam(before)
    if (beforeId !== null && Number.isNaN(beforeId)) throw new RoomError(400, 'bad request')
    return c.json(await ws(c).history(door(c).actor, intParam(c.req.param('id')), beforeId, now(c)))
  })

  shared.post('/conversations/:id/messages', async (c) => {
    const b = await json(c)
    // The core checks the length after cleaning; this only stops a body far past any message from being worked on.
    if (typeof b.text === 'string' && b.text.length > CHAT_MAX * 5) throw new RoomError(400, 'A message is too long.')
    return c.json(await ws(c).send(door(c).actor, intParam(c.req.param('id')), b.text, now(c)), 201)
  })

  // A huddle: anyone in the conversation starts one, a channel guest too, under the meter (the call is made like any other, calls.ts). The compose key is
  // the page's, once per press; the answer is the call's name and its link on meet's public address.
  shared.post('/conversations/:id/huddle', async (c) => {
    const d = deps(c)
    const b = await json(c)
    const actor = door(c).actor
    const made = await makeKeyedCall(d, actor, actor.via === 'access' ? actor.email : 'guest', typeof b.key === 'string' ? b.key : '', { kind: 'huddle', convId: intParam(c.req.param('id')) })
    return c.json({ name: made.call.name, link: callLink(d.appOrigin, made.call.name), repeated: made.repeated }, made.repeated ? 200 : 201)
  })

  shared.post('/conversations/:id/read', async (c) => {
    const b = await json(c)
    return c.json(await ws(c).markRead(door(c).actor, intParam(c.req.param('id')), b.upTo, now(c)))
  })

  shared.patch('/messages/:id', async (c) => {
    const b = await json(c)
    if (typeof b.text === 'string' && b.text.length > CHAT_MAX * 5) throw new RoomError(400, 'A message is too long.')
    return c.json(await ws(c).edit(door(c).actor, intParam(c.req.param('id')), b.text, now(c)))
  })

  shared.delete('/messages/:id', async (c) => c.json(await ws(c).deleteMessage(door(c).actor, intParam(c.req.param('id')), now(c))))

  shared.post('/channels', async (c) => {
    const b = await json(c)
    return c.json(await ws(c).createChannel(door(c).actor, b.name, b.privacy, now(c)), 201)
  })
  shared.patch('/channels/:id', async (c) => {
    const b = await json(c)
    return c.json(await ws(c).renameChannel(door(c).actor, intParam(c.req.param('id')), b.name, now(c)))
  })
  shared.post('/channels/:id/join', async (c) => c.json(await ws(c).joinChannel(door(c).actor, intParam(c.req.param('id')), now(c))))
  shared.post('/channels/:id/leave', async (c) => c.json(await ws(c).leaveChannel(door(c).actor, intParam(c.req.param('id')), now(c))))
  shared.post('/channels/:id/archive', async (c) => c.json(await ws(c).archiveChannel(door(c).actor, intParam(c.req.param('id')), now(c))))

  shared.post('/channels/:id/members', async (c) => {
    const b = await json(c)
    return c.json(await ws(c).addMember(door(c).actor, intParam(c.req.param('id')), b.person as string, now(c)))
  })
  shared.delete('/channels/:id/members/:person', async (c) =>
    c.json(await ws(c).removeMember(door(c).actor, intParam(c.req.param('id')), c.req.param('person'), now(c))),
  )

  // Invite a guest: the workspace decides it is allowed and counts it; the one email goes out from here. The
  // person is added either way, so an email that failed to send is told to the inviter, not silently lost.
  shared.post('/channels/:id/invite', async (c) => {
    const d = deps(c)
    const b = await json(c)
    const done = await d.workspace().invite(door(c).actor, intParam(c.req.param('id')), b.email, b.name, d.now())
    let mailed = true
    try {
      await d.mailer.send(inviteEmail(done.mail.to, done.mail.inviter, done.mail.channel, d.appOrigin, d.install))
    } catch (err) {
      mailed = false
      console.error('invitation email failed', err instanceof Error ? err.message : err)
    }
    return c.json({ person: done.person, mailed }, 201)
  })

  shared.post('/dms', async (c) => {
    const b = await json(c)
    return c.json(await ws(c).openDm(door(c).actor, b.person as string, now(c)), 201)
  })

  shared.patch('/me', async (c) => {
    const b = await json(c)
    return c.json(await ws(c).updateMe(door(c).actor, { name: b.name, nudgesOff: b.nudgesOff }, now(c)))
  })
  shared.post('/privacy-ack', async (c) => c.json(await ws(c).ackPrivacy(door(c).actor, now(c))))

  shared.post('/people/:person/remove', async (c) => c.json(await ws(c).removePerson(door(c).actor, c.req.param('person'), now(c))))
  shared.delete('/people/:person', async (c) => c.json(await ws(c).deletePerson(door(c).actor, c.req.param('person'), now(c))))

  // A guest's devices. The core refuses a teammate here: they have no guest session.
  shared.get('/sessions', async (c) => c.json(await ws(c).sessions(door(c).actor, now(c))))
  shared.delete('/sessions/:id', async (c) => c.json(await ws(c).endSession(door(c).actor, c.req.param('id'), now(c))))

  return shared
}

/**
 * The guests' live socket, at `<base>/socket`: the upgrade, the same-origin check and the one-time ticket the guest was given by their code sign-in. It is mounted in the space's Worker for the guests
 * (space-guests.ts, at `GUEST_API`) and nowhere answers a socket without a ticket. A teammate has none here: the space's live object holds theirs.
 */
export function mountSocket(app: Hono, deps: (c: Context) => Pick<Deps, 'workspace' | 'openSocket' | 'now'>, base: string): void {
  app.get(`${base}/socket`, async (c) => {
    const d = deps(c)
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: 'A socket upgrade is needed.' }, 426)
    // A browser always sends its page's Origin on a socket; anything but this site's own is refused.
    if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'Cross-site socket refused' }, 403)
    const ticket = c.req.query('ticket') ?? ''
    if (!TOKEN_SHAPE.test(ticket)) return c.json({ error: 'That ticket is not good.' }, 401)
    try {
      const spent = await d.workspace().redeemTicket(await sha256Hex(ticket), d.now())
      return await d.openSocket(spent)
    } catch (err) {
      if (err instanceof RoomError) return c.json({ error: err.message }, err.status)
      throw err
    }
  })
}

export function mountWorkspace(app: Hono, deps: (c: Context) => Deps, base: string): void {
  const doors = new WeakMap<Request, Door>()
  const door = (c: Context): Door => {
    const held = doors.get(c.req.raw)
    if (!held) throw new RoomError(401, 'You are signed out.')
    return held
  }

  // ---------------------------------------------------------------------
  // The socket. Registered before anything that touches headers: a WebSocket response is not one to rebuild.
  mountSocket(app, deps, base)

  const shared = workspaceHandlers(deps, door)

  // ---------------------------------------------------------------------
  // The guests' door. Asking for a code and entering it come first and need no session.
  const guests = new Hono()

  // Before anything else the guests' sign-in is limited per address of the caller, with Cloudflare's Rate Limiting
  // binding: a script asking for codes for made-up addresses (or guessing codes) is refused here, before it costs the
  // workspace object a request. Everything else on this door has a session, which is its own limit.
  guests.use('/auth/*', async (c, next) => {
    if (!(await deps(c).authLimit(clientIp(c)))) return c.json({ error: 'Too many tries. Wait a minute and try again.' }, 429, { 'retry-after': '60' })
    return next()
  })

  // Whose workspace this is, for the words a page says before anybody is signed in ("<company> people work in the space", "ask <owner> to add you"): the company's name and the owner's name, from the install.
  // Not the owner's address: that goes only to a signed-in person, in the bootstrap.
  guests.get('/site', (c) => {
    const install = deps(c).install
    return c.json({ company: install.company.name, owner: { name: install.owner().name } })
  })

  // The same reply for an address nobody invited, a removed guest's and a teammate's: nothing is sent to those,
  // and the page cannot tell. Only the limits answer differently, and they answer for every address alike.
  guests.post('/auth/request', async (c) => {
    if (crossSite(c)) return c.json({ error: 'Cross-site write refused' }, 403)
    const d = deps(c)
    const email = normalizeEmail((await json(c)).email)
    if (!email) throw new RoomError(400, 'That does not look like an email address.')
    const code = newCode(d.randomBytes)
    const { send } = await d.workspace().requestCode(email, await sha256Hex(`${email}:${code}`), d.now())
    if (send) {
      try {
        await d.mailer.send(codeEmail(email, code, d.install))
      } catch (err) {
        console.error('code email failed', err instanceof Error ? err.message : err)
      }
    }
    return c.json({ ok: true })
  })

  guests.post('/auth/verify', async (c) => {
    if (crossSite(c)) return c.json({ error: 'Cross-site write refused' }, 403)
    const d = deps(c)
    const b = await json(c)
    const email = normalizeEmail(b.email)
    const code = readCode(b.code)
    if (!email || !code) throw new RoomError(401, 'That code did not work. Ask for a new one.')
    const token = newToken(d.randomBytes)
    await d.workspace().verifyCode(email, await sha256Hex(`${email}:${code}`), await sha256Hex(token), deviceLabel(c.req.header('user-agent')), d.now())
    setSessionCookie(c, token, base)
    c.header('cache-control', 'no-store')
    return c.json({ ok: true })
  })

  // For the live check only: the emails this Worker has "sent" on a localhost run, so the check can read a code.
  guests.get('/dev/mail', (c) => {
    const d = deps(c)
    if (!(d.devBypass && isLocal(c) && d.devMail)) return c.json({ error: 'Not found' }, 404)
    return c.json({ mail: d.devMail })
  })

  guests.use('*', async (c, next) => {
    const token = getCookie(c, GUEST_COOKIE) ?? ''
    if (!TOKEN_SHAPE.test(token)) return c.json({ error: 'You are signed out.' }, 401)
    doors.set(c.req.raw, { actor: { via: 'session', hash: await sha256Hex(token) }, endsAt: 0 })
    await next()
    // The workspace slides a session's end 30 days out as it is used; the cookie must slide with it, or the browser
    // drops it on day 30 of a session that is still good. Set again on every answered request (not on a refusal or
    // a sign-out).
    if (c.res.status < 400 && !c.req.path.endsWith('/signout')) setSessionCookie(c, token, base)
  })
  guests.post('/signout', async (c) => {
    if (crossSite(c)) return c.json({ error: 'Cross-site write refused' }, 403)
    await deps(c).workspace().signOut(door(c).actor, deps(c).now())
    deleteCookie(c, GUEST_COOKIE, { path: base })
    return c.json({ ok: true })
  })
  guests.route('/', shared)
  app.route(base, guests)
}
