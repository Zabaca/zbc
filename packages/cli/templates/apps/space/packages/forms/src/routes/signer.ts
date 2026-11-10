// The signer's routes (under /api/s/<token>): no sign-in, the recipient's private link is the credential. Every request is
// rate limited by the /api/* middleware first; every handler calls the signing core, which resolves the token to one
// recipient and refuses with one plain message when it leads nowhere. Nothing here sets a cookie, so there is nothing for a
// page on another site to ride, and the responses are never cached or sent a referrer.
import type { Hono } from 'hono'
import { fromBase64 } from '../bytes'
import { readJson } from '../body'
import type { App, C } from '../http'
import type { AdoptionKind, AdoptionMethod } from '../vocab'
import { adopt, consent, consentSample, consentTerms, coreFor, decline, downloadFinished, finish, open, saveField, showDocument, signerCertificate, signerView } from '../signing'
import { ownPicture, pictureOf } from '../signing/views'
import { badRequest } from '../store'
import { originOf } from './envelopes'

const core = (c: C) => coreFor(c.env, () => c.get('deps').now(), c.get('deps').install)

/** A signature picture travels as base64 in a JSON body of at most this many bytes (the picture itself is limited further). */
const ADOPT_BODY_MAX = 900 * 1024

export function signerRoutes(app: Hono<App>): void {
  app.use('/api/s/*', async (c, next) => {
    await next()
    c.res.headers.set('cache-control', 'no-store')
    c.res.headers.set('referrer-policy', 'no-referrer')
    c.res.headers.set('x-content-type-options', 'nosniff')
  })

  app.get('/api/s/:token', async (c) => c.json(await signerView(core(c), c.req.param('token'))))

  app.post('/api/s/:token/open', async (c) => {
    await open(core(c), c.req.param('token'), originOf(c))
    return c.json({ ok: true })
  })

  app.post('/api/s/:token/consent', async (c) => {
    await consent(core(c), c.req.param('token'), originOf(c))
    return c.json(await signerView(core(c), c.req.param('token')))
  })

  // The two PDFs of the consent step: the sample the signer opens, and the terms they may save.
  app.get('/api/s/:token/sample.pdf', async (c) => new Response((await consentSample(core(c), c.req.param('token'), originOf(c))) as BodyInit, { headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="sample.pdf"' } }))

  app.get('/api/s/:token/terms.pdf', async (c) => new Response((await consentTerms(core(c), c.req.param('token'))) as BodyInit, { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="terms-for-signing-electronically.pdf"' } }))

  app.get('/api/s/:token/document', async (c) => {
    const doc = await showDocument(core(c), c.req.param('token'), originOf(c))
    return new Response(doc.bytes as BodyInit, { headers: { 'content-type': 'application/pdf', 'x-document-sha256': doc.sha256, 'content-disposition': 'inline; filename="document.pdf"' } })
  })

  app.post('/api/s/:token/adopt', async (c) => {
    const body = await readJson(c.req.raw, ADOPT_BODY_MAX)
    let image: Uint8Array
    try {
      image = fromBase64(String(body.image ?? ''))
    } catch {
      throw badRequest('The picture could not be read')
    }
    await adopt(core(c), c.req.param('token'), originOf(c), { kind: body.kind as AdoptionKind, method: body.method as AdoptionMethod, image, typedText: typeof body.typed_text === 'string' ? body.typed_text : undefined, typedFont: typeof body.typed_font === 'string' ? body.typed_font : undefined })
    return c.json(await signerView(core(c), c.req.param('token')))
  })

  app.put('/api/s/:token/fields/:field', async (c) => {
    const body = await readJson(c.req.raw)
    await saveField(core(c), c.req.param('token'), c.req.param('field'), body.value)
    return c.json({ ok: true })
  })

  app.post('/api/s/:token/finish', async (c) => {
    const body = await readJson(c.req.raw)
    const outcome = await finish(core(c), c.req.param('token'), originOf(c), { intent: body.intent === true })
    return c.json({ outcome })
  })

  app.post('/api/s/:token/decline', async (c) => {
    const body = await readJson(c.req.raw)
    await decline(core(c), c.req.param('token'), originOf(c), body.reason)
    return c.json({ ok: true })
  })

  app.get('/api/s/:token/me/:kind', async (c) => {
    const p = await ownPicture(core(c), c.req.param('token'), c.req.param('kind'))
    return new Response(p.bytes as BodyInit, { headers: { 'content-type': p.type } })
  })

  app.get('/api/s/:token/picture/:recipient/:kind', async (c) => {
    const p = await pictureOf(core(c), c.req.param('token'), c.req.param('recipient'), c.req.param('kind'))
    return new Response(p.bytes as BodyInit, { headers: { 'content-type': p.type } })
  })

  app.get('/api/s/:token/download', async (c) => {
    const out = await downloadFinished(core(c), c.req.param('token'), originOf(c))
    return new Response(out.bytes as BodyInit, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${out.filename}"` } })
  })

  app.get('/api/s/:token/certificate', async (c) => c.json(await signerCertificate(core(c), c.req.param('token'))))
}
