#!/usr/bin/env bun
// The inbox's VAPID key: the key pair every notification is signed with (src/notify/webpush.ts). Run on the operator's machine, which decrypts the secrets file:
//
//   bun packages/inbox/scripts/vapid-key.ts production   make it and write it into the production secrets file
//   bun packages/inbox/scripts/vapid-key.ts public       print the public half of the key the secrets file holds
//   bun packages/inbox/scripts/vapid-key.ts dev          make a dev key in packages/inbox/.dev.vars (gitignored)
//
// `production` and `public` work the secrets file of the install the environment names: SPACE_DECLARATION, with SPACE_SECRETS or the secrets.yaml beside it (packages/workspace/scripts/project-env.ts), or
// INBOX_SOPS_FILE, which names the file directly (an absolute path). Nothing falls back to a company's file.
//
// `production` writes INBOX_VAPID_KEY through `sops set --value-stdin`, so the private key is never printed, never
// on a command line and never in a file in the clear; it prints only the public half. It refuses when the file
// already holds a key, because replacing it turns notifications off on every device until each is turned on again:
// `production --replace` is that, on purpose (packages/inbox/docs/runbooks/inbox-notifications.md). Nothing here deploys: the key
// reaches the Worker on the next apply of the install.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { HOW_TO_NAME_THE_INSTALL, projectEnv } from '../../workspace/scripts/project-env'
import { generateVapidKey, parseVapidKey } from '../src/notify/webpush'

/** The secret's name, in secrets.yaml and in the Worker (src/app.ts Env), one name in both. */
export const VAPID_SECRET = 'INBOX_VAPID_KEY'

export interface VapidPorts {
  generate: () => Promise<string>
  /** The secret as the production file holds it, or null when it holds none. */
  /** The secret as the production file holds it, or null when the file holds none. Throws when sops cannot read the file at all. */
  readSecret: () => string | null
  /** Write the secret into the production file. */
  writeSecret: (value: string) => void
  /** The dev vars file's text, or null when there is none. */
  readDevVars: () => string | null
  writeDevVars: (text: string) => void
}

const USAGE = `Usage: vapid-key.ts production [--replace] | public | dev [--replace]
  production  make the key and write ${VAPID_SECRET} into the production secrets file (prints only the public half)
  public      print the public half of the production key
  dev         make a dev key in packages/inbox/.dev.vars`

/** What the command does, over ports, so a test can run it with no sops and no files. */
export async function runVapidKey(args: string[], ports: VapidPorts): Promise<{ output: string; exitCode: number }> {
  try {
    return await run(args, ports)
  } catch (error) {
    // sops could not decrypt or write the file: say so, and never read it as "no key" (that would write a second one).
    return { output: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }
}

/** sops's word for a key the file does not hold, as opposed to a file it could not read. */
export const SOPS_KEY_ABSENT = /component \[.*\] not found/

async function run(args: string[], ports: VapidPorts): Promise<{ output: string; exitCode: number }> {
  const [command, ...flags] = args
  const replace = flags.includes('--replace')
  const unknown = flags.filter((f) => f !== '--replace')
  if (unknown.length > 0) return { output: USAGE, exitCode: 2 }

  if (command === 'public') {
    const key = parseVapidKey(ports.readSecret())
    return key
      ? { output: key.publicKey, exitCode: 0 }
      : { output: `The production secrets file holds no usable ${VAPID_SECRET}.`, exitCode: 1 }
  }

  if (command === 'production') {
    const held = ports.readSecret()
    if (held !== null && !replace) {
      const key = parseVapidKey(held)
      return {
        output:
          `The production secrets file already holds ${VAPID_SECRET}${key ? ` (public half ${key.publicKey})` : ''}. ` +
          'Replacing it turns notifications off on every device until each is turned on again; ' +
          'run `production --replace` only if that is what you want.',
        exitCode: 1,
      }
    }
    const made = await ports.generate()
    const key = parseVapidKey(made)
    if (!key) return { output: 'The key made was not a P-256 key with both halves. Nothing was written.', exitCode: 1 }
    ports.writeSecret(made)
    return {
      output:
        `${held === null ? 'Wrote' : 'Replaced'} ${VAPID_SECRET} in the production secrets file. Public half:\n${key.publicKey}\n` +
        'It reaches the Worker on the next `bunx @zabaca/zbc apply production`.',
      exitCode: 0,
    }
  }

  if (command === 'dev') {
    const text = ports.readDevVars() ?? ''
    const line = new RegExp(`^${VAPID_SECRET}=.*$`, 'm')
    if (line.test(text) && !replace) {
      return { output: `.dev.vars already holds ${VAPID_SECRET}; \`dev --replace\` makes a new one.`, exitCode: 1 }
    }
    const made = await ports.generate()
    const key = parseVapidKey(made)
    if (!key) return { output: 'The key made was not a P-256 key with both halves. Nothing was written.', exitCode: 1 }
    const entry = `${VAPID_SECRET}='${made}'`
    const next = line.test(text)
      ? text.replace(line, entry)
      : `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${entry}\n`
    ports.writeDevVars(next)
    return { output: `Wrote a dev ${VAPID_SECRET} to .dev.vars. Public half:\n${key.publicKey}`, exitCode: 0 }
  }

  return { output: USAGE, exitCode: 2 }
}

if (import.meta.main) {
  const named = process.env.INBOX_SOPS_FILE ?? projectEnv()?.secrets
  const secretsFile = (): string => {
    if (!named) throw new Error(`${HOW_TO_NAME_THE_INSTALL} Or set INBOX_SOPS_FILE to its sops file.`)
    return named
  }
  const devVars = fileURLToPath(new URL('../.dev.vars', import.meta.url))
  const index = `["${VAPID_SECRET}"]`
  const result = await runVapidKey(process.argv.slice(2), {
    generate: generateVapidKey,
    readSecret: () => {
      const out = Bun.spawnSync(['sops', '-d', '--extract', index, secretsFile()])
      if (out.exitCode === 0) return out.stdout.toString().trim()
      const said = out.stderr.toString().trim()
      if (SOPS_KEY_ABSENT.test(said)) return null
      throw new Error(`sops could not read the production secrets file, so nothing was written: ${said}`)
    },
    writeSecret: (value) => {
      // The value goes on stdin as JSON (a string), never as an argument a process listing would show.
      const out = Bun.spawnSync(['sops', 'set', '--value-stdin', secretsFile(), index], {
        stdin: new TextEncoder().encode(JSON.stringify(value)),
      })
      if (out.exitCode !== 0) throw new Error(`sops could not write ${VAPID_SECRET}: ${out.stderr.toString().trim()}`)
    },
    readDevVars: () => (existsSync(devVars) ? readFileSync(devVars, 'utf8') : null),
    writeDevVars: (text) => writeFileSync(devVars, text, { mode: 0o600 }),
  })
  console.log(result.output)
  process.exit(result.exitCode)
}
