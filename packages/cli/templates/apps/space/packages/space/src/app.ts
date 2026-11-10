// The front door's Worker. Importable without the Workers runtime, so `bun test` drives real requests through the real
// router (test/app.test.ts).
//
// ONE RULE FIRST: nothing on this host is public but three prefixes (/r/, /w/, /s/: the guests' and signers' door, src/guests.ts, answered before everything here), and nothing else is answered before the sign-in is checked. The check runs
// on EVERY request, the pages and files as well as the API (the Worker's settings sends them all through this Worker first), and
// it reads the Access header only, never the CF_Authorization cookie (the company layer's identify). Access is an edge
// control and a cookie once got a request past it, so the edge's word is not taken for it.
//
// What it answers: /api/me (who is asking, the six tabs, where the apps are), a redirect from / to the tab the space
// opens on, and the page for everything else, which the browser's router turns into a tab. Today, Inbox, Meet and People
// are drawn by the page from the inbox behind this Worker and meet and forms in it (Today is /api/today, today.ts; People is still empty). A conversation (conversation.ts) is read
// from a row's key and answered by five POSTs, the only writes here besides forms' operator API.
// Call guests, channel guests and signers come here, on three prefixes that need NO sign-in (/r/, /w/, /s/: src/guests.ts, the space's ADR 0018), answered FIRST and never by the person check. Nothing else of
// the host is public.
//
// The Forms tab (/forms) is the one place that is more than the page: the Forms application is its own Access application on
// that path, a day long, so a request on it is checked against THAT application's audience (every other path against the
// space's), and forms' operator API and its clients' logos are answered by forms' own app IN THIS WORKER (parts.ts, forms.ts), which is handed
// the operator the one check named and verifies nothing. The tab's screens are this page's own. It is also where forms' operator API writes are accepted, besides a conversation's five.
//
// ONE SIGN-IN CHECK PER REQUEST (packages/workspace/docs/adr/0003). `whoIsAsking` below is it. Forms, the knowledge app, meet and the inbox, which run in this Worker, are
// handed the person it named. Claude's door (agent.ts) is the one other check, and it too is made once: the token it verifies is handed to the inbox's router in-process.

import { type Context, Hono } from 'hono'
import { GMAIL_RETURN_PATH, GMAIL_START_PATH, HOME_TAB, type Http, identify, type InboxFile, type Install, LIVE_NAME, LIVE_SOCKET_PATH, parseByteRange, refusalStatus, type SignedIn, signedIn, type WaitUntil } from '@space/workspace'
import { MEET_READS, bookMeeting, callChat, cards, deleteChat, isMeetWrite, meetName, parseAfter, parseCall, parseCards, parseHuddle, parseMeeting, parseName, pastCalls, phone, phoneRead, startCall, startHuddle, usage } from './calls'
import { acknowledgePrivacy, deleteMessage, editMessage, isChatWrite, me as chatMe, parseDelete, parseEdit, parseMeUpdate, people as chatPeople, unread as chatUnread, updateMe } from './chat'
import { browse as browseChannels, changeChannel, channelOf, createChannel, inviteGuest, isChannelWrite, parseChange, parseChannelQuery, parseCreate, parseInvite } from './channels'
import { isPhonePath, phoneAnswer, phoneRequest } from './phone'
import { closeConversations, earlier, markRead, openConversation, parseChat, parseClose, parseEarlier, parseEmail, parseRead, parseReopen, postChat, reopenConversations, sendEmail, signingFrom } from './conversation'
import { openDraft } from './drafts'
import { parseScope, parseView } from './conversations'
import { isLegacyPath, legacyTarget } from './legacy'
import { isCount, isRecord } from './guards'
import { type Apps, type Asking, conversations, SEARCH_MAX, search } from './list'
import { people, person } from './people'
import { recoverScriptHash } from './recover'
import { today } from './today'
import { FORM_MAX, fileResponse, openFile, parseFileQuery, readFiles } from './files'
import { agentAnswer, type AgentEnv } from './agent'
import { telegramAnswer, type TelegramEnv } from './telegram'
import { clientsAnswer, type ClientsDoorEnv } from './clients-door'
import { clientsBookmark, clientsCounts, clientsRestart } from './clients'
import { archiveClientView, editClientView, makeClientView, readClientScreen, readClientsScreen } from './clients-settings'
import { returnGmail, startGmail } from './gmail'
import { formsAnswer, formsPathFor, formsUnavailable, forwardRequest } from './forms'
import { createGuestParts, createParts, type Parts, type PartsEnv, type PartsFor } from './parts'
import { type GuestPartsFor, guestAnswer } from './guests'
import { readAccounts, readAgenda, readEvent, setShown, syncNow } from './calendar'
import { changeKnowledge, readKnowledge, restartStore, restoreStore, storeBookmark } from './knowledge'
import { inboxBookmark, inboxCounts, inboxRestart } from './inbox-store'
import { meetBookmark, meetCounts, meetRestart, meetRestore } from './meet-store'
import { READ_NAMES, type ReadName, WRITE_NAMES, type WriteName, putDraftPictureView, readView, writeView } from './views'
import type { Me } from './me'
import { hasPartOf } from './switches'
import { bundledInstall } from './workspace'

export interface Env extends AgentEnv, TelegramEnv, ClientsDoorEnv, PartsEnv {
  ASSETS: Fetcher
  /** This application's audience tag, deployed by the zbc instance. Unset refuses everyone. */
  CF_ACCESS_AUD?: string
  /** The Forms application's audience tag, for a request on the Forms tab's path (space-forms-access.ts). Unset refuses everyone there. */
  CF_ACCESS_AUD_FORMS?: string
  /** Only in `vite dev`, from .dev.vars, and only honoured with ALLOW_UNAUTHENTICATED on localhost: invented people in place of the inbox and meet. */
  SPACE_FIXTURES?: string
  /** Local dev only, with the fixtures: a forms running beside the preview, whose operator API answers `documentsIn` (stand-ins.ts, `withFormsAt`) so a browser test sees a document it sent. Never set on a deployed address. */
  SPACE_FORMS_URL?: string
}

export interface Deps {
  fetch: Http
  now(): number
  install: Install
  /** How long a read of the inbox or meet may take before the list shows the other part and says so. Tests shorten it; production is `ANSWER_WITHIN_MS`. */
  answerWithinMs?: number
  /** How long a write (a send, a post) is awaited before the page is told the outcome is unknown. Tests shorten it; production is `WRITE_WITHIN_MS`. */
  writeWithinMs?: number
  /** The parts that run in this Worker, made from its environment (parts.ts). Tests give stand-ins; omitted, the real ones. */
  parts?: PartsFor
  /** The guests' and signers' side, made from its environment (parts.ts `createGuestParts`). Tests give stand-ins; omitted, the real ones. */
  guests?: GuestPartsFor
}

