// The Worker's every-5-minutes cron (wrangler.jsonc triggers.crons): tidy the workspace and send the nudges that
// are due. The core only says who is owed one (it never touches the network, and never reads message text into
// the answer); the email goes from here, and the core is told afterwards which were sent, so a send that failed
// is tried again on the next run. Kept apart from index.ts so `bun test` can call it with a recorder in place of
// the email binding.

import type { MeetPartDeps } from './app'
import { nudgeEmail } from './mail'
import { runPhoneChores } from './phone-routes'

export async function runCron(d: MeetPartDeps): Promise<{ sent: number; failed: number }> {
  const now = d.now()
  const ws = d.workspace()
  // Tidy up and ask who is owed a nudge, in one request. The object fills in who has the page open: they are not nudged.
  const due = await ws.sweep(now, [])
  const sent: string[] = []
  let failed = 0
  for (const n of due) {
    try {
      await d.mailer.send(nudgeEmail(n, d.appOrigin, d.install))
      sent.push(n.person)
    } catch (err) {
      failed += 1
      console.error('nudge email failed', err instanceof Error ? err.message : err)
    }
  }
  if (sent.length > 0) await ws.nudgeSent(sent, now)
  // The phone's tidy-up, and its daily look at Telnyx's balance. Never throws.
  await runPhoneChores(d)
  // The only trace a cron run leaves outside storage: counts, no names, no text.
  console.log(`[cron] nudges: ${sent.length} sent, ${failed} failed`)
  return { sent: sent.length, failed }
}
