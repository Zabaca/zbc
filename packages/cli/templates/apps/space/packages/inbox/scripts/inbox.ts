#!/usr/bin/env bun
// The inbox from a terminal, through the install's space host at /agent/inbox, Claude's door on the space. This is how a Claude session works the inbox:
// read the queue, a conversation or a contact, and prepare drafts for the owner.
// Run it by path from any repo, naming the install it works on (packages/workspace/scripts/project-env.ts):
//
//   SPACE_DECLARATION=/path/to/workspace.json bun /path/to/packages/inbox/scripts/inbox.ts queue drafts
//   bun .../inbox.ts draft @draft.json
//
// `inbox.ts` with no arguments prints every command. The logic is in cli.ts; this
// file only supplies the network, files and sops.
//
// Against the real app it decrypts exactly two keys from the install's
// secrets file, INBOX_ACCESS_CLIENT_ID and INBOX_ACCESS_CLIENT_SECRET, which are
// put there from the Access service token's creation (the secret is shown once).
// INBOX_URL names a local run instead (http://localhost:4660), which needs no install and no token.

import { readFileSync } from 'node:fs'
import { createInstall } from '@space/workspace'
import { HOW_TO_NAME_THE_INSTALL, projectEnv, readDeclaration } from '../../workspace/scripts/project-env'
import { runCli } from './cli'

// The space this script works is the one the environment names, never the invented install the package bundles: its agent door is the address unless INBOX_URL names another.
const project = projectEnv()
const doorUrl = project ? createInstall(readDeclaration(project)).agentDoor()?.url : undefined
const wantsHelp = process.argv.length <= 2
if (!wantsHelp && !process.env.INBOX_URL && !doorUrl) {
  console.error(project ? `${project.declaration} declares no door for Claude's script (agent).` : `${HOW_TO_NAME_THE_INSTALL} Or set INBOX_URL for a local run.`)
  process.exit(2)
}

const result = await runCli(process.argv.slice(2), {
  fetch: (url, init) => fetch(url, init),
  readInput: async (spec) =>
    spec === '-' ? Bun.stdin.text() : spec.startsWith('@') ? readFileSync(spec.slice(1), 'utf8') : spec,
  readBytes: async (path) => new Uint8Array(readFileSync(path)),
  env: { ...(doorUrl ? { INBOX_URL: doorUrl } : {}), ...process.env },
  sopsKey: (name) => {
    if (!project) throw new Error(`${name} is not set. ${HOW_TO_NAME_THE_INSTALL}`)
    const out = Bun.spawnSync(['sops', '-d', '--extract', `["${name}"]`, project.secrets])
    if (out.exitCode !== 0) {
      throw new Error(
        `sops could not decrypt ${name} (${out.stderr.toString().trim()}). Set INBOX_ACCESS_CLIENT_ID and INBOX_ACCESS_CLIENT_SECRET, or add them to the install's secrets file.`,
      )
    }
    return out.stdout.toString().trim()
  },
})
console.log(result.output)
process.exit(result.exitCode)