interface Who {
  address: string
  name: string
}

type App = { Bindings: Env; Variables: { who: Who; signedIn: SignedIn; deps: Deps } }

/** What every answer that holds a person's mail or identity carries: the browser keeps none of it. */
const NO_STORE = { 'cache-control': 'private, no-store' }

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A request on localhost with the dev switch on (`vite dev`, from .dev.vars). Never true on a deployed address. */
const onLocalDev = (req: Request, env: Env): boolean => env.ALLOW_UNAUTHENTICATED === '1' && LOCAL_HOSTS.has(new URL(req.url).hostname)

/** The path of the Forms tab, `/forms`, where forms' own Access application (a day long) answers instead of the space's. */
const formsDoor = (install: Install): string => install.tabPath('forms')

/** The audience a request must have been signed in for: the Forms application's on the Forms path, the space's everywhere else. */
function audienceFor(req: Request, env: Env, install: Install): string {
  const door = formsDoor(install)
  // Access matches a path without regard to case, so /FORMS is the Forms application's too; this is as wide as it is (ADR 0002).
  const path = new URL(req.url).pathname.toLowerCase()
  const onForms = path === door.toLowerCase() || path.startsWith(`${door.toLowerCase()}/`)
  return (onForms ? env.CF_ACCESS_AUD_FORMS : env.CF_ACCESS_AUD) ?? ''
}

/**
 * The person asking, by the company layer's sign-in check: a verified Access assertion for the audience of the application
 * that answered this path (audienceFor), then a person of this install. No assertion or an invalid one is a 401; a verified one that is not a person here (another
 * company's, a service token, an assertion naming both) is a 403. No service token passes this check; Claude's has one other path, answered before it (agent.ts).
 */
async function whoIsAsking(req: Request, env: Env, deps: Deps): Promise<{ who: Who; signedIn: SignedIn } | { status: 401 | 403 }> {
  const out = await identify(deps.install, req.headers, { fetch: deps.fetch, aud: audienceFor(req, env, deps.install), now: deps.now() })
  if (out.ok) {
    if (out.identity.kind !== 'person') return { status: 403 }
    const { person, exp } = out.identity
    return { who: { address: person.address, name: person.name }, signedIn: signedIn(person, exp) }
  }
  // `vite dev` on localhost with the dev switch: no sign-in. The fixtures stand in for the parts, and a part that is real is handed a person of no install, which it refuses.
  // Never on a deployed address.
  if (out.refusal === 'no-assertion' && onLocalDev(req, env)) {
    // `SPACE_FIXTURES=two-people` lets a test be one of a made-up team's people by header (`x-dev-person: bea`): the fixture inbox shows each only the mailboxes they are on.
    const named = env.SPACE_FIXTURES === 'two-people' ? /^[a-z]{2,12}$/.exec(req.headers.get('x-dev-person') ?? '')?.[0] : undefined
    const address = named ? `${named}@dev` : 'local@dev'
    // The calendar-mail fixture is the owner's view: a card is joined to the Calendar tab for the owner alone (conversation.ts `joinCalendar`), so there the stand-in person is the owner.
    const dev = { address, name: named ?? 'Local dev', signIn: address, role: env.SPACE_FIXTURES === 'calendar-mail' ? ('owner' as const) : ('member' as const), sharedAddresses: [] }
    return { who: { address: dev.address, name: dev.name }, signedIn: signedIn(dev, Math.floor(deps.now() / 1000) + 3600) }
  }
  console.warn(`access refused: ${out.detail}`)
  return { status: refusalStatus(out.refusal) }
}

/** What the page is told about the person asking and the place it is in. */
export function meOf(who: Who, install: Install): Me {
  return {
    address: who.address,
    name: who.name,
    company: { name: install.company.name, timeZone: install.company.timeZone },
    owner: { name: install.owner().name, address: install.owner().address },
    // Every switch and whether it is on: the page draws only what the install has (no call button, no phone, no Gmail connection where those are off).
    switches: install.switches(),
    tabs: install.tabs().map(({ id, label, path, ownSignIn }) => ({ id, label, path, ...(ownSignIn ? { ownSignIn: true as const } : {}) })),
    home: HOME_TAB,
    // Call links are made on the space's own address (a call link is space.northfield.example/r/<name>, a path that needs no sign-in), so the page makes and recognises them on it (client/day.ts, ChatMessage.tsx).
    origin: install.url(),
    // The senders and the signing service's names are the install's (its declaration's `senders` and `formsService`): the screens that say them read them here, never a literal.
    senders: { forms: install.sender('forms'), meet: install.sender('meet') },
    forms: { service: install.formsService().name, sender: install.sender('forms'), runBy: install.formsService().runBy.name, ...(install.formsService().ownCompanyOnly ? { ownCompanyOnly: true as const } : {}) },
  }
}

/**
 * The apps as this request reaches them: the parts in this Worker (the inbox's, meet's, forms', the knowledge app's), or, on localhost with the dev switch on and
 * SPACE_FIXTURES=1, stand-ins with invented people (stand-ins.ts) so the list can be seen without either app.
 */
async function appsFor(req: Request, env: Env, deps: Deps, partsFor: PartsFor): Promise<Apps> {
  const mode = env.SPACE_FIXTURES
  if (onLocalDev(req, env) && (mode === '1' || mode === 'mail-down' || mode === 'chat-refused' || mode === 'forms-down' || mode === 'knowledge-down' || mode === 'phone-on' || mode === 'telegram-late' || mode === 'telegram-signed-out' || mode === 'jmap-refused' || mode === 'jmap-down' || mode === 'calendar-lapsed' || mode === 'calendar-down' || mode === 'calendar-empty' || mode === 'telegram-pictures' || mode === 'two-people' || mode === 'calendar-mail')) {
    // One set of invented people for as long as the dev server runs, so a message sent in a photograph stays in the history that follows it.
    if (fixtures?.mode !== mode) {
      const { fixtureApps } = await import('./stand-ins')
      fixtures = { mode, apps: fixtureApps(deps.now(), mode, env.SPACE_FORMS_URL ? { formsAt: env.SPACE_FORMS_URL } : {}) }
    }
    return fixtures.apps
  }
  const { forms, formsNames, knowledge, meet, inbox, calendar, clients } = partsFor(env)
  return { inbox, meet, forms, formsNames, knowledge, calendar, clients }
}

/** Keeps the Worker request alive until a message to the live object is out (`ctx.waitUntil`); undefined where the request has no execution context (a test). */
const waitOf = (c: Context): WaitUntil | undefined => {
  try {
    const ctx = c.executionCtx
    return (promise) => ctx.waitUntil(promise)
  } catch {
    return undefined
  }
}

