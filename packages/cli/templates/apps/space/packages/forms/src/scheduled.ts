// The Worker's hourly cron (wrangler.jsonc `triggers.crons`, at the top of every hour). It runs the sweep
// (src/signing/sweep.ts): expiry, reminders, sealing again anything stuck, mail a request left pending, and the
// retention purge. Kept apart from index.ts so `bun test` can call it with a recorder in place of the email binding.
import type { Env } from './http'
import { coreFor, sweep } from './signing'
import type { CoreDeps } from './signing'

export async function scheduled(_event: { scheduledTime: number }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, deps: CoreDeps = coreFor(env, Date.now)): Promise<void> {
  const run = sweep(deps).then((r) => {
    // The log line is the only trace a cron run leaves outside the database: counts only, never a name or a body.
    console.log(`[cron] sweep: expired ${r.expired}, reminded ${r.reminded}, resealed ${r.resealed}, mail sent ${r.mailSent}, purged ${r.purged}`)
  })
  ctx.waitUntil(run)
  await run
}
