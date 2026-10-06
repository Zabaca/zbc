// Live check of the reminder filter: a real minimalOptions() agent, a real call.
//
//   bun run e2e:reminders
//
// Outside `bun test` because it spends real money, if very little (~$0.0001 on
// Haiku). The unit tests prove the filter drops what it is told to; only this
// proves what the bundled Claude Code actually injects today. Claude Code adds
// reminder types between releases, so this fails on any type it has not seen
// before, which is the moment to decide whether an agent needs that one. It
// also fails if the call's input climbs back toward what the reminders cost.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { minimalOptions, run } from '@zabaca/agent'

/** Every reminder type seen so far, and what it carries. */
const KNOWN = new Map([
  ['environment', 'working directory, platform, shell, OS, guidance on downloaded files'],
  ['model', 'the model name, ID and knowledge cutoff'],
  ['date', "today's date"],
  ['total_tokens_reminder', 'a token budget counter'],
  ['session_context', "the logged-in account's email address"],
  [
    'remote_session_change',
    "a remote session's commit attribution (only when its environment is inherited)",
  ],
])

/** "Reply with exactly: OK" measured 28 input tokens with the filter, 487 without. */
const INPUT_BUDGET = 60

const dir = await mkdtemp(join(tmpdir(), 'zbc-reminders-'))
const log = join(dir, 'seen.json')
const failures: string[] = []

try {
  const out = await run(
    'Reply with exactly: OK',
    minimalOptions({ env: { ZBC_AGENT_REMINDER_LOG: log } }),
  )
  const seen = JSON.parse(await readFile(log, 'utf8').catch(() => '[]')) as Array<{
    type: string
    chars: number
    kept: boolean
  }>
  const input = out.usage?.input_tokens ?? Number.NaN

  console.log(`reply: ${JSON.stringify(out.text)}  stop: ${out.stopReason}  input tokens: ${input}`)
  for (const { type, chars, kept } of seen) {
    console.log(
      `  ${kept ? 'kept   ' : 'dropped'} ${type} (${chars} chars)${KNOWN.has(type) ? '' : '  <- NEW'}`,
    )
  }

  if (out.isError || out.text !== 'OK')
    failures.push(`the agent did not answer: ${JSON.stringify(out.text)}`)
  if (seen.length === 0)
    failures.push('the filter saw nothing: did the plugin load? (needs Claude Code 2.1.291+)')
  if (seen.some((s) => s.kept))
    failures.push('a reminder was kept under the default, which keeps none')
  for (const { type } of seen) {
    if (!KNOWN.has(type))
      failures.push(
        `new reminder type "${type}": decide whether agents need it, then add it to KNOWN`,
      )
  }
  if (!(input <= INPUT_BUDGET))
    failures.push(`${input} input tokens, over the ${INPUT_BUDGET}-token budget`)
} finally {
  await rm(dir, { recursive: true, force: true })
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`)
  process.exit(1)
}
console.log('ok: every injected reminder was dropped, and the call stayed under budget')