/** The dev fixtures, made on first use (see `appsFor`). Never made on a deployed address. */
let fixtures: { mode: string; apps: Apps } | undefined

/** The knowledge store's operator paths: bookmark, restart, restore (knowledge.ts). Their order is the routes'. */
const KNOWLEDGE_STORE_PATHS = ['/api/knowledge/store/bookmark', '/api/knowledge/store/restart', '/api/knowledge/store/restore'] as const

/** The operator's paths for meet's stores (meet-store.ts): bookmark, restart, restore and counts. Their order is the routes'. */
const MEET_STORE_PATHS = ['/api/meet/store/bookmark', '/api/meet/store/restart', '/api/meet/store/restore', '/api/meet/store/counts'] as const

/** The operator's three for the inbox's store (inbox-store.ts): bookmark, restart and counts. Their order is the routes'. */
const INBOX_STORE_PATHS = ['/api/inbox/store/bookmark', '/api/inbox/store/restart', '/api/inbox/store/counts'] as const

/** The calendar's two writes (calendar.ts): show or hide a calendar, and Check now. Their order is the routes'. */
const CALENDAR_WRITE_PATHS = ['/api/calendar/shown', '/api/calendar/sync'] as const

/** The operator's three for the Clients store (clients.ts): bookmark, restart and counts. Their order is the routes'. */
const CLIENTS_STORE_PATHS = ['/api/clients/store/bookmark', '/api/clients/store/restart', '/api/clients/store/counts'] as const

/** The Clients part's four writes, made in Settings and from People (clients-settings.ts): New, Edit, Archive and Put back. Their order is the routes'. */
const CLIENTS_WRITE_PATHS = ['/api/clients/make', '/api/clients/edit', '/api/clients/archive', '/api/clients/put-back'] as const

/** The writes the page makes on a conversation, and (with the inbox's views below) the only paths a POST is accepted on. */
const WRITE_PATHS = new Set(['/api/email', '/api/email/files', '/api/draft-picture', '/api/chat', '/api/read', '/api/close', '/api/reopen', '/api/knowledge', ...CALENDAR_WRITE_PATHS, ...KNOWLEDGE_STORE_PATHS, ...CLIENTS_STORE_PATHS, ...CLIENTS_WRITE_PATHS, ...MEET_STORE_PATHS, ...INBOX_STORE_PATHS])

/** The inbox's other views: `/api/inbox/<name>`, a read by GET and a write by POST, each name a short list (views.ts). */
const VIEW_PATH = /^\/api\/inbox\/([a-z-]+)$/
const viewName = (pathname: string): string | null => VIEW_PATH.exec(pathname)?.[1] ?? null
const isWritePath = (pathname: string): boolean => WRITE_PATHS.has(pathname) || WRITE_NAMES.includes(viewName(pathname) as WriteName) || isMeetWrite(pathname) || isChannelWrite(pathname) || isChatWrite(pathname)

/** The methods the phone's requests use (the dial pad's: its settings are a PUT, a deleted voicemail a DELETE), on `/api/phone` and under it alone. */
const PHONE_METHODS = new Set(['POST', 'PUT', 'DELETE'])

/** The longest body a write is read from: a long email, nowhere near a file. */
const BODY_MAX = 400_000

