import { readFileSync } from 'node:fs'

/**
 * A raw message as Cloudflare hands one over, from test/fixtures/cloudflare, with the line ends it has on the wire.
 *
 * ⚠️ THESE ARE WRITTEN BY HAND to the shape of what Gmail sends (Received hops, DKIM, quoted-printable alternatives, a
 * References chain), from Tessa's own address to a test address: no customer's mail, and no capture from the real
 * route either, because a worktree has no account to send through. The option asks for a capture from a real send
 * to the test address; replacing them is the hand test's first step, and the assertions here are written about the
 * message's content so a captured one can drop in.
 */
export const rawMail = (name: string): string =>
  readFileSync(new URL(`../test/fixtures/cloudflare/${name}.eml`, import.meta.url), 'utf8').replace(/\r?\n/g, '\r\n')
