// The Worker's four entrances, built over the router (src/app.ts): `fetch` for people, Claude and Gmail's push; `email` for Cloudflare Email Routing; `queue` for Cloudflare's delivery reports;
// `scheduled` for the two crons. The inbox's last three entrances, and Gmail's push, are here in the one Worker, because the inbox has no Worker of its own.
// Kept out of src/index.ts, which imports the Durable Object classes and so cannot be loaded by `bun test`.
//
// TWO HOSTNAMES, TOLD APART FIRST IN EVERY REQUEST. inbox-push.northfield.example is Gmail's push and (since the calendar, the space's ADR 0020) Google Calendar's notification path, POST /calendar/push, and nothing else: Pub/Sub cannot sign in to Access, so no Access application covers that name, and on it
// the inbox's push app (packages/inbox/src/push-door.ts) answers ONE path, for a Google-signed token, and every other path and method is a 404. No team route is reachable from it: the router is
// never called for that host. Every other host goes to the router, whose first rule is that nothing is answered before the sign-in is checked, so a push POSTed at space.northfield.example is
// an unsigned request like any other and is refused there. The space's own host is never the push host, whatever the settings say.
//
// THE THREE CRONS. The daily pass (the inbox's: renew Gmail's watch, one sync) runs on its own expression, forms' hourly sweep (expiry, reminders,
// sealing again, the retention purge) on its own, and any other expression is meet's five-minute sweep, as before, which also carries the Clients part's repair of Forms' copy of each Client's names (src/clients-forms.ts). Each expression is declared in the Worker's settings (kit/worker-settings.ts) and in no other Worker's.

import { calendarPush, isCalendarPush } from '@space/calendar/src/push-door'
import { engineFor } from '@space/calendar/src/store-access'
import type { InboundEmail } from '@space/inbox/src/cloudflare/entrance'
import { DAILY_CRON, keepReports, type ReportBatch, runDaily, takeEmail, type WaitsUntil } from '@space/inbox/src/entrances'
import { type PushEnv, pushSettings } from '@space/inbox/src/gmail/push'
import { createPushApp, type PushDeps } from '@space/inbox/src/push-door'
import { type InboxEnv, storeFor } from '@space/inbox/src/store-access'
import { runClientNamesRepair, runFormsSweep, runMeetSweep, type PartsEnv } from './parts'
import type { Install } from '@space/workspace'
import { bundledInstall } from './workspace'

/** What the entrances read of the Worker's environment, beside the router's own (src/app.ts). */
/** Forms' hourly sweep, on the hour (the Worker's settings (kit/worker-settings.ts) `triggers.crons`; forms has no Worker of its own). */
export const FORMS_CRON = '0 * * * *'

export interface WorkerEnv extends PartsEnv, PushEnv {
  RAW?: R2Bucket
  INBOX_MAILBOXES?: unknown
}

export interface WorkerParts<E> {
  /** The router: people, Claude's door and everything that is not Gmail's push. */
  team(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response>
  /** The space's own hostname, which is never the push host. */
  spaceHost?: string
  /** Google's signing keys for the push, injected so a test serves its own. */
  pushKeys?: PushDeps['pushKeys']
  /** The install the Worker serves (its switches); omitted, the bundle's. */
  install?: Install
}

/** The hostname Gmail's push is answered on: the install's (`Install.gmailPushHost()`) and the one the settings name (the same two push-door.ts accepts), never the space's own. */
export function isPushHost(hostname: string, env: PushEnv, spaceHost: string, installHost: string | null): boolean {
  if (hostname === spaceHost) return false
  const settings = pushSettings(env)
  return (installHost !== null && hostname === installHost) || (settings.ok && hostname === settings.host)
}

export function createWorker<E extends WorkerEnv>(parts: WorkerParts<E>) {
  const install = parts.install ?? bundledInstall
  const spaceHost = parts.spaceHost ?? install.declaration.space.host
  const push = createPushApp({ store: (env) => storeFor(env as unknown as InboxEnv), pushHost: install.gmailPushHost(), ...(parts.pushKeys && { pushKeys: parts.pushKeys }) })
  return {
    fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response> {
      if (isPushHost(new URL(request.url).hostname, env, spaceHost, install.gmailPushHost())) {
        // The push host is Gmail's (and Google Calendar's, which rides on the same grant): an install without the Gmail switch has none, and nothing on it is answered.
        if (!install.has('gmail')) return Response.json({ error: 'Not found' }, { status: 404 })
        // The push host has two paths: Gmail's (the inbox's push app, which 404s everything else) and, since the calendar, Google Calendar's notifications, which carry no body and are checked by the channel's own secret.
        if (isCalendarPush(request)) return calendarPush(request, env.CALENDAR ? { call: (method, headers) => engineFor({ CALENDAR: env.CALENDAR as never }).call(method, headers) } : null)
        return push.fetch(request, env as never, ctx)
      }
      return parts.team(request, env, ctx)
    },
    /** Cloudflare Email Routing hands a message here (the routing rules name this Worker). Everything decided is packages/inbox/src/cloudflare/entrance.ts. */
    email(message: InboundEmail, env: E, ctx: WaitsUntil): Promise<unknown> {
      return takeEmail(message, { RAW: env.RAW as never, INBOX_MAILBOXES: env.INBOX_MAILBOXES }, storeFor(env as unknown as InboxEnv), ctx)
    },
    /** The delivery reports of Cloudflare's Email Sending (the queue in `queues.consumers` in the Worker's settings). */
    queue(batch: ReportBatch, env: E): Promise<void> {
      return keepReports(batch, storeFor(env as unknown as InboxEnv))
    },
    scheduled(event: { cron?: string }, env: E, ctx: WaitsUntil): void {
      if (event.cron === DAILY_CRON) runDaily(storeFor(env as unknown as InboxEnv), ctx)
      else if (event.cron === FORMS_CRON) ctx.waitUntil(runFormsSweep(env, ctx, install))
      // Any other expression is the five-minute tick: meet's sweep, and the Clients part putting right Forms' copy of each Client's names.
      else ctx.waitUntil(Promise.all([runMeetSweep(env), runClientNamesRepair(env, Date.now, install)]))
    },
  }
}