export function createApp(deps: Deps = { fetch: (u, i) => fetch(u, i), now: Date.now, install: bundledInstall }) {
  const app = new Hono<App>()
  const partsFor: PartsFor = deps.parts ?? createParts(deps)
  const guestsFor: GuestPartsFor = deps.guests ?? (createGuestParts(deps) as GuestPartsFor)

  // The guests' and signers' paths (src/guests.ts): answered before everything below, and never by it. A request under /r/, /w/ or /s/ is a guest's whatever it carries, a team assertion included (it is not read there), and
  // a request that is not under one goes on to the checks as ever.
  app.use('*', async (c, next) => {
    const answer = await guestAnswer(c.req.raw, c.env, guestsFor(c.env as never), waitOf(c), deps.install)
    return answer ?? next()
  })

  // Claude's door (agent.ts): one path, answered BEFORE the person check because it is behind an Access application of its own, whose assertion is for a different
  // audience and is a service token's. Anything not on that path goes on to the check below as ever, which still admits people only.
  app.use('*', async (c, next) => {
    const answer = await agentAnswer(c.req.raw, c.env, deps, partsFor(c.env).claude)
    return answer ?? next()
  })

  // The Telegram bridge's door (telegram.ts): a second path, the same way, with an Access application and an audience of its own and a token of its own.
  app.use('*', async (c, next) => {
    const answer = await telegramAnswer(c.req.raw, c.env, deps, partsFor(c.env).telegram)
    return answer ?? next()
  })

  // The Clients door (clients-door.ts): a third path, the same way, with an Access application, an audience and a token of its own. A source of Clients pushes through it; the space asks no one.
  app.use('*', async (c, next) => {
    const answer = await clientsAnswer(c.req.raw, c.env, deps, partsFor(c.env).clientsDoor)
    return answer ?? next()
  })

  app.use('*', async (c, next) => {
    const r = await whoIsAsking(c.req.raw, c.env, deps)
    if ('status' in r) return c.json({ error: r.status === 401 ? 'Unauthorized' : 'Forbidden' }, r.status)
    c.set('who', r.who)
    c.set('signedIn', r.signedIn)
    c.set('deps', deps)
    await next()
  })

  // A part whose switch is off is not there: its paths answer as a path that is not (switches.ts), before the part is asked. Calls, the phone, and Gmail's connection and the calendar (a Google account's) are the paths
  // with a switch; each part also reads its own (meet, the inbox), so this is the Worker's front of the same rule and not the only one.
  app.use('*', async (c, next) => (hasPartOf(new URL(c.req.url).pathname, deps.install) ? next() : c.json({ error: 'Not found' }, 404, NO_STORE)))

  // Forms' operator API and its logos, answered by forms' own app in this Worker, handed the person the check above named (forms.ts, parts.ts). Every method: forms' operator API writes.
  app.all('/forms/*', async (c, next) => {
    const formsPath = formsPathFor(new URL(c.req.url).pathname)
    if (!formsPath) return next()
    const api = partsFor(c.env).formsApi
    if (!api) return formsUnavailable()
    return formsAnswer(await api(forwardRequest(c.req.raw, formsPath), c.get('signedIn'), waitOf(c)), formsPath)
  })

  // Nothing else here writes. A method that is not a read is refused, rather than handed to a router that might answer it; the five writes of
  // a conversation (a reply by email, a post in chat, a mark read, a close, a reopen) are POSTs on their own paths and nothing else.
  app.use('*', async (c, next) => {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD') return next()
    const { pathname } = new URL(c.req.url)
    if (method === 'POST' && isWritePath(pathname)) return next()
    if (PHONE_METHODS.has(method) && isPhonePath(pathname)) return next()
    return c.json({ error: 'Method not allowed' }, 405, { allow: isPhonePath(pathname) ? 'GET, HEAD, POST, PUT, DELETE' : isWritePath(pathname) ? 'POST' : 'GET, HEAD' })
  })

  // A write is a request the page made itself. The Access cookie rides along on any request a browser makes to this host, even one a page
  // elsewhere makes, and the edge then adds the header this Worker trusts; so a write must also come from this host (the Origin a browser
  // always sends on a POST) and in a form (JSON) that a form on another site cannot send without the browser asking this host first.
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next()
    if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'Cross-site request refused' }, 403)
    // The one write that is not JSON: a reply with files (`/api/email/files`), a form. A form is a request another site can make without asking this host first, so it
    // also needs a header only the page sets (which a browser sends cross-site only after asking, and this host answers no such question) on top of the Origin above.
    if (['/api/email/files', '/api/draft-picture'].includes(new URL(c.req.url).pathname)) {
      if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/form-data') || c.req.header('x-space-write') !== '1') return c.json({ error: 'Send the form' }, 415)
      if (Number(c.req.header('content-length') ?? 0) > FORM_MAX) return c.json({ error: 'Too large' }, 413)
      return next()
    }
    // A body is JSON; a DELETE has none.
    if (c.req.method !== 'DELETE' && !(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return c.json({ error: 'Send JSON' }, 415)
    if (Number(c.req.header('content-length') ?? 0) > BODY_MAX) return c.json({ error: 'Too large' }, 413)
    return next()
  })

  // ── The Inbox's and Meet's lists (conversations.ts, list.ts): the inbox's mail or meet's chat, by `scope`. Reads only. ──────────────────────────────
  // Every part is in this Worker and is handed the person the check above named (ADR 0003), and applies its own rules: the inbox admits the owner alone, meet its teammates, forms its operators.
  const asking = async (c: Context<App>): Promise<Asking> => {
    const person = deps.install.person(c.get('who').address)
    return {
      apps: await appsFor(c.req.raw, c.env, deps, partsFor),
      install: deps.install,
      signedIn: c.get('signedIn'),
      self: person ? [person.address, person.signIn] : [c.get('who').address],
      now: deps.now,
      ...(deps.answerWithinMs !== undefined && { answerWithinMs: deps.answerWithinMs }),
      ...(deps.writeWithinMs !== undefined && { writeWithinMs: deps.writeWithinMs }),
    }
  }

  /**
   * The JSON of a write's body, read with a cap whatever the request says about its length: a chunked body has no Content-Length to refuse early, and one
   * that lies about it must not be read to the end. `value` is undefined for a body that is not JSON, which the parsers then refuse.
   */
  const bodyOf = async (c: Context<App>): Promise<{ ok: true; value: unknown } | { ok: false; status: 413 }> => {
    const body = c.req.raw.body
    const chunks: Uint8Array[] = []
    let size = 0
    if (body) {
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > BODY_MAX) {
          await reader.cancel()
          return { ok: false, status: 413 }
        }
        chunks.push(value)
      }
    }
    const bytes = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
      bytes.set(chunk, at)
      at += chunk.byteLength
    }
    try {
      return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) }
    } catch {
      return { ok: true, value: undefined }
    }
  }

  app.get('/api/conversations', async (c) => {
    const view = parseView(c.req.query('view'), c.req.query('mailbox'))
    if (!view) return c.json({ error: 'Unknown view' }, 400)
    // `scope=mail` is the Inbox's list (the inbox alone), `scope=chat` Meet's (meet alone, the main view only); none is both merged.
    const scope = parseScope(c.req.query('scope'))
    if (scope === null || (scope === 'chat' && view.kind !== 'main')) return c.json({ error: 'Unknown scope' }, 400)
    return c.json(await conversations(await asking(c), view, scope), 200, NO_STORE)
  })

  // Today: what the apps say needs the person, gathered from the inbox, meet and forms (today.ts). Reads only.
  app.get('/api/today', async (c) => c.json(await today(await asking(c)), 200, NO_STORE))

  app.get('/api/search', async (c) => {
    const query = (c.req.query('q') ?? '').trim()
    if (query === '' || query.length > SEARCH_MAX) return c.json({ error: `Search for one to ${SEARCH_MAX} characters.` }, 400)
    return c.json(await search(await asking(c), query), 200, NO_STORE)
  })

  // ── People (people.ts): the directory, and one person's page. Reads only; the writes are /api/inbox/contact-* and client-link (views.ts). ──────────────
  // `?automated=1` lists the automated senders too, under their own heading; without it they are counted and left out.
  app.get('/api/people', async (c) => c.json(await people(await asking(c), { automated: c.req.query('automated') === '1' }), 200, NO_STORE))

  app.get('/api/person', async (c) => {
    const found = await person(await asking(c), c.req.query('key') ?? '')
    if (!found.ok) return c.json({ error: found.message }, found.status, NO_STORE)
    return c.json(found.value, 200, NO_STORE)
  })

  // ── A person's conversation (conversation.ts): opened from a row by its key, paged back, answered, read. ───────────────────────────
  app.get('/api/conversation', async (c) => {
    const scope = parseScope(c.req.query('scope'))
    if (scope === null) return c.json({ error: 'Unknown scope' }, 400)
    const opened = await openConversation(await asking(c), c.req.query('key') ?? '', scope)
    if (!opened.ok) return c.json({ error: opened.message }, opened.status, NO_STORE)
    return c.json(opened.value, 200, NO_STORE)
  })

  // A draft by its id (drafts.ts): the card of a draft that sits on no conversation, or the conversation a draft was on or was filed on. An outside tool's links and the drafting skill's name it.
  app.get('/api/draft', async (c) => {
    const opened = await openDraft(await asking(c), c.req.query('id') ?? '')
    if (!opened.ok) return c.json({ error: opened.message }, opened.status, NO_STORE)
    return c.json(opened.value, 200, NO_STORE)
  })

  // Who a document sent from this conversation is for, and the conversation it carries: what the Send screen fills in when it is opened from a conversation.
  // The same two reads that find the row, and nothing is written; forms' own Send makes the document.
  app.get('/api/conversation/signers', async (c) => {
    const found = await signingFrom(await asking(c), c.req.query('key') ?? '')
    if (!found.ok) return c.json({ error: found.message }, found.status, NO_STORE)
    return c.json(found.value, 200, NO_STORE)
  })

  // One file of a message, to look at or save (files.ts): behind the same sign-in as everything here, asked of the inbox with this request's assertion, never public, never kept.
  app.get('/api/attachment', async (c) => {
    const q = parseFileQuery({ m: c.req.query('m'), n: c.req.query('n'), how: c.req.query('how') })
    if (!q) return c.json({ error: 'Ask for a message and the place of a file in it.' }, 400, NO_STORE)
    const ask = await asking(c)
    // A byte range is asked of the inbox only for a file being viewed (a browser plays a voice note or a video in ranges); a save, and a request with several ranges, get the whole file, which the inbox hands over
    // a part at a time when it is large, and `fileResponse` reads on for the rest as the response is read.
    const range = q.how === 'view' ? parseByteRange(c.req.header('range')) : null
    const opened = await openFile(ask, q, range ?? undefined)
    if (!opened.ok) return c.json({ error: opened.message }, opened.status, NO_STORE)
    return fileResponse(opened.file, range, async (from) => {
      const next = await openFile(ask, q, { first: from })
      return next.ok ? next.file : null
    })
  })

  app.get('/api/history', async (c) => {
    const q = parseEarlier({ mail: c.req.query('mail'), chat: c.req.query('chat'), before: c.req.query('before') })
    if (!q) return c.json({ error: 'Ask for older messages with mail or chat, and before.' }, 400)
    const page = await earlier(await asking(c), q)
    if (!page.ok) return c.json({ error: page.message }, page.status, NO_STORE)
    return c.json({ messages: page.messages, more: page.more }, 200, NO_STORE)
  })

  // A reply by email, in the thread the person chose, or a draft as it stands. The compose key makes it go out at most once; the outcome
  // is always one of conversation.ts's `WriteOutcome`, with a 200: a refusal and an unknown outcome are answers the page shows, not faults.
  app.post('/api/email', async (c) => {
    const raw = await bodyOf(c)
    if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
    const body = parseEmail(raw.value)
    if (!body.ok) return c.json({ error: body.message }, 400)
    return c.json(await sendEmail(await asking(c), body.value), 200, NO_STORE)
  })

  // A reply or a new email with files: a form whose `json` part is the same body `/api/email` takes (never a draft) and whose `file` parts are the files. The
  // inbox sends files from a business mailbox only and says so otherwise; the answer is the same `WriteOutcome`.
  app.post('/api/email/files', async (c) => {
    let form: FormData
    try {
      form = await c.req.raw.formData()
    } catch {
      return c.json({ error: 'That form could not be read' }, 400)
    }
    const json = form.get('json')
    let parsed: unknown
    try {
      parsed = typeof json === 'string' && json.length <= BODY_MAX ? JSON.parse(json) : undefined
    } catch {
      parsed = undefined
    }
    // A picture can speak for itself: a reply that carries a file may have no words (the inbox decides where a picture can go, and says so otherwise).
    const body = parseEmail(parsed, { wordsMayBeEmpty: true })
    if (!body.ok) return c.json({ error: body.message }, 400)
    if (!('conversationId' in body.value) && !('address' in body.value)) return c.json({ error: 'Files go with a reply in a thread, or a new email.' }, 400)
    const files = await readFiles(form)
    if (!files.ok) return c.json({ error: files.message }, 400)
    return c.json(await sendEmail(await asking(c), { ...body.value, attachments: files.files }), 200, NO_STORE)
  })

  // ONE picture put on a Telegram draft, or over the one it has: a form whose `json` part names the draft and the revision the card shows and whose one `file` part is the picture. An edit of the
  // draft like an edit of its words; the inbox checks the file by its own first bytes and says `conflict` when the draft has moved on. The answer is the same as a draft edit's.
  app.post('/api/draft-picture', async (c) => {
    let form: FormData
    try {
      form = await c.req.raw.formData()
    } catch {
      return c.json({ error: 'That form could not be read' }, 400)
    }
    const json = form.get('json')
    let draft: unknown
    try {
      draft = typeof json === 'string' && json.length <= BODY_MAX ? JSON.parse(json) : undefined
    } catch {
      draft = undefined
    }
    if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) return c.json({ error: 'Name the draft and the revision you were shown.' }, 400)
    const files = await readFiles(form)
    if (!files.ok) return c.json({ error: files.message }, 400)
    if (files.files.length !== 1) return c.json({ error: 'A draft carries one picture.' }, 400)
    const answered = await putDraftPictureView(await asking(c), draft as { draftId: unknown; rev: unknown }, files.files[0] as InboxFile)
    return answered.ok ? c.json(answered.value, 200, NO_STORE) : c.json({ error: answered.message }, 400)
  })

  app.post('/api/chat', async (c) => {
    const raw = await bodyOf(c)
    if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
    const body = parseChat(raw.value)
    if (!body.ok) return c.json({ error: body.message }, 400)
    return c.json(await postChat(await asking(c), body.value), 200, NO_STORE)
  })

  app.post('/api/read', async (c) => {
    const raw = await bodyOf(c)
    if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
    const body = parseRead(raw.value)
    if (!body.ok) return c.json({ error: body.message }, 400)
    return c.json(await markRead(await asking(c), body.value), 200, NO_STORE)
  })

  // Close and reopen the email conversations on screen, each close at the position the page read to (the inbox refuses newer mail). Idempotent, so no key.
  app.post('/api/close', async (c) => {
    const raw = await bodyOf(c)
    if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
    const body = parseClose(raw.value)
    if (!body.ok) return c.json({ error: body.message }, 400)
    return c.json(await closeConversations(await asking(c), body.value), 200, NO_STORE)
  })

  app.post('/api/reopen', async (c) => {
    const raw = await bodyOf(c)
    if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
    const body = parseReopen(raw.value)
    if (!body.ok) return c.json({ error: body.message }, 400)
    return c.json(await reopenConversations(await asking(c), body.value), 200, NO_STORE)
  })

  // ── Channel admin (channels.ts): a channel's people, the open channels to join, and the writes that make a channel, invite a guest and change a channel. ───────────
  // Registered ahead of the calls' generic `/api/meet/:name` below; the writes are POSTs on their own paths, accepted by the one guard above (`isWritePath`), and every one is a call
  // to meet with the person this request's check named, never retried. Meet sends the one invitation, when Invite is pressed.
  app.get('/api/meet/channel', async (c) => {
    const q = parseChannelQuery(new URL(c.req.url).searchParams)
    return q.ok ? c.json(await channelOf(await asking(c), q.value), 200, NO_STORE) : c.json({ error: q.message }, 400)
  })
  app.get('/api/meet/browse', async (c) => c.json(await browseChannels(await asking(c)), 200, NO_STORE))
  app.post('/api/meet/:name{channel-.+}', async (c) => {
    const name = meetName(new URL(c.req.url).pathname)
    if (!isChannelWrite(new URL(c.req.url).pathname)) return c.json({ error: 'Not found' }, 404)
    const raw = await bodyOf(c)
    if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
    const bad = (message: string) => c.json({ error: message }, 400)
    if (name === 'channel-create') {
      const body = parseCreate(raw.value)
      return body.ok ? c.json(await createChannel(await asking(c), body.value), 200, NO_STORE) : bad(body.message)
    }
    if (name === 'channel-invite') {
      const body = parseInvite(raw.value)
      return body.ok ? c.json(await inviteGuest(await asking(c), body.value), 200, NO_STORE) : bad(body.message)
    }
    const body = parseChange(raw.value)
    return body.ok ? c.json(await changeChannel(await asking(c), body.value), 200, NO_STORE) : bad(body.message)
  })

  // ── Messages and a person's own settings (chat.ts): who a first direct message can go to, the unread count, edit and delete a message, and the person's name, nudge and privacy note. ───────────
  // The first message to someone is `/api/chat` with a `personId` (above). Each is one call to meet with the person this request's check named; the writes are POSTs on their own paths, accepted by the one guard
  // above (`isWritePath`), carry no key (repeating one is the same thing or a refusal) and are never retried. Registered ahead of the calls' generic `/api/meet/:name`.
  app.get('/api/meet/people', async (c) => c.json(await chatPeople(await asking(c)), 200, NO_STORE))
  app.get('/api/meet/me', async (c) => c.json(await chatMe(await asking(c)), 200, NO_STORE))
  app.get('/api/meet/unread', async (c) => c.json(await chatUnread(await asking(c)), 200, NO_STORE))
  app.post('/api/meet/:name{(message-edit|message-delete|me-update|privacy-ack)}', async (c) => {
    const name = meetName(new URL(c.req.url).pathname)
    if (!isChatWrite(new URL(c.req.url).pathname)) return c.json({ error: 'Not found' }, 404)
    const raw = await bodyOf(c)
    if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
    const bad = (message: string) => c.json({ error: message }, 400)
    if (name === 'privacy-ack') return c.json(await acknowledgePrivacy(await asking(c)), 200, NO_STORE)
    if (name === 'message-edit') {
      const body = parseEdit(raw.value)
      return body.ok ? c.json(await editMessage(await asking(c), body.value), 200, NO_STORE) : bad(body.message)
    }
    if (name === 'message-delete') {
      const body = parseDelete(raw.value)
      return body.ok ? c.json(await deleteMessage(await asking(c), body.value), 200, NO_STORE) : bad(body.message)
    }
    const body = parseMeUpdate(raw.value)
    return body.ok ? c.json(await updateMe(await asking(c), body.value), 200, NO_STORE) : bad(body.message)
  })

  // ── Calls (calls.ts): cards, past calls, a call's chat, the month's usage, the Phone conversation; and a huddle, a call link, a New call, a meeting. ───────────
  // Each is one call to meet with the person this request's check named; the answer is a `ViewAnswer` with a 200 (a refusal, the meter, a fault and an unknown outcome are answers the
  // page shows). A write carries a compose key and is never retried. No link is made here: meet answers each call with its own, on its public address.
  app.get('/api/meet/:name', async (c) => {
    const name = c.req.param('name')
    if (!MEET_READS.includes(name as (typeof MEET_READS)[number])) return c.json({ error: 'Not found' }, 404)
    const ask = await asking(c)
    const params = new URL(c.req.url).searchParams
    if (name === 'cards') {
      const want = parseCards(params)
      return want.ok ? c.json(await cards(ask, want.value), 200, NO_STORE) : c.json({ error: want.message }, 400)
    }
    if (name === 'calls') {
      const after = parseAfter(params)
      return after.ok ? c.json(await pastCalls(ask, after.value), 200, NO_STORE) : c.json({ error: after.message }, 400)
    }
    if (name === 'call') {
      const call = parseName(params)
      return call.ok ? c.json(await callChat(ask, call.value), 200, NO_STORE) : c.json({ error: call.message }, 400)
    }
    return c.json(name === 'usage' ? await usage(ask) : await phone(ask), 200, NO_STORE)
  })

  app.post('/api/meet/:name', async (c) => {
    const name = meetName(new URL(c.req.url).pathname)
    if (!isMeetWrite(new URL(c.req.url).pathname)) return c.json({ error: 'Not found' }, 404)
    const raw = await bodyOf(c)
    if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
    const ask = await asking(c)
    const bad = (message: string) => c.json({ error: message }, 400)
    if (name === 'huddle') {
      const body = parseHuddle(raw.value)
      return body.ok ? c.json(await startHuddle(ask, body.value), 200, NO_STORE) : bad(body.message)
    }
    if (name === 'call') {
      const body = parseCall(raw.value)
      return body.ok ? c.json(await startCall(ask, body.value), 200, NO_STORE) : bad(body.message)
    }
    if (name === 'meeting') {
      const body = parseMeeting(raw.value)
      return body.ok ? c.json(await bookMeeting(ask, body.value), 200, NO_STORE) : bad(body.message)
    }
    if (name === 'delete-chat') {
      const body = parseName(new URLSearchParams({ name: isRecord(raw.value) && typeof raw.value.name === 'string' ? raw.value.name : '' }))
      return body.ok ? c.json(await deleteChat(ask, body.value), 200, NO_STORE) : bad(body.message)
    }
    const upTo = isRecord(raw.value) ? raw.value.upTo : undefined
    return isCount(upTo) ? c.json(await phoneRead(ask, upTo), 200, NO_STORE) : bad('Reading the Phone names the item read up to.')
  })

  // The phone's own requests (the dial pad's), handed to meet's part for the person the check named (phone.ts). Meet decides who has a phone and what they may do.
  // (`appsFor`, so a local run with fixtures answers from the stand-in and a real one from the part.)
  const toPhone = async (c: Context<App>) => {
    const { meet } = await appsFor(c.req.raw, c.env, deps, partsFor)
    return meet ? phoneAnswer(await meet.fetch(await phoneRequest(c.req.raw), c.get('signedIn'))) : c.json({ error: 'Chat is not connected to the space.' }, 503)
  }
  app.all('/api/phone/*', toPhone)
  app.all('/api/phone', toPhone)

  // ── Connect Gmail (gmail.ts): the owner's browser to Google and back, the return at https://space.northfield.example/api/inbox/gmail/callback. Two GETs; the inbox decides who may. ───
  app.all(GMAIL_START_PATH, async (c) => startGmail(await asking(c), c.req.raw))
  app.all(GMAIL_RETURN_PATH, async (c) => returnGmail(await asking(c), c.req.raw))

  // ── The inbox's other views (views.ts): Settings, the knowledge base, Clients, the draft chat. Each is one call to the inbox with this request's assertion. ───
  // The answer is always a `ViewAnswer` with a 200 (a refusal, a fault and an unknown outcome are answers the page shows, not faults of this Worker); a name or a
  // body that is none of the above is a 400. A write needs this host's Origin and a JSON body, like the conversation's (above), and is never retried.
  app.get('/api/inbox/:name', async (c) => {
    const name = c.req.param('name')
    if (!READ_NAMES.includes(name as ReadName)) return c.json({ error: 'Not found' }, 404)
    const got = await readView(await asking(c), name as ReadName, new URL(c.req.url).searchParams)
    if (!got.ok) return c.json({ error: got.message }, 400)
    return c.json(got.value, 200, NO_STORE)
  })

  app.post('/api/inbox/:name', async (c) => {
    const name = c.req.param('name')
    if (!WRITE_NAMES.includes(name as WriteName)) return c.json({ error: 'Not found' }, 404)
    const raw = await bodyOf(c)
    if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
    const got = await writeView(await asking(c), name as WriteName, raw.value, c.req.header('user-agent') ?? null)
    if (!got.ok) return c.json({ error: got.message }, 400)
    return c.json(got.value, 200, NO_STORE)
  })

  // ── The knowledge base (knowledge.ts): the knowledge app's, read and changed by the owner alone. One call each, with this request's assertion. ───
  // `?business=<id>` narrows the read to one business's entries (what its assistant reads once the active ones are taken). The answer is a `ViewAnswer` with a 200,
  // as the inbox's views are; a business that is not a slug or a body that is not a change is a 400. A write needs this host's Origin and a JSON body, and is never retried.
  app.get('/api/knowledge', async (c) => {
    const got = await readKnowledge(await asking(c), c.req.query('business') ?? null)
    if (!got.ok) return c.json({ error: got.message }, 400)
    return c.json(got.value, 200, NO_STORE)
  })

  app.post('/api/knowledge', async (c) => {
    const raw = await bodyOf(c)
    if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
    const got = await changeKnowledge(await asking(c), raw.value)
    if (!got.ok) return c.json({ error: got.message }, 400)
    return c.json(got.value, 200, NO_STORE)
  })

  // ── The calendar (calendar.ts): the calendar app's, read and changed by the owner alone. One call each, with the person this request's one check named. Nothing here asks Google: the app answers from its own store. ───
  // The agenda is the app's events and Meet's meetings in the same span; the accounts, the event's card and the two writes (show or hide a calendar, Check now) are one call each. A write needs this host's Origin and a JSON body, and is never retried.
  app.get('/api/calendar/agenda', async (c) => {
    const got = await readAgenda(await asking(c), new URL(c.req.url).searchParams)
    if (!got.ok) return c.json({ error: got.message }, 400)
    return c.json(got.value, 200, NO_STORE)
  })
  app.get('/api/calendar/accounts', async (c) => c.json(await readAccounts(await asking(c)), 200, NO_STORE))
  app.get('/api/calendar/event', async (c) => {
    const got = await readEvent(await asking(c), c.req.query('id') ?? null)
    if (!got.ok) return c.json({ error: got.message }, 400)
    return c.json(got.value, 200, NO_STORE)
  })
  app.post(CALENDAR_WRITE_PATHS[0], async (c) => {
    const raw = await bodyOf(c)
    if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
    const got = await setShown(await asking(c), raw.value)
    if (!got.ok) return c.json({ error: got.message }, 400)
    return c.json(got.value, 200, NO_STORE)
  })
  app.post(CALENDAR_WRITE_PATHS[1], async (c) => c.json(await syncNow(await asking(c)), 200, NO_STORE))

  // The operator's three, for a move of the knowledge store (knowledge.ts): a bookmark, a restart and a restore, each the owner's alone (the app refuses anyone else) and each a POST like every write here.
  app.post(KNOWLEDGE_STORE_PATHS[0], async (c) => c.json(await storeBookmark(await asking(c)), 200, NO_STORE))
  app.post(KNOWLEDGE_STORE_PATHS[1], async (c) => c.json(await restartStore(await asking(c)), 200, NO_STORE))
  app.post(KNOWLEDGE_STORE_PATHS[2], async (c) => {
    const raw = await bodyOf(c)
    if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
    const got = await restoreStore(await asking(c), raw.value)
    if (!got.ok) return c.json({ error: got.message }, 400)
    return c.json(got.value, 200, NO_STORE)
  })

  // The operator's four, for a move of meet's stores (meet-store.ts): a bookmark, a restart, a restore and the counts of one of the two long-lived objects, each the owner's alone (meet's part refuses anyone else) and each a POST like every write here.
  // Registered ahead of the calls' generic `/api/meet/:name` (which is one segment, so these never match it anyway).
  for (const [path, run] of [
    [MEET_STORE_PATHS[0], meetBookmark],
    [MEET_STORE_PATHS[1], meetRestart],
    [MEET_STORE_PATHS[2], meetRestore],
    [MEET_STORE_PATHS[3], meetCounts],
  ] as const) {
    app.post(path, async (c) => {
      const raw = await bodyOf(c)
      if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
      const got = await run(await asking(c), raw.value)
      if (!got.ok) return c.json({ error: got.message }, 400)
      return c.json(got.value, 200, NO_STORE)
    })
  }

  // The operator's three, for a move of the inbox's store (inbox-store.ts): a bookmark, a restart and the counts, each the owner's alone (the inbox's part refuses anyone else) and each a POST like every write here, with no body.
  // They are two segments under /api/inbox, so the generic `/api/inbox/:name` (one segment) never matches them.
  app.post(INBOX_STORE_PATHS[0], async (c) => c.json(await inboxBookmark(await asking(c)), 200, NO_STORE))
  app.post(INBOX_STORE_PATHS[1], async (c) => c.json(await inboxRestart(await asking(c)), 200, NO_STORE))
  app.post(INBOX_STORE_PATHS[2], async (c) => c.json(await inboxCounts(await asking(c)), 200, NO_STORE))

  // Settings › Clients (clients-settings.ts): the list and one Client's page, each the Clients part's Client put together with the inbox's people under it, and the four writes (New, Edit,
  // Archive, Put back), each one call to the Clients part, which admits the owner alone. The answers are `ViewAnswer`s with a 200 as every view here is; a body that is not the shape is a 400. A write needs this host's Origin and a JSON body, and is never retried.
  app.get('/api/clients/list', async (c) => c.json(await readClientsScreen(await asking(c)), 200, NO_STORE))
  app.get('/api/clients/one', async (c) => {
    const number = Number(c.req.query('number'))
    if (!Number.isSafeInteger(number) || number < 1) return c.json({ error: 'Ask for one Client: number=<number>.' }, 400)
    return c.json(await readClientScreen(await asking(c), number), 200, NO_STORE)
  })
  for (const [path, run] of [
    [CLIENTS_WRITE_PATHS[0], (ask: Asking, body: unknown) => makeClientView(ask, body)],
    [CLIENTS_WRITE_PATHS[1], (ask: Asking, body: unknown) => editClientView(ask, body)],
    [CLIENTS_WRITE_PATHS[2], (ask: Asking, body: unknown) => archiveClientView(ask, body, false)],
    [CLIENTS_WRITE_PATHS[3], (ask: Asking, body: unknown) => archiveClientView(ask, body, true)],
  ] as const) {
    app.post(path, async (c) => {
      const raw = await bodyOf(c)
      if (!raw.ok) return c.json({ error: 'Too large' }, raw.status)
      const got = await run(await asking(c), raw.value)
      if (!got.ok) return c.json({ error: got.message }, 400)
      return c.json(got.value, 200, NO_STORE)
    })
  }

  // The operator's three, for the Clients store (clients.ts): a bookmark, a restart and the counts, each the owner's alone (the Clients part refuses anyone else) and each a POST like every write here, with no body.
  // Nothing here asks a source: a source's Clients arrive through the Clients door.
  app.post(CLIENTS_STORE_PATHS[0], async (c) => c.json(await clientsBookmark(await asking(c)), 200, NO_STORE))
  app.post(CLIENTS_STORE_PATHS[1], async (c) => c.json(await clientsRestart(await asking(c)), 200, NO_STORE))
  app.post(CLIENTS_STORE_PATHS[2], async (c) => c.json(await clientsCounts(await asking(c)), 200, NO_STORE))

  // THE LIVE SOCKET (the space's ADR 0019): the page's ONE connection, opened on this origin after the check above has named the person. It is handed to the company's one live object with the two things the
  // object trusts the Worker for, the person's sign-in address and when the Access assertion behind it ends, and the object closes the socket then. A browser always sends its page's Origin on a socket; anything
  // but this site's own is refused, so a page on another site cannot open the person's connection with their cookie. The object holds no data: it only tells the page that a part moved.
  app.get(LIVE_SOCKET_PATH, (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: 'A socket upgrade is needed.' }, 426)
    if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'Cross-site socket refused' }, 403)
    const live = c.env.LIVE
    if (!live) return c.json({ error: 'Live updates are not connected to the space.' }, 503)
    const headers = new Headers({ upgrade: 'websocket', 'x-live-person': c.get('who').address, 'x-live-ends': String(c.get('signedIn').exp * 1000) })
    return live.get(live.idFromName(LIVE_NAME)).fetch(new Request(c.req.url, { headers }))
  })

  app.onError((err, c) => {
    console.error(err)
    return c.json({ error: 'Internal error' }, 500)
  })

  // The space opens on its home tab.
  app.get('/', (c) => c.redirect(deps.install.tabs().find((t) => t.id === HOME_TAB)?.path ?? '/', 302))

  // The Conversations tab was split into Inbox and Meet: its old addresses land on the same thing under the new ones (legacy.ts), query kept. A GET and a HEAD only (the method guard above refuses the rest).
  app.all('*', async (c, next) => {
    const { pathname, search } = new URL(c.req.url)
    return isLegacyPath(pathname) ? c.redirect(legacyTarget(pathname, search), 302) : next()
  })

  app.get('/api/me', (c) => c.json(meOf(c.get('who'), c.get('deps').install), 200, NO_STORE))
  // An unknown API path is a 404, never the page: with the asset router's fallback it would be a 200 of HTML.
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))

  app.all('*', (c) => page(c))

  return app
}

