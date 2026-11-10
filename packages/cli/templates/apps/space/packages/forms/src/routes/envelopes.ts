// The operator's envelope routes (under /admin/api, behind Access and the Worker's own check): list, build a draft from a
// source, edit it, send, remind, cancel, correct a recipient, download, certificate, purge. Every handler calls the signing
// core (src/signing) as the signed-in operator; none writes a row itself.
import type { Hono } from 'hono'
import { readJson } from '../body'
import { checkDraftSigners } from '../forms/source'
import { SOURCES } from '../sources'
import type { App, C } from '../http'
import {
  type Actor,
  type Origin,
  cancel,
  certificateView,
  checkedConversation,
  coreFor,
  correctRecipient,
  createEnvelope,
  envelopeView,
  listEnvelopes,
  mailPreview,
  operatorDownload,
  purgeEnvelope,
  remind,
  revealAnswer,
  send,
  updateDraft,
} from '../signing'
import { loadClient } from '../signing/support'
import { badRequest } from '../store'


export const core = (c: C) => coreFor(c.env, () => c.get('deps').now(), c.get('deps').install)
export const operator = (c: C): Actor => {
  const op = c.get('operator')
  return { kind: 'operator', email: op.email, name: op.name }
}
export const originOf = (c: C): Origin => ({ ip: c.req.header('cf-connecting-ip') ?? null, userAgent: c.req.header('user-agent') ?? null })

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** The fields of a request that describe an envelope's people and schedule, as the core takes them. */
function shape(body: Record<string, unknown>) {
  return {
    title: str(body.title),
    order: body.order === 'parallel' ? ('parallel' as const) : body.order === 'sequential' ? ('sequential' as const) : undefined,
    note: body.note === null ? null : str(body.note),
    expiresInDays: num(body.expires_in_days),
    reminderEveryDays: num(body.reminder_every_days),
    reminderMax: num(body.reminder_max),
    sensitive: typeof body.sensitive === 'boolean' ? body.sensitive : undefined,
    typedOnly: typeof body.typed_only === 'boolean' ? body.typed_only : undefined,
    recipients: Array.isArray(body.recipients) ? (body.recipients as { role: string; name: string; email: string; kind?: 'signer' | 'copy' }[]) : undefined,
  }
}

export function envelopeRoutes(app: Hono<App>): void {
  app.get('/admin/api/envelopes', async (c) => c.json(await listEnvelopes(core(c), { client: c.req.query('client') ?? null, status: c.req.query('status') ?? null })))

  // A draft from a source: `source.type` names the builder in src/sources.ts (the sample today; a form and an uploaded PDF later).
  app.post('/admin/api/envelopes', async (c) => {
    const body = await readJson(c.req.raw)
    const d = core(c)
    const client = await loadClient(d.db, String(body.client_id ?? ''))
    // Refused before anything is built or stored, like a bad source.
    const conversation = checkedConversation(body.conversation)
    const spec = (body.source ?? {}) as Record<string, unknown>
    const build = SOURCES[String(spec.type)]
    if (!build) throw badRequest(`Choose what to send: one of ${Object.keys(SOURCES).join(', ')}`)
    const s = shape(body)
    if (!s.recipients) throw badRequest('Name the recipients')
    const source = await build({ d, client, signers: s.recipients.filter((r) => r.kind !== 'copy'), spec })
    try {
      const e = await createEnvelope(d, operator(c), { clientId: client.id, kind: source.kind, title: s.title ?? source.title, order: s.order, note: s.note, expiresInDays: s.expiresInDays, reminderEveryDays: s.reminderEveryDays, reminderMax: s.reminderMax, recipients: s.recipients, prepared: source.prepared, sourceDocumentId: source.sourceDocumentId, formVersionId: source.formVersionId, sensitive: s.sensitive ?? source.sensitive, typedOnly: s.typedOnly, conversation, details: source.details })
      return c.json(await envelopeView(d, e.id), 201)
    } catch (err) {
      await source.cleanup?.()
      throw err
    }
  })

  app.get('/admin/api/envelopes/:id', async (c) => c.json(await envelopeView(core(c), c.req.param('id'))))

  app.patch('/admin/api/envelopes/:id', async (c) => {
    const d = core(c)
    const s = shape(await readJson(c.req.raw))
    // A form's draft keeps one signer for each of its roles, whether the people come with the send or with an edit.
    if (s.recipients) await checkDraftSigners(d, c.req.param('id'), s.recipients)
    await updateDraft(d, operator(c), c.req.param('id'), s)
    return c.json(await envelopeView(d, c.req.param('id')))
  })

  app.get('/admin/api/envelopes/:id/preview-email', async (c) => c.json(await mailPreview(core(c), c.req.param('id'))))

  app.post('/admin/api/envelopes/:id/send', async (c) => {
    const d = core(c)
    await send(d, operator(c), originOf(c), c.req.param('id'))
    return c.json(await envelopeView(d, c.req.param('id')))
  })

  app.post('/admin/api/envelopes/:id/remind', async (c) => {
    const body = await readJson(c.req.raw)
    const d = core(c)
    const n = await remind(d, operator(c), originOf(c), c.req.param('id'), { recipientId: str(body.recipient_id) })
    return c.json({ reminded: n, ...(await envelopeView(d, c.req.param('id'))) })
  })

  app.post('/admin/api/envelopes/:id/cancel', async (c) => {
    const body = await readJson(c.req.raw)
    const d = core(c)
    await cancel(d, operator(c), originOf(c), c.req.param('id'), String(body.reason ?? ''))
    return c.json(await envelopeView(d, c.req.param('id')))
  })

  app.post('/admin/api/envelopes/:id/recipients/:rid/correct', async (c) => {
    const body = await readJson(c.req.raw)
    const d = core(c)
    await correctRecipient(d, operator(c), originOf(c), c.req.param('id'), c.req.param('rid'), { email: String(body.email ?? ''), name: str(body.name) })
    return c.json(await envelopeView(d, c.req.param('id')))
  })

  app.get('/admin/api/envelopes/:id/finished.pdf', async (c) => {
    const out = await operatorDownload(core(c), operator(c), originOf(c), c.req.param('id'))
    return new Response(out.bytes as BodyInit, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${out.filename}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  })

  app.get('/admin/api/envelopes/:id/certificate', async (c) => c.json(await certificateView(core(c), c.req.param('id'))))

  // Early deletion on the client's instruction, recorded in the audit.
  app.post('/admin/api/envelopes/:id/purge', async (c) => {
    const ok = await purgeEnvelope(core(c), operator(c), c.req.param('id'), 'operator')
    return c.json({ purged: ok })
  })

  app.post('/admin/api/envelopes/:id/answers/:question/reveal', async (c) => c.json({ value: await revealAnswer(core(c), operator(c), originOf(c), c.req.param('id'), c.req.param('question')) }))
}
