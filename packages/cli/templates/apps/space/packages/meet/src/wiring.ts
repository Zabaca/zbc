// How meet's parts are wired to their externals: the Durable Object namespaces, the email binding, Telnyx, the clock and the crypto.
//
// The space's Worker wires them from this one file: its team side (src/space-part.ts, through packages/space/src/parts.ts), which runs the team's chat, calls and
// phone in-process and needs only the part below `MeetPartEnv`. Nothing here imports the Workers runtime (the Durable Object classes are named as types only), so `bun test` loads it.

import type { RoomDO } from './do'
import type { WorkspaceDO } from './workspace-do'
import type { Install, MeetObject } from '@space/workspace'
import type { Deps, MeetPartDeps } from './app'
import { BUNDLED_INSTALL } from './company'
import { fakeRealtime } from './dev-realtime'
import { LOCAL_HOSTS } from './door'
import { type Mailer, type Outgoing, bindingMailer, devMailer } from './mail'
import { phoneClient } from './phone'
import { type PhoneEnv, phoneRuntime } from './phone-runtime'
import { cloudflareRealtime } from './realtime'
import { LEDGER_NAME, roomClient } from './room'
import type { SpaceMeetDeps, StoreObject } from './space-meet'
import { WORKSPACE_NAME, workspaceClient } from './workspace'

/**
 * What the part of meet that runs in the space's Worker reads: its two Durable Object namespaces, the sender, Telnyx's secrets (the phone's dial pad and the sweep's chores)
 * and the local-development switch. The address its emails link to is the install's space host (`appOriginOf`), not a setting. The space maps its own names onto these, see packages/space/src/parts.ts.
 */
export interface MeetPartEnv extends PhoneEnv {
  ROOMS: DurableObjectNamespace<RoomDO>
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>
  /** Cloudflare Email Service's outbound binding (wrangler.jsonc `send_email`), sending as the install's meet sender (`senders.meet`). */
  EMAIL?: { send(message: Outgoing): Promise<unknown> }
  /** Local development only (.dev.vars), honoured on a localhost host alone. */
  ALLOW_UNAUTHENTICATED?: string
}

/** Everything meet's own Worker reads, for the guests' pages, the call API and Telnyx's webhook. */
export interface MeetEnv extends MeetPartEnv {
  ASSETS: Fetcher
  /** Cloudflare's Rate Limiting binding (wrangler.jsonc `ratelimits`): absent in a local run, where nothing is limited. */
  AUTH_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> }
  /** Plain variables in wrangler.jsonc: not secret. */
  REALTIME_APP_ID: string
  TURN_KEY_ID: string
  /** Worker secrets. */
  MEET_REALTIME_APP_SECRET: string
  MEET_TURN_KEY_TOKEN: string
  /** Local development only: the address the bypass signs in as (default: the install owner's sign-in address). */
  DEV_TEAMMATE?: string
  /** Local development only: an SFU that carries no media, for checks that need none. Honoured on a localhost host alone. */
  FAKE_REALTIME?: string
}

/** The emails a localhost run has "sent", for the live check (never filled in production). */
const DEV_MAIL: Outgoing[] = []

const noBinding: Mailer = {
  async send() {
    throw new Error('The Worker has no email binding (EMAIL), so nothing was sent')
  },
}

/** The one Workspace object, and the client that asks it. */
const workspaceObject = (env: MeetPartEnv) => env.WORKSPACE.get(env.WORKSPACE.idFromName(WORKSPACE_NAME))
const workspaceOf = (env: MeetPartEnv) => {
  const s = workspaceObject(env)
  return workspaceClient((method, args) => s.invoke(method, args))
}

const roomOf = (env: MeetPartEnv, name: string) => {
  const s = env.ROOMS.get(env.ROOMS.idFromName(name))
  return roomClient((method, args) => s.invoke(method, args))
}

/** One of the two long-lived objects, for the operator's bookmark, restart and restore. */
export const objectOf = (env: MeetPartEnv, which: MeetObject): StoreObject =>
  (which === 'workspace' ? workspaceObject(env) : env.ROOMS.get(env.ROOMS.idFromName(LEDGER_NAME))) as unknown as StoreObject

