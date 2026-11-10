// The operator's document routes (under /admin/api, behind Access and the Worker's own check): upload a client's PDF, list and
// read what was uploaded, place fields on it, rename it, delete it. Every handler calls src/documents as the signed-in operator.
//
//   POST   /admin/api/documents?client=<id>   the PDF is the request body. Headers: `x-file-name` (URL-encoded), `x-pdf-password`
//                                              (never in the URL, which would be logged), `x-confirm` ("restrictions,signatures":
//                                              what the operator has already confirmed)
//   GET    /admin/api/documents?client=<id>   { documents, limits }: a client's documents (all clients with no `client`) and the upload limits
//   GET    /admin/api/documents/:id           one, with its inspection, placed fields and what the PDF's own fields offer
//   GET    /admin/api/documents/:id/pdf       the working copy: what the page viewer draws
//   PUT    /admin/api/documents/:id/fields    replace the placed fields (the whole set)
//   PATCH  /admin/api/documents/:id           rename
//   DELETE /admin/api/documents/:id           delete, once no envelope points at it
import type { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { readJson, readLimited } from '../body'
import { documentDetail, deleteDocument, listDocuments, placeFields, readWorkingCopy, renameDocument, uploadDocument } from '../documents'
import type { App } from '../http'
import { LIMITS } from '../pdf/engine'
import { badRequest } from '../store'
import { core, operator } from './envelopes'

/** The most the Worker reads of an upload before refusing it; the engine's own cap (LIMITS.maxBytes) is the one an operator is told. */
const READ_LIMIT = 30 * 1024 * 1024
const tooBig = () => new HTTPException(413, { message: `That file is over the ${READ_LIMIT / 1048576} MB the Worker will read; the most that can be signed here is ${LIMITS.maxBytes / 1048576} MB` })

function decodeHeader(raw: string | undefined): string {
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function documentRoutes(app: Hono<App>): void {
  // The limits travel with the list so the screen says the engine's own numbers (src/pdf/engine.ts is the one place they live).
  app.get('/admin/api/documents', async (c) => c.json({ documents: await listDocuments(core(c), c.req.query('client') ?? null), limits: { maxBytes: LIMITS.maxBytes, maxPages: LIMITS.maxPages } }))

  app.post('/admin/api/documents', async (c) => {
    const clientId = c.req.query('client')
    if (!clientId) throw badRequest('Say which client the document is for')
    const bytes = await readLimited(c.req.raw, READ_LIMIT, tooBig)
    if (bytes.length === 0) throw badRequest('The file is empty')
    const confirm = new Set((c.req.header('x-confirm') ?? '').split(',').map((s) => s.trim()).filter(Boolean))
    const out = await uploadDocument(core(c), operator(c), { clientId, bytes, name: decodeHeader(c.req.header('x-file-name')), password: decodeHeader(c.req.header('x-pdf-password')) || undefined, confirm })
    if (!out.ok) {
      const { ok: _ok, status, ...refusal } = out
      return c.json(refusal, status)
    }
    return c.json(out.document, 201)
  })

  app.get('/admin/api/documents/:id', async (c) => c.json(await documentDetail(core(c), c.req.param('id'))))

  // The viewer's PDF: an operator's read of a client's private document, so never cached and never sniffed.
  app.get('/admin/api/documents/:id/pdf', async (c) => {
    const { bytes } = await readWorkingCopy(core(c), c.req.param('id'))
    return new Response(bytes as BodyInit, { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  })

  app.put('/admin/api/documents/:id/fields', async (c) => {
    const body = await readJson(c.req.raw, 1024 * 1024)
    return c.json(await placeFields(core(c), operator(c), c.req.param('id'), body.fields))
  })

  app.patch('/admin/api/documents/:id', async (c) => {
    const body = await readJson(c.req.raw)
    return c.json(await renameDocument(core(c), operator(c), c.req.param('id'), body.name))
  })

  app.delete('/admin/api/documents/:id', async (c) => {
    await deleteDocument(core(c), operator(c), c.req.param('id'))
    return c.json({ deleted: true })
  })
}
