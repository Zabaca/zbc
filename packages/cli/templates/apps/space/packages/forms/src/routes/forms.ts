// The form path's routes. `formRoutes` is the operator's (under /admin/api, behind Access and the Worker's own check): a
// client's forms, the builder's draft and publishing, and reading what a filler answered. `fillerRoutes` is the filler's (under
// /api/s/<token>, the same private link the signer's page uses): the questions, the answers as they are given, files, and
// "make my document". Every handler calls src/forms; the document enters the signing core through its `attachPrepared`.
import type { Hono } from 'hono'
import { readJson, readLimited } from '../body'
import { answersFor, formView, prepareForm, removeFile, saveAnswer, uploadFile, uploadForCopy, uploadForOperator, uploadsForCopy } from '../forms/filler'
import { LIMITS } from '../forms/definition'
import { createForm, getForm, listForms, publish, publishedVersion, saveDraft } from '../forms/store'
import { HTTPException } from 'hono/http-exception'
import type { App, C } from '../http'
import { actorLabel } from '../signing/support'
import { badRequest, notFound } from '../store'
import { core, operator, originOf } from './envelopes'

const now = (c: C) => c.get('deps').now()

export function formRoutes(app: Hono<App>): void {
  app.get('/admin/api/forms', async (c) => c.json(await listForms(c.env.DB, c.req.query('client') ?? null)))

  app.post('/admin/api/forms', async (c) => {
    const body = await readJson(c.req.raw)
    const id = await createForm(c.env.DB, actorLabel(operator(c)), now(c), { clientId: String(body.client_id ?? ''), title: String(body.title ?? '') })
    return c.json(await getForm(c.env.DB, id), 201)
  })

  app.get('/admin/api/forms/:id', async (c) => c.json(await getForm(c.env.DB, c.req.param('id'))))

  // The builder's save: the definition as it stands, a draft until it is published.
  app.put('/admin/api/forms/:id/draft', async (c) => {
    const body = await readJson(c.req.raw, 1024 * 1024)
    await saveDraft(c.env.DB, actorLabel(operator(c)), now(c), c.req.param('id'), body.definition)
    return c.json(await getForm(c.env.DB, c.req.param('id')))
  })

  app.post('/admin/api/forms/:id/publish', async (c) => {
    await publish(c.env.DB, actorLabel(operator(c)), now(c), c.req.param('id'))
    return c.json(await getForm(c.env.DB, c.req.param('id')))
  })

  // One frozen version, for Send's picker to show what will be asked.
  app.get('/admin/api/form-versions/:id', async (c) => {
    const v = await publishedVersion(c.env.DB, c.req.param('id'))
    if (!v) throw notFound('Published form version')
    return c.json({ id: v.row.id, form_id: v.row.form_id, client_id: v.row.client_id, version: v.row.version, definition_hash: v.row.definition_hash, published_at: v.row.published_at, definition: v.def })
  })

  // What a form envelope's filler answered. A sensitive answer is masked: revealing one is the core's route (answers/:question/reveal).
  app.get('/admin/api/envelopes/:id/answers', async (c) => c.json(await answersFor(core(c), operator(c), c.req.param('id'))))

  app.get('/admin/api/envelopes/:id/uploads/:upload', async (c) => {
    const out = await uploadForOperator(core(c), operator(c), c.req.param('id'), c.req.param('upload'), originOf(c))
    return new Response(out.bytes as BodyInit, { headers: { 'content-type': out.type, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.name)}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  })
}

export function fillerRoutes(app: Hono<App>): void {
  app.get('/api/s/:token/form', async (c) => c.json(await formView(core(c), c.req.param('token'))))

  app.put('/api/s/:token/answers/:question', async (c) => {
    const body = await readJson(c.req.raw)
    await saveAnswer(core(c), c.req.param('token'), originOf(c), c.req.param('question'), body.value)
    return c.json({ ok: true })
  })

  // A file is the request body itself (no multipart parser), its name in a header (percent-encoded).
  app.post('/api/s/:token/uploads/:question', async (c) => {
    const bytes = await readLimited(c.req.raw, LIMITS.fileBytes, () => new HTTPException(413, { message: `That file is over ${LIMITS.fileBytes / 1048576} MB, which is the most.` }))
    let name = 'file'
    try {
      name = decodeURIComponent(c.req.header('x-file-name') ?? 'file')
    } catch {
      throw badRequest('The file\'s name could not be read.')
    }
    return c.json({ files: await uploadFile(core(c), c.req.param('token'), originOf(c), c.req.param('question'), { name, bytes }) })
  })

  app.delete('/api/s/:token/uploads/:upload', async (c) => {
    await removeFile(core(c), c.req.param('token'), originOf(c), c.req.param('upload'))
    return c.json({ ok: true })
  })

  // The client's copy addresses read and download what the customer uploaded, on their own private link (never attached to mail).
  app.get('/api/s/:token/uploads', async (c) => c.json(await uploadsForCopy(core(c), c.req.param('token'))))

  app.get('/api/s/:token/uploads/:upload', async (c) => {
    const out = await uploadForCopy(core(c), c.req.param('token'), c.req.param('upload'), originOf(c))
    return new Response(out.bytes as BodyInit, { headers: { 'content-type': out.type, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.name)}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  })

  app.post('/api/s/:token/prepare', async (c) => c.json(await prepareForm(core(c), c.req.param('token'), originOf(c))))
}
