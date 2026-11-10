// What the route files share: the Worker's environment and the Hono context types, plus small request helpers.
// Kept apart from app.ts so a route file can import them without a cycle.

import type { Context } from 'hono'
import type { ClientsForInbox, Http, LiveBinding } from '@space/workspace'
import type { Outgoing } from './mail'
import type { Db } from './records'
import type { ObjectStore } from './vault'
import type { Install, Operator } from './workspace'

export interface Env {
  DB: Db
  /** The private bucket: every object but a logo is written with its envelope's own key. */
  FILES: ObjectStore
  ASSETS: { fetch(request: Request): Promise<Response> }
  /** The Access application's audience tag, deployed by the zbc module as a var. */
  CF_ACCESS_AUD?: string
  /** `vite dev` only, from .dev.vars, which wrangler never uploads. Honoured on localhost alone. */
  ALLOW_UNAUTHENTICATED?: string
  /** The master key for the vault, base64, 32 bytes. A Worker secret, and in sops. */
  FORMS_DATA_KEY?: string
  /** The seal certificate's private key (PKCS#8 PEM) and its chain (seal certificate, then the root). Worker secrets. */
  FORMS_SEAL_KEY?: string
  FORMS_SEAL_CERT_CHAIN?: string
  /** Cloudflare Email Service's outbound binding (wrangler.jsonc `send_email`), sending as the install's forms address (forms@northfield.example). The signing core uses it. */
  EMAIL?: { send(message: Outgoing): Promise<unknown> }
  /** Cloudflare's rate-limiting binding for the public API. */
  PUBLIC_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> }
  /** The company's live object (the space's `LIVE`), told that documents moved after each committed batch (src/live.ts). Absent where none is bound. */
  LIVE?: LiveBinding
  /**
   * The Clients part's inbox face (the list and one Client, read only), called in-process in the space's Worker: where the names of a Client come from when a row is created for it or linked to it (src/client-names.ts). Absent in forms' own
   * Worker, which has a stand-in (dev/clients.ts); absent, the routes that need a Client say Forms cannot read the Clients list and write nothing.
   */
  CLIENTS_READ?: ClientsForInbox
  /** Keeps the Worker request alive until a message to the live object is out (`ctx.waitUntil`); the space passes it with each request. Absent: the message is sent and not waited for. */
  LIVE_WAIT?: (promise: Promise<unknown>) => void
}

export interface Deps {
  fetch: Http
  /** The company this Worker serves: who its operators are, where the apps link to each other. */
  install: Install
  now: () => number
  /**
   * THE OPERATOR THE SPACE'S ONE SIGN-IN CHECK ALREADY NAMED for this request (ADR 0003 of packages/workspace), when this app runs inside the space's Worker. Given, the
   * operator API verifies nothing itself: it asks this and nothing else, and a request it returns null for is a 401, never a second try at the assertion. Absent, as in
   * forms' own Worker (which still answers `/admin/api/*` until the space replaces it, when it is deleted along with this field), the API verifies the Access assertion
   * as before.
   */
  named?: (req: Request) => Operator | null
}

export type App = { Bindings: Env; Variables: { operator: Operator; deps: Deps } }
export type C = Context<App>

export const db = (c: C) => c.env.DB
export const actor = (c: C) => c.get('operator').actor
export const nowMs = (c: C) => c.get('deps').now()
