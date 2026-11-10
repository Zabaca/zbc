// The inbox's part of the space, as the space's Worker holds it (the company layer's ADR 0003).
//
// One value with two faces: the methods of `InboxForSpace` (src/space.ts), called in-process with the person the space's check named, and `claude`, which hands a request on Claude's door to
// the inbox's own router (src/app.ts) for the service token the space's check verified. Both run over the Durable Object the Worker binds, whoever owns its class at the moment: the inbox's Worker
// before the transfer, the space's after, and the code is the same file (src/durable.ts).
//
// Nothing here imports the Workers runtime, so `bun test` drives it.

import type { ClientsForInbox, InboxForSpace, KnowledgeForInbox } from '@space/workspace'
import { type Env as AppEnv, createApp, type ServiceIdentity } from './app'
import { createSpaceInbox } from './space'
import { type InboxEnv, objectFor, storeFor } from './store-access'
import { createTelegramApp } from './telegram/app'
import { bundledInstall, type Install } from './workspace'

/**
 * What the part reads of a Worker: the store's Durable Object namespace, the Clients part's inbox face (asked in-process, never a service binding), the Google client's id (for Connect Gmail's
 * sign-in address) and Claude's token id (which the router admits as the agent). The space maps its own names onto these (src/parts.ts); `INBOX` is the same name in both Workers.
 */
export interface InboxPartEnv extends InboxEnv {
  /** The Clients part's inbox face (packages/clients `createInboxClients`): the list and one Client, asked in-process in the space's Worker. Absent where its store is not bound; Clients then show by number and a link is refused. */
  clients?: ClientsForInbox
  INBOX_GOOGLE_CLIENT_ID?: string
  /** The Access client id of Claude's service token (a var; an id is not a credential). Unset, the router admits nobody on Claude's door. */
  INBOX_ACCESS_CLIENT_ID?: string
  /** The Access client id of the Telegram bridge's service token (a var). Unset, the bridge's router admits nobody. */
  TELEGRAM_ACCESS_CLIENT_ID?: string
  /**
   * The knowledge app as Claude's `knowledge` and `propose-knowledge` are handed on to it (src/app.ts): in the space, the knowledge store asked in-process (packages/space/src/parts.ts), never a
   * service binding. Absent, those two routes answer that the knowledge app is not reached.
   */
  knowledge?: KnowledgeForInbox
}

export interface InboxPart extends InboxForSpace {
  /**
   * A request on Claude's door, at the inbox's own `/api/...` path and without the cookie, with the service token the space's check verified (the agent application's audience, a token only).
   * The router admits Claude's token by its id and nobody else, serves `/api/` and nothing else, and has no push hostname and no dev identity.
   */
  claude(request: Request, who: ServiceIdentity): Promise<Response>
  /**
   * A request on the Telegram bridge's door, at the inbox's own `/api/...` path and without the cookie, with the service token the space's check verified (the bridge application's
   * audience, a token only). The router admits the bridge's token by its id (`TELEGRAM_ACCESS_CLIENT_ID`) and nobody else, Claude's included, and serves five calls (src/telegram/app.ts).
   */
  telegram(request: Request, who: ServiceIdentity): Promise<Response>
}

/**
 * The part, made once per Worker `createApp`: the router inside it is built on first use and kept. `install` is the company the space serves, the one its sign-in check names people from;
 * omitted, the bundle's (`@inbox/declaration`), which is the same file in a deployed Worker.
 */
export function createInboxPartFactory(install: Install = bundledInstall): (env: InboxPartEnv) => InboxPart {
  const named = new WeakMap<Request, ServiceIdentity>()
  let router: ReturnType<typeof createApp> | undefined
  const claudeRouter = () =>
    (router ??= createApp({ store: (env) => storeFor(env), install, named: (req) => named.get(req) ?? null }))
  let telegramRouter: ReturnType<typeof createTelegramApp> | undefined
  const bridgeRouter = () =>
    (telegramRouter ??= createTelegramApp({
      store: (env) => storeFor(env as InboxEnv),
      named: (req) => named.get(req) ?? null,
    }))
  return (env) => ({
    ...createSpaceInbox({
      store: storeFor(env),
      install,
      clients: env.clients,
      googleClientId: env.INBOX_GOOGLE_CLIENT_ID,
      object: () => objectFor(env),
    }),
    claude: (request, who) => {
      named.set(request, who)
      // The router is given what it reads and nothing else of the Worker's environment.
      const routerEnv: AppEnv = {
        INBOX: env.INBOX,
        ...(env.clients && { CLIENT_LIST: env.clients }),
        ...(env.INBOX_ACCESS_CLIENT_ID !== undefined && { INBOX_ACCESS_CLIENT_ID: env.INBOX_ACCESS_CLIENT_ID }),
        ...(env.knowledge && { KNOWLEDGE: env.knowledge }),
      }
      return Promise.resolve(claudeRouter().fetch(request, routerEnv))
    },
    telegram: (request, who) => {
      // The bridge is a switch: an install without it has no bridge, whatever token reaches here.
      if (!install.has('telegram')) return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }))
      named.set(request, who)
      // The bridge's router reads one var and the store; nothing else of the Worker's environment reaches it.
      return Promise.resolve(
        bridgeRouter().fetch(request, {
          INBOX: env.INBOX,
          ...(env.TELEGRAM_ACCESS_CLIENT_ID !== undefined && {
            TELEGRAM_ACCESS_CLIENT_ID: env.TELEGRAM_ACCESS_CLIENT_ID,
          }),
        } as never),
      )
    },
  })
}
