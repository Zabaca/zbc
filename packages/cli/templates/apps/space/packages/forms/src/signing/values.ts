/** Reading what signers filled in: field values (decrypted) and the signatures they adopted. */
import { decryptText } from '../vault'
import { type AdoptionRow, type CoreDeps, type EnvelopeRow, ctx } from './support'

export async function readValues(d: CoreDeps, envelope: Pick<EnvelopeRow, 'id'>, key: Uint8Array): Promise<Map<string, unknown>> {
  const rows = (await d.db.prepare('SELECT field_id, value_enc FROM field_values WHERE envelope_id = ?').bind(envelope.id).all<{ field_id: string; value_enc: string }>()).results
  const out = new Map<string, unknown>()
  for (const row of rows) out.set(row.field_id, JSON.parse(await decryptText(key, row.value_enc, ctx.fieldValue(envelope.id, row.field_id))))
  return out
}

export const readAdoptions = async (d: CoreDeps, envelopeId: string): Promise<AdoptionRow[]> => (await d.db.prepare('SELECT * FROM signature_adoptions WHERE envelope_id = ?').bind(envelopeId).all<AdoptionRow>()).results
