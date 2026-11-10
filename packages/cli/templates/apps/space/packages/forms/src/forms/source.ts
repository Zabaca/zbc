/**
 * The form as a thing to send (`SOURCES.form`, src/sources.ts): a published version pinned to the envelope. Nothing is stored
 * here and no document exists yet; the filler's answers make it (src/forms/filler.ts). What Send needs to check is that the people
 * it names fit the form: one signer for each role.
 */
import type { DraftSource, SourceBuilder } from '../sources'
import type { CoreDeps } from '../signing/support'
import { badRequest } from '../store'
import { hasSensitive } from './definition'
import { publishedVersion } from './store'

/** The people named for a form must be one signer for each of its roles, in order, with those roles. Said in words; null when they fit. */
export function signersProblem(roles: string[], signers: { role?: unknown }[]): string | null {
  if (signers.length !== roles.length) {
    return `This form has ${roles.length} ${roles.length === 1 ? 'signer' : 'signers'} (${roles.join(', then ')}), so name ${roles.length === 1 ? 'one signer' : `${roles.length} signers in that order`}. ${signers.length} ${signers.length === 1 ? 'was' : 'were'} named.`
  }
  // The signature page names each role and the recipients' own roles are what a signer is told, so the two lists are one list.
  const wrong = signers.map((s, i) => ({ i, have: String(s.role ?? '').trim(), want: roles[i]! })).filter((x) => x.have.toLowerCase() !== x.want.toLowerCase())
  if (wrong.length === 0) return null
  return `This form's signers are ${roles.join(', then ')}. Set each signer's Role to that, in that order: ${wrong.map((x) => `signer ${x.i + 1} is "${x.have}" and should be "${x.want}"`).join('; ')}.`
}

/** An edit of a draft's people (PATCH) meets the same checks as sending it: a form's draft keeps one signer for each role. */
export async function checkDraftSigners(d: Pick<CoreDeps, 'db'>, envelopeId: string, recipients: { role?: unknown; kind?: unknown }[]): Promise<void> {
  const e = await d.db.prepare('SELECT kind, form_version_id FROM envelopes WHERE id = ?').bind(envelopeId).first<{ kind: string; form_version_id: string | null }>()
  if (!e || e.kind !== 'form' || !e.form_version_id) return
  const version = await publishedVersion(d.db, e.form_version_id)
  if (!version) return
  const problem = signersProblem(version.def.roles.map((r) => r.name), recipients.filter((r) => r.kind !== 'copy'))
  if (problem) throw badRequest(problem)
}

export const formSource: SourceBuilder = async ({ d, client, signers, spec }) => {
  const id = typeof spec.form_version_id === 'string' ? spec.form_version_id : ''
  const version = id ? await publishedVersion(d.db, id) : null
  if (!version) throw badRequest('Choose a published form to send. A draft is not sent: publish it first.')
  if (version.row.client_id !== client.id) throw badRequest(`That form belongs to another client, not ${client.display_name}.`)
  const problem = signersProblem(version.def.roles.map((r) => r.name), signers)
  if (problem) throw badRequest(problem)
  const draft: DraftSource = { kind: 'form', title: version.def.title, formVersionId: version.row.id, sensitive: hasSensitive(version.def) }
  return draft
}