/**
 * The installed app takes the company's name: the manifest is one file for every install (public/manifest.webmanifest, whose icons, scope and colors are the same), and its `name` is the install's company followed
 * by "Space" ("Northfield Works Space" in the bundled install). A manifest the assets did not answer, or that is not JSON, is passed on as it is.
 */
export async function namedManifest(url: string, res: Response, install: Install): Promise<Response> {
  if (new URL(url).pathname !== '/manifest.webmanifest' || !res.ok) return res
  try {
    const manifest = JSON.parse(await res.clone().text()) as Record<string, unknown>
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return res
    const headers = new Headers(res.headers)
    headers.delete('content-length')
    return new Response(JSON.stringify({ ...manifest, name: `${install.company.name} Space` }), { status: res.status, headers })
  } catch {
    return res
  }
}

/** What a script file carries (see `page`): its own address, and WebAssembly. */
export const SCRIPT_POLICY = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'"

/** The page or file, from the assets, with the headers every answer here carries. Only a signed-in request gets this far. */
async function page(c: Context<App>): Promise<Response> {
  const res = await namedManifest(c.req.url, await c.env.ASSETS.fetch(c.req.raw), c.get('deps').install)
  const out = new Response(res.body, res)
  out.headers.set('x-content-type-options', 'nosniff')
  out.headers.set('x-robots-tag', 'noindex')
  out.headers.set('referrer-policy', 'no-referrer')
  // A script gets a narrow policy of its own: not the page's, and not none. The policy that governs a worker is the one its own response carries, and the page's would refuse
  // pdf.js's worker the WebAssembly compile it needs to decode JPEG 2000, JBIG2 and fax images (no 'wasm-unsafe-eval'), so it would fall back to its slower JavaScript decoders.
  // So a script (pdf.js's worker, the service worker, a chunk) may load from its own address and compile WebAssembly, and no more. Every other file (an image, a style, the manifest)
  // carries none, because nothing is governed through it.
  const type = (out.headers.get('content-type') ?? '').toLowerCase()
  if (/\b(java|ecma)script\b/.test(type)) {
    out.headers.set('content-security-policy', SCRIPT_POLICY)
    return out
  }
  if (!type.startsWith('text/html')) return out
  // `script-src` adds one thing to 'self': the hash of the recovery script the page carries inline (recover.ts).
  // `connect-src` names the live socket's own address as well as 'self': a browser that does not count 'self' as ws/wss would refuse it. It also names Telnyx's signalling
  // address, which the browser phone (meet's, drawn in the space) opens a WebSocket to; the phone is not set up yet, so this has not been seen to work (README, the phone's hand test).
  const phoneSignalling = 'wss://rtc.telnyx.com'
  const here = new URL(c.req.url)
  const socket = `${here.protocol === 'https:' ? 'wss' : 'ws'}://${here.host}`
  out.headers.set('content-security-policy', `default-src 'self'; script-src 'self' ${await recoverScriptHash()}; connect-src 'self' ${socket} ${phoneSignalling}; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`)
  return out
}
