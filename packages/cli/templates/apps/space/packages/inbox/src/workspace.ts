/**
 * Who may come in, from the company layer (packages/workspace) and not from a copy of its check here.
 *
 * The inbox has no address for people and verifies no assertion at all: the space's Worker checks the Access assertion once per request
 * (the layer's `identify`, packages/space/src/app.ts and agent.ts) and the inbox's part runs there, handed the person it named (`SignedIn`, src/space-gate.ts) or, for Claude's door, the service token it
 * verified (src/space-part.ts). What is left here is the inbox's own rule: which role an identity has (`roleFor`).
 *
 * ⚠️ ACCESS PROTECTS A HOSTNAME OR A PATH, NOT A WORKER. The one hostname the inbox answers on, the install's Gmail push host, has no Access application by design and
 * answers one path only, for a Google-signed token (src/push-door.ts, src/gmail/push.ts); it never reaches this rule.
 *
 * The company is the declaration the build bundles (`@inbox/declaration`: the one the space's build names, and the invented install's for tests and dev), the same file that gives Access its
 * allow lists at deploy (the install kit), so the doors and the Worker cannot disagree about who may come in.
 */
import { createInstall, type Identity, type Install, type Person } from '@space/workspace'
import content from '@inbox/content'
import declaration from '@inbox/declaration'
import { type MailboxContent, readMailboxContent } from './mailbox-content'
import { AGENT_PREFIX } from './types'

export type { Install } from '@space/workspace'

/** The install this Worker was built for. Tests and a client's build pass another to the code that takes one. */
export const bundledInstall: Install = createInstall(declaration)

/**
 * The install's mailbox content (each mailbox's assistant persona and spam questions): the file beside the declaration, bundled as the declaration is (`@inbox/content`), read against it. A file that disagrees with the
 * declaration stops the BUILD: packages/space/vite.config.ts reads this same file against this same declaration when it loads, for every install (`readMailboxContent`, src/mailbox-content.ts; packages/space/test/build-checks.test.ts
 * runs the real build on files that disagree), so a bundle is never made from a pair that disagrees. The read here, at the Worker's start, is the second net (a bundle built some other way), and it never answers in a request.
 */
export const bundledContent: MailboxContent = readMailboxContent(content, bundledInstall)

/**
 * Who `vite dev` runs as, and the ONLY way in without a verified assertion.
 * Not a real address, and not one Access could ever issue: a policy is a list of
 * real addresses, so a dev identity that could also be on one would turn a stray
 * dev build into a real account. app.ts admits it only when its `dev` flag is
 * set, and the Worker entry passes `import.meta.env.DEV`, which Vite replaces
 * with the constant `false` in everything built.
 */
export const DEV_IDENTITY = 'dev@localhost'

export type Role = 'owner' | 'agent'
export interface Who {
  role: Role
  /** A person's address, or `agent:` and a token's client id. Stamped on every write. */
  actor: string
}

/**
 * The owner is the install's owner (`Install.owner()`, the first owner the declaration lists, owner.ts): the one person the owner-only acts are (the inbox's ADR 0004 lists them) and whose Claude's script is. `roleFor` names only
 * the owner and the agent; every other person of the install is admitted to the inbox by `personGate` (src/space-gate.ts) once they are on a mailbox, and shown only theirs. The actor is the owner's address, the one the stores compare.
 * The person was named by their sign-in address (`Install.personBySignIn`, in the layer's check), so this is the declaration's owner matched by sign-in.
 */
const ownerOf = (person: Person, install: Install): Who | null =>
  person.address === install.owner().address ? { role: 'owner', actor: person.address } : null

/**
 * Which role a verified identity has, or null for somebody this rule does not name: the install's owner, signing in as the declaration says, is the owner (any other person is not named here: `personGate` admits them by the
 * mailboxes they are on). Claude's token is admitted only where the install has the `claudeScript` switch, and only the one token whose client id is deployed as INBOX_ACCESS_CLIENT_ID.
 */
export function roleFor(identity: Identity, install: Install, env: { INBOX_ACCESS_CLIENT_ID?: string }): Who | null {
  if (identity.kind === 'person') return ownerOf(identity.person, install)
  const agent = (env.INBOX_ACCESS_CLIENT_ID ?? '').trim().toLowerCase()
  if (install.has('claudeScript') && agent !== '' && identity.commonName === agent) {
    return { role: 'agent', actor: `${AGENT_PREFIX}${identity.commonName}` }
  }
  return null
}
