/**
 * A Forms client row is a Client's SIGNING SETTINGS (the space's ADR 0021). The Client is the space's: it has a number there, and its name and legal name are
 * written there and nowhere else. Forms keeps a COPY of the two names on the row (`display_name`, `legal_name`), because signing emails, signers' pages and sealed certificates read them there (44 lines in 17 files).
 *
 * THE CLIENTS PART IS THE ONLY WRITER OF THAT COPY. This file is the seam it calls (`FormsClientNames`, in-process in the space's Worker, no assertion): it lists the linked rows, says whether a name can be kept, and writes the copy
 * of one linked row, audited in Forms' own record with the actor. Forms' own routes take no name (src/clients.ts); the two that start a copy (create, and Link) take the names from the Client itself, read through `Env.CLIENTS_READ`.
 *
 * `Env.CLIENTS_READ` is the Clients part's inbox face (the list and one Client, no write), handed in by the space's Worker. Where it is absent (forms' own local Worker has a stand-in; a deploy mid-change has none) the routes that need a
 * Client say Forms cannot read the Clients list, and write nothing.
 */
import { HTTPException } from 'hono/http-exception'
import { CLIENT_LEGAL_NAME_MAX, type Client, type FormsClientNames, type SigningSettings, answered, failed, refused } from '@space/workspace'
import { displayName, text } from './clients'
import type { Env } from './http'
import { type Db, type Row, isoAt } from './records'
import type { ServiceWords } from './service'
import { notFound, update } from './store'

/** Why Forms cannot keep these names as they are, in a sentence a person editing the Client can act on, or null when it can. */
export function namesProblem(names: { name: string; legalName: string | null }): string | null {
  try {
    displayName(names.name)
    if (names.legalName !== null) text(names.legalName, 'Legal name', CLIENT_LEGAL_NAME_MAX)
    return null
  } catch (e) {
    if (!(e instanceof HTTPException)) throw e
    return e.message.replace(/^Display name/, 'The name').replace(/^Legal name/, 'The legal name')
  }
}

/**
 * Why this Client may not have signing, or its names, where the install's Forms sends only for its own company (the declaration's `formsService.ownCompanyOnly`): the signer is told there is no second party, so a business
 * other than the company would be sent as if it were the company. The Client's name must be the company's, and its legal name too wherever it has one. Asked when a row is made or linked and again whenever the Clients part
 * writes a name into a linked row (`check` and `setNames`), so a rename of the company's Client into another business is refused as well. Null for every install that sends for its clients.
 */
export function ownCompanyProblem(service: ServiceWords | undefined, client: { name: string; legalName: string | null }): string | null {
  if (!service?.ownCompanyOnly) return null
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  if (same(client.name, service.company.name) && (client.legalName === null || same(client.legalName, service.company.legalName))) return null
  return `This install's Forms sends only for ${service.company.name}, so signing can be set up only for ${service.company.name}. ${client.name} is another business.`
}

const unavailable = () => new HTTPException(503, { message: 'Forms cannot read the Clients list just now. Nothing was changed.' })

/** One Client by its number, from the Clients part: 404 for a number it does not hold, 503 when it cannot be asked. */
export async function readClient(env: Env, number: number): Promise<Client> {
  if (!env.CLIENTS_READ) throw unavailable()
  let got
  try {
    got = await env.CLIENTS_READ.get(number)
  } catch {
    throw unavailable()
  }
  if (got.ok) return got.value
  if (got.kind === 'refused' && got.reason === 'not-found') throw notFound('Client')
  throw unavailable()
}

/** Every Client the Clients part holds, or null when it cannot be asked (the Forms screens then show the signing settings alone). */
export async function readClients(env: Env): Promise<Client[] | null> {
  if (!env.CLIENTS_READ) return null
  try {
    const got = await env.CLIENTS_READ.list()
    return got.ok ? got.value : null
  } catch {
    return null
  }
}

interface LinkedRow extends Row {
  id: string
  client_number: number
  display_name: string
  legal_name: string
  reply_to: string
}

/** The seam over forms' database, as the space's Worker holds it. `service` is the install's words: with it, a name that would make a signer's words untrue is refused (`ownCompanyProblem`); without it, none is. */
export function createFormsClientNames(d: { db: Db; now: () => number; service?: ServiceWords }): FormsClientNames {
  return {
    async linked() {
      try {
        const rows = (await d.db.prepare('SELECT id, client_number, display_name, legal_name, reply_to FROM clients WHERE client_number IS NOT NULL ORDER BY client_number').all<LinkedRow>()).results
        return answered(rows.map((r): SigningSettings => ({ id: r.id, number: r.client_number, name: r.display_name, legalName: r.legal_name, replyTo: r.reply_to })))
      } catch (e) {
        console.error('forms client names: could not list the linked rows', e)
        return failed('Forms could not list its signing settings.')
      }
    },

    async check(names) {
      const problem = namesProblem(names) ?? ownCompanyProblem(d.service, names)
      return problem === null ? answered(null) : refused('bad-request', problem)
    },

    async setNames(number, names, actor) {
      const problem = namesProblem(names) ?? ownCompanyProblem(d.service, names)
      if (problem !== null) return refused('bad-request', problem)
      try {
        const row = await d.db.prepare('SELECT id, display_name, legal_name FROM clients WHERE client_number = ?').bind(number).first<LinkedRow>()
        if (!row) return refused('not-found', 'No Forms client is linked to that Client.')
        const patch: Row = { display_name: names.name.trim() }
        if (names.legalName !== null) patch.legal_name = names.legalName.trim()
        const changed = Object.entries(patch).some(([k, v]) => row[k] !== v)
        if (changed) await update(d.db, actor, 'clients', row.id, patch, isoAt(d.now()), 'client-names')
        return answered({ changed })
      } catch (e) {
        console.error('forms client names: could not write the names', e)
        return failed('Forms could not write its copy of the names.')
      }
    },
  }
}
