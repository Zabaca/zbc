/**
 * Who the operators are, from the company layer (packages/workspace) and not from a list here.
 *
 * An install is a company's declaration (its workspace.json), bundled into the Worker at build time. The same file
 * gives Access its allow list at deploy (the install kit), so the door and the Worker cannot disagree about who may come in. The sign-in check is the
 * layer's `identify`; this file only turns a person of the install into the shape the rest of forms uses.
 *
 * What stays forms' own: "Client (business)", the business a document is sent for. A company's people are the
 * operators; the clients it serves are rows in its database. Forms does not read the `manyClients` switch yet: it
 * always sends for many clients; the switch is read where an install sends under its own name alone.
 *
 * `@forms/declaration` is the declaration file: the one the space's build names (`SPACE_DECLARATION`, which aliases
 * this name too), and the invented install's for tests and dev (tsconfig.json).
 */
import { type Install, type Person, createInstall, mailNameOf } from '@space/workspace'
import declaration from '@forms/declaration'
import type { ServiceWords } from './service'

export type { Install } from '@space/workspace'

/** The install this Worker was built for. Tests and a client's build pass another to the code that takes one. */
export const bundledInstall: Install = createInstall(declaration)

/** A person who may build and send. Today every operator acts for every client. */
export interface Operator {
  email: string
  name: string
  /** What an event or an audit row records as the actor. */
  actor: string
  /** The install's owner. Reads of the Clients list (a Client's names, whether it is archived) are the owner's, as Settings' are (the space's ADR 0021). */
  owner: boolean
}

export const operatorOf = (person: Person, install: Install): Operator => ({ email: person.address, name: person.name, actor: person.address, owner: install.isOwner(person) })

/** Who is told when an envelope completes, is declined or expires: the install's first owner. */
export function noticeTo(install: Install): { email: string; name: string } {
  const owner = install.owner()
  return { email: owner.address, name: owner.name }
}

/**
 * The names the signing service says about itself, from the install (src/service.ts): what it is called, who runs it, where its mail comes from and where a person writes about their information, and the name the
 * install's owner's mail carries (the privacy notice names who tells Claude what to do).
 */
export function serviceWordsOf(install: Install): ServiceWords {
  const s = install.formsService()
  return {
    name: s.name,
    contact: s.contact,
    sender: install.sender('forms'),
    runBy: s.runBy,
    company: { name: install.company.name, legalName: install.company.legalName ?? install.company.name },
    owner: mailNameOf(install.owner()),
    ...(s.ownCompanyOnly ? { ownCompanyOnly: true as const } : {}),
  }
}

/**
 * The install's owner as signing's words say them: the short name refusals and the operator's screens use ("Tessa"), the name a record carries (the certificate's "on the recorded instruction of
 * Tessa Marlow"), and the address an instruction is never accepted from when a message claims it.
 */
export function ownerOf(install: Install): { name: string; mailName: string; address: string } {
  const owner = install.owner()
  return { name: owner.name, mailName: mailNameOf(owner), address: owner.address }
}
