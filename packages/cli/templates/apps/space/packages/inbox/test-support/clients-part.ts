import { createInboxClients } from '@space/clients/src/inbox'
import { createSpaceClients } from '@space/clients/src/space'
import { harness, OWNER, SOURCE, SOURCE_ACTOR } from '@space/clients/test-support/harness'
import type {
  Client,
  ClientsForInbox,
  ClientsForSpace,
  ExternalClient,
  ExternalFields,
  Install,
  SpaceReply,
} from '@space/workspace'
import type { ListedClient } from '../src/types'
import fixture from '../test/fixtures/client-directory.json'

/**
 * The Clients part, for the inbox's tests: the REAL part (packages/clients) over a real SQLite with the real migrations, handed to the inbox through its inbox face, the way the space's Worker
 * hands it in production (packages/space/src/parts.ts). Not a stand-in for any rule: names, archiving, numbers and a source's gone mark are the part's own. What a test adds is only a way to
 * put Clients in (as northfield.example's sender would, through the source face's store calls) and a way to make the part fail, as a part whose object is down does.
 *
 * `ACME` and `BOLT` are the two Clients every test uses, in the shape a source (northfield.example) says them: a number to keep, names, an admin address and the extra fields its sender names.
 */

/** What northfield.example says of one Client, as the inbox reads it back from the part: the fixture is the fields its sender sends (`extra` under the keys that sender names, and `matchAddress` as the declaration's `suggestByAddressKey` makes it), without the admin address and the archived mark the part adds. */
const FIXTURE = fixture as unknown as Omit<ListedClient, 'adminUrl' | 'archived'>[]
const fixed = (id: number): ListedClient => ({
  ...(FIXTURE.find((c) => c.id === id) as Omit<ListedClient, 'adminUrl' | 'archived'>),
  adminUrl: adminUrlOf(id),
  archived: false,
})

/** The admin address northfield.example's sender gives a Client. */
export const adminUrlOf = (id: number): string => `https://www.northfield.example/admin#client-${id}`

export const ACME = fixed(1)
export const BOLT = fixed(2)

/** A row as the door takes it: the number to keep, the names, the address and the extra fields (an absent one is left out, not sent empty). */
export function fieldsOf(row: ListedClient): ExternalFields {
  return {
    preferredNumber: row.id,
    name: row.name,
    legalName: row.legalEntity,
    url: adminUrlOf(row.id),
    extra: row.extra,
  }
}

export const externalOf = (row: ListedClient): ExternalClient => ({ id: String(row.id), ...fieldsOf(row) })

export class TestClients implements ClientsForInbox {
  private readonly h = harness()
  private readonly face = createInboxClients({ store: this.h.api })
  /** When set, the next reads fail with it, as a part whose object is down does. */
  failure: Error | null = null
  /** How many times it was asked: "caches nothing" is a count. */
  asked = 0

  constructor(rows: readonly ListedClient[] = [ACME, BOLT]) {
    this.send(rows)
  }

  async list(): Promise<SpaceReply<Client[]>> {
    this.asked += 1
    if (this.failure) throw this.failure
    return this.face.list()
  }

  async get(number: number): Promise<SpaceReply<Client>> {
    this.asked += 1
    if (this.failure) throw this.failure
    return this.face.get(number)
  }

  /** The same store through the space's face (Settings), for a test that draws the screens over the real inbox and the real part: the owner makes, edits and archives, as in the Worker. */
  spaceFace(install: Install): ClientsForSpace {
    return createSpaceClients({ store: this.h.api, install })
  }

  /** The source's full send: every row made or brought up to date, and anything else of the source's marked gone (kept). */
  send(rows: readonly ListedClient[]): void {
    const done = this.h.sync(rows.map(externalOf))
    if (!done.ok) throw new Error(`the full send was refused: ${done.error}`)
  }

  /** The source's push of one Client. */
  push(row: ListedClient): void {
    const done = this.h.push(String(row.id), fieldsOf(row))
    if (!done.ok) throw new Error(`the push was refused: ${done.error}`)
  }

  /** A Client made in the space by its owner; its number. */
  make(name: string, legalName: string | null = null): number {
    const made = this.h.make(name, legalName)
    if (!made.ok) throw new Error(`make was refused: ${made.error}`)
    return made.value.number
  }

  archive(number: number): void {
    const done = this.h.store.archive(number, OWNER)
    if (!done.ok) throw new Error(`archive was refused: ${done.error}`)
  }

  /** The owner renames a Client in the space (the part's own edit, at the revision it holds now). */
  rename(number: number, name: string): void {
    const now = this.h.store.get(number)
    if (!now.ok) throw new Error(`no Client ${number}`)
    const done = this.h.store.edit(number, now.value.revision, { name }, OWNER)
    if (!done.ok) throw new Error(`edit was refused: ${done.error}`)
  }

  /** The source says it no longer lists a Client: marked and kept, never removed. */
  gone(row: ListedClient): void {
    const done = this.h.gone(String(row.id))
    if (!done.ok) throw new Error(`gone was refused: ${done.error}`)
  }
}

export { SOURCE, SOURCE_ACTOR }
