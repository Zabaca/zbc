// Mail in the local Worker: workerd's local `send_email` binding writes each message it is handed to a file under
// .wrangler/tmp/email, which is how an end-to-end test reads the link a signer was emailed.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './server'

export interface LocalMail {
  text: string
  html: string
  at: number
}

/** Every message written so far, oldest first. */
export function localMail(): LocalMail[] {
  const root = join(ROOT, '.wrangler/tmp/email')
  const out: LocalMail[] = []
  // A server that has sent nothing yet (or was stopped before it did) has a folder with no mail in it.
  if (!existsSync(root)) return out
  for (const dir of readdirSync(root)) {
    const texts = join(root, dir, 'email-text')
    if (!existsSync(texts)) continue
    for (const f of readdirSync(texts)) {
      const path = join(texts, f)
      out.push({ text: readFileSync(path, 'utf8'), html: readFileSync(path.replace('email-text', 'email-html').replace(/\.txt$/, '.html'), 'utf8'), at: statSync(path).mtimeMs })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

export const newestMail = (): LocalMail => localMail().at(-1)!

/** The signing link in a message, on the test server's own address. */
export function linkIn(base: string, text: string): string {
  const token = /\/s\/([A-Za-z0-9_-]{43})/.exec(text)?.[1]
  if (!token) throw new Error(`no link in the mail: ${text.slice(0, 300)}`)
  return `${base}/s/${token}`
}

/** The link in the newest message addressed by name ("Hello Alice Example,"). */
export function linkFor(base: string, name: string): string {
  const mail = localMail().filter((m) => m.text.startsWith(`Hello ${name},`) && /\/s\//.test(m.text)).at(-1)
  if (!mail) throw new Error(`no link was emailed to ${name}`)
  return linkIn(base, mail.text)
}
