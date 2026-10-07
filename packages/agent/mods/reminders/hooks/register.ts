// The reminders Claude Code injects for the model on its own — the environment
// block, the model line, the date, a token counter, the account's email address
// and, under a remote session, that session's commit attribution — are dropped
// before they reach the request. Loaded by minimalOptions(); see its
// `keepReminders` option and the package README.
//
// Two variables, both set by minimalOptions() and both read on every call:
//
//   ZBC_AGENT_KEEP_REMINDERS  comma-separated attachment types to let through
//                             (`date,environment`); empty or unset drops them all
//   ZBC_AGENT_REMINDER_LOG    a file to write what was seen to, for the live check
//                             in e2e/reminders.ts; unset writes nothing
import type { EngineInterface, Register } from 'claude-code'

type Seen = { type: string; chars: number; kept: boolean }
const seen: Seen[] = []
// Reminders are rendered concurrently, and each write is the whole log: chained,
// so the last write to land is always the one that holds every entry.
let writing: Promise<void> = Promise.resolve()

async function keptTypes($: EngineInterface): Promise<Set<string>> {
  const raw = (await $.env.get('ZBC_AGENT_KEEP_REMINDERS')) ?? ''
  return new Set(
    raw
      .split(',')
      .map((type) => type.trim())
      .filter((type) => type.length > 0),
  )
}

export const register: Register = (on) => {
  on('prompt.attachment', async ($, e, next) => {
    const kept = (await keptTypes($)).has(e.type)
    const log = await $.env.get('ZBC_AGENT_REMINDER_LOG')
    if (log) {
      seen.push({ type: e.type, chars: e.text.length, kept })
      // A failed write is swallowed: a hook that throws is skipped, and a
      // skipped filter sends the reminder, so logging must never be able to fail it.
      writing = writing
        .then(() => $.fs.write(log, JSON.stringify(seen, null, 2)))
        .catch(() => undefined)
      await writing
    }
    return kept ? next(e) : { text: null }
  })
}
