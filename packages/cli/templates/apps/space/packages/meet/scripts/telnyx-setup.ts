// One-time setup of the phone line's Telnyx side (docs/adr/0004, section 6). Dry run by default: it READS the account and
// prints what it would change. Run it with the owner, because with --apply it writes to the account and with --buy it spends money
// (a number is a monthly charge).
//
//   bun scripts/telnyx-setup.ts                      dry run: read, report, change nothing
//   bun scripts/telnyx-setup.ts --apply              make the changes (profile, connection, caller name, 911)
//   bun scripts/telnyx-setup.ts --apply --buy        also buy a 626 number if the account has none
//   --buy-another            buy another number even though a 626 number is on the account or an order is still pending
//   --number +1626...        use this number (it must be on the account) instead of finding or buying one
//   --address <email>=<street>|<unit>|<city>|<ST>|<zip>
//                            a person's 911 address, put on the number their 911 calls leave from
//   --site https://space.northfield.example          where Telnyx's webhooks go (default: the install's space; the path is /r/api/phone/webhook)
//
// The install the line is for is the one the environment names (SPACE_DECLARATION: packages/workspace/scripts/project-env.ts). The API key is
// TELNYX_API_KEY in the environment, or else read out of that install's sops secrets file without printing it. Safe to run again: a second run with nothing left to do changes nothing.

import { createInstall } from '@space/workspace'
import { readDeclaration, requireProjectEnv } from '../../workspace/scripts/project-env'
import { cleanAddress } from '../src/phone-model'
import { telnyxHttp } from '../src/telnyx'
import { runSetup } from '../src/telnyx-setup'

const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(`--${name}`)
const values = (name: string): string[] => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1] as string] : []))

const project = (() => {
  try {
    return requireProjectEnv()
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
})()
const install = createInstall(readDeclaration(project))

async function apiKey(): Promise<string> {
  if (process.env.TELNYX_API_KEY) return process.env.TELNYX_API_KEY
  const secrets = project.secrets
  const proc = Bun.spawn(['sops', '-d', '--extract', '["TELNYX_API_KEY"]', secrets], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  if ((await proc.exited) !== 0 || !out.trim()) {
    console.error(`No TELNYX_API_KEY: set it in the environment, or add it to sops first.\n${err.trim().split('\n')[0] ?? ''}`)
    process.exit(2)
  }
  return out.trim()
}

function addresses() {
  return values('address').map((raw) => {
    const [email, rest] = raw.split('=', 2)
    const [street, extended, city, state, zip] = (rest ?? '').split('|')
    const cleaned = cleanAddress({ street, extended, city, state, zip })
    if (!email || !cleaned.ok) {
      console.error(`--address ${email ?? raw}: ${cleaned.ok ? 'needs <email>=<street>|<unit>|<city>|<ST>|<zip>' : cleaned.message}`)
      process.exit(2)
    }
    return { email: email.toLowerCase(), address: cleaned.address }
  })
}

const apply = flag('apply')
const buy = flag('buy')
if (buy && !apply) {
  console.error('--buy needs --apply.')
  process.exit(2)
}
if (flag('buy-another') && !buy) {
  console.error('--buy-another needs --apply --buy.')
  process.exit(2)
}

try {
  const result = await runSetup(telnyxHttp(await apiKey()), {
    apply,
    buy,
    buyAnother: flag('buy-another'),
    number: values('number')[0],
    addresses: addresses(),
    install,
    site: values('site')[0] ?? install.url(),
    log: (line) => console.log(line),
  })
  process.exit(result.todo.some((t) => t.startsWith('The order for')) ? 3 : 0)
} catch (err) {
  console.error(`\nStopped: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
