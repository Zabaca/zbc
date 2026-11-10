/**
 * What the inbox builds from the install's switches (and its mailbox content), as pure functions so a test holds each: the Worker's object wires its ports through these and reads no switch itself.
 *
 * Every feature is a switch any install may turn on (the company layer's ADR 0004). A switch that is off leaves its port empty, so nothing of
 * it runs and nothing of it is reachable: no Google to sign in to, no mail server to sync, no model to ask, no spam check on arrival. The declaration gives the settings a switch needs and refuses
 * the switch without them (packages/workspace/src/declaration.ts), so a port is empty only because its switch is off, never because it was half set up.
 */
import type { Install } from '@space/workspace'
import { type JmapDeclaration, parseJmapDeclared } from './jmap/declared'
import type { MailboxContent } from './mailbox-content'

/** Gmail's credentials: both halves, and only where the Gmail switch is on. Null leaves every Gmail route saying Gmail is not set up. */
export function googleCredentialsFor(
  install: Install,
  id: string | undefined,
  secret: string | undefined,
): { clientId: string; clientSecret: string } | null {
  const clientId = (id ?? '').trim()
  const clientSecret = (secret ?? '').trim()
  return install.has('gmail') && clientId !== '' && clientSecret !== '' ? { clientId, clientSecret } : null
}

/** The mailboxes on the install's own mail server, as the inbox's parser holds them: none unless the `hostedMailboxes` switch is on. */
export function hostedMailboxesFor(install: Install, declared: unknown, ownerEmail: string): JmapDeclaration {
  return install.has('hostedMailboxes') ? parseJmapDeclared(declared, ownerEmail) : { ok: true, mailboxes: [] }
}

/** The key the assistant calls the model with: empty, so there is no model port, unless the `assistant` switch is on. */
export const assistantKeyFor = (install: Install, key: string | undefined): string =>
  install.has('assistant') ? (key ?? '').trim() : ''

/**
 * The spam check's model binding (Workers AI): the binding wherever some mailbox of the install has spam questions in its content (src/mailbox-content.ts), and nothing where none has, so no arrival is judged. The spam check is
 * per mailbox and not the assistant's: it does not read the `assistant` switch (the company layer's ADR 0006), and a mailbox is put to the spam classifier only when its own questions are written and its own switch (the store's, which starts as the
 * declaration's `spamCheck`) is on.
 */
export const spamCheckAiFor = <T>(content: MailboxContent, ai: T | null | undefined): T | null =>
  content.anySpamQuestions() && ai ? ai : null
