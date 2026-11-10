/**
 * Run a sample business's mail (the sample mail module in test-support/) through the real spam classifier with the questions the inbox
 * uses, and print each score: the measurement the tests cannot make (their Workers AI is a fake). The runbook's "The spam
 * questions" says when to run it and what to do with the numbers.
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bun packages/inbox/scripts/measure-spam-questions.ts [mailbox address]
 *
 * The account is the one whose Workers AI is asked; the mailbox is one of the bundled sample install's (the default is the one the sample mail is written for). The token needs Workers AI
 * (Account > Workers AI > Read or Edit); an install's deploy token usually does not have it (Cloudflare answers 401). Mail is sent to Cloudflare's model only, as the Worker does on arrival, and nothing is stored.
 */
import { classifyMail } from '../src/cloudflare/spam-check'
import { CLEF_JUNK_THRESHOLD } from '../src/queue'
import { bundledContent } from '../src/workspace'
import { JUNK, KEEP } from '../test-support/shiftlantern-mail'

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
if (!token || !ACCOUNT) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID to the account to ask and CLOUDFLARE_API_TOKEN to a token of it with Workers AI.')
  process.exit(2)
}
const mailbox = process.argv[2] ?? 'hello@shiftlantern.example'

const port = {
  async run(model: string, input: unknown) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${model}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const json = (await res.json()) as { result?: unknown; errors?: unknown }
    if (!res.ok) {
      console.error(`Cloudflare answered ${res.status}: ${JSON.stringify(json.errors)}`)
      process.exit(1)
    }
    return json.result
  },
}

let wrong = 0
for (const [label, list, spam] of [
  ['KEEP', KEEP, false],
  ['JUNK', JUNK, true],
] as const) {
  for (const m of list) {
    const facts = await classifyMail(
      port,
      { from: `${m.name} <${m.from}>`, to: mailbox, subject: m.subject, body: m.body },
      { questions: bundledContent.spamQuestions(mailbox), timeoutMs: 30_000 },
    )
    const isSpam = facts !== null && facts.junk >= CLEF_JUNK_THRESHOLD
    const bad = isSpam !== spam
    if (bad) wrong += 1
    console.log(
      `${label.padEnd(5)} ${m.id.padEnd(32)} ${facts ? `${facts.junk.toFixed(3)} ${facts.category}` : 'not judged'}${bad ? '   <-- WRONG' : ''}`,
    )
  }
}
console.log(
  `\n${wrong} wrong of ${KEEP.length + JUNK.length} at ${CLEF_JUNK_THRESHOLD}. A KEEP over the line is the costly one.`,
)