const isLocal = (url: string): boolean => LOCAL_HOSTS.has(new URL(url).hostname)

/** The one address every link meet makes is on (a call's, a guest's door, an email's): the install's space host, never a setting beside it. */
export const appOriginOf = (install: Install): string => install.url().replace(/\/+$/, '')

/**
 * What the phone's rules, the sweep and the socket need: the space's Worker is given exactly this. `install` is the company this Worker serves: the space hands in its own (the one its sign-in check
 * names people from), and meet's own Worker, which has none but its bundle, passes nothing.
 */
export function partDepsFor(env: MeetPartEnv, url: string, install: Install = BUNDLED_INSTALL): MeetPartDeps {
  const local = isLocal(url)
  const dev = local && env.ALLOW_UNAUTHENTICATED === '1'
  const workspace = () => workspaceObject(env)
  return {
    workspace: () => workspaceOf(env),
    phoneCore: () => {
      const s = workspace()
      return phoneClient((method, args) => s.invokePhone(method, args))
    },
    // The phone is a switch: an install without it has no Telnyx, no dial pad and no webhook, whatever secrets the Worker holds.
    phone: install.has('phone') ? phoneRuntime(env, local) : null,
    mailer: dev ? devMailer(DEV_MAIL) : env.EMAIL ? bindingMailer(env.EMAIL) : noBinding,
    install,
    appOrigin: appOriginOf(install),
    // The router built these headers itself from a ticket it spent: nothing the browser sent is forwarded.
    openSocket: (who) =>
      workspace().fetch('https://workspace/socket', {
        headers: { upgrade: 'websocket', 'x-meet-person': who.person, 'x-meet-session': who.session ?? '', 'x-meet-ends': String(who.endsAt) },
      }),
    devBypass: env.ALLOW_UNAUTHENTICATED === '1',
    now: () => Date.now(),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  }
}

/**
 * Everything the guests' side serves with: the part's, and the call API, the guests' sign-in limit and the development bypass's mailbox. The local Worker (dev/worker.ts) and the space's guest door
 * (packages/space/src/guests.ts) both build it from here; `install` is the company the space serves, as for the part, and meet's own Worker passes nothing.
 */
export function depsFor(env: MeetEnv, url: string, install: Install = BUNDLED_INSTALL): Deps {
  const local = isLocal(url)
  const dev = local && env.ALLOW_UNAUTHENTICATED === '1'
  return {
    ...partDepsFor(env, url, install),
    room: (name) => roomOf(env, name),
    ledger: () => roomOf(env, LEDGER_NAME),
    authLimit: async (key) => (await env.AUTH_LIMIT?.limit({ key }))?.success !== false,
    devTeammate: (env.DEV_TEAMMATE ?? install.owner().signIn).toLowerCase(),
    devMail: dev ? DEV_MAIL : null,
    realtime:
      local && env.FAKE_REALTIME === '1'
        ? fakeRealtime()
        : cloudflareRealtime({
            appId: env.REALTIME_APP_ID,
            appSecret: env.MEET_REALTIME_APP_SECRET,
            turnKeyId: env.TURN_KEY_ID,
            turnToken: env.MEET_TURN_KEY_TOKEN,
          }),
  }
}

/** What `spaceMeet` needs of a Worker: the Workspace object, the calls' objects, the sender, the clock and randomness. */
export function spaceMeetDepsFor(env: MeetPartEnv, install: Install = BUNDLED_INSTALL): SpaceMeetDeps {
  return {
    install,
    workspace: () => workspaceOf(env),
    room: (name) => roomOf(env, name),
    ledger: () => roomOf(env, LEDGER_NAME),
    object: (which) => objectOf(env, which),
    appOrigin: appOriginOf(install),
    // The same sender as the guest door's codes and the channel invitations: the `send_email` binding, as meet@northfield.example.
    mailer: env.EMAIL ? bindingMailer(env.EMAIL) : noBinding,
    now: () => Date.now(),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  }
}
