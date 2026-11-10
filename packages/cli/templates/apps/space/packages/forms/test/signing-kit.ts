// What the signing tests share: a client, a sample envelope sent through the real admin API, the signer's calls through the
// real public API, and a signer who goes through every step. Drives the app from outside, as a browser or the cron would.
import { PDF } from '@libpdf/core'
import { expect } from 'bun:test'
import type { harness } from './harness'
import { solidPng } from './png'

export type Harness = ReturnType<typeof harness>
export type Recipient = { role: string; name: string; email: string; kind?: 'signer' | 'copy' }

export const ALICE: Recipient = { role: 'Client', name: 'Alice Example', email: 'alice@example.test' }
export const BOB: Recipient = { role: 'CPA', name: 'Bob Preparer', email: 'bob@example.test' }

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

export const png = (r = 20, g = 30, b = 120) => Buffer.from(solidPng(60, 24, [r, g, b])).toString('base64')

export function kit(h: Harness) {
  /** A draft sample envelope for a client, through the admin API. */
  async function draft(opts: { recipients?: Recipient[]; client?: { id: string }; order?: 'sequential' | 'parallel'; extra?: Record<string, unknown> } = {}) {
    const client = opts.client ?? (await h.makeClient({ copy_addresses: ['books@pinecrest.example'] }))
    const r = await h.tessa('POST', '/admin/api/envelopes', { client_id: client.id, source: { type: 'sample' }, recipients: opts.recipients ?? [ALICE, BOB], order: opts.order ?? 'sequential', note: 'Please sign.', ...opts.extra })
    if (r.status !== 201) throw new Error(`draft failed: ${r.status} ${JSON.stringify(r.body)}`)
    return { client, id: r.body.envelope.id as string, view: r.body }
  }

  async function send(id: string) {
    const r = await h.tessa('POST', `/admin/api/envelopes/${id}/send`)
    if (r.status !== 200) throw new Error(`send failed: ${r.status} ${JSON.stringify(r.body)}`)
    return r.body
  }

  const sent = async (opts: Parameters<typeof draft>[0] = {}) => {
    const d = await draft(opts)
    return { ...d, view: await send(d.id) }
  }

  /** The private link a recipient was last emailed. */
  function tokenFor(email: string): string {
    const mails = h.outbox.filter((m) => m.to.email === email)
    for (const m of mails.reverse()) {
      const t = /\/s\/([A-Za-z0-9_-]{43})/.exec(m.text)?.[1]
      if (t) return t
    }
    throw new Error(`no link was emailed to ${email}`)
  }

  const as = (token: string) => (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    h.call(null, method, `/s/api/s/${token}${path}`, body, { headers: { 'cf-connecting-ip': '203.0.113.7', 'user-agent': IPHONE, ...headers } })

  /** A signer who goes through every step: consent, the document, adopt, fill, finish. Returns the outcome. */
  async function signAs(token: string, name = 'Alice Example', opts: { skipFinish?: boolean } = {}) {
    const s = as(token)
    expect((await s('POST', '/open')).status).toBe(200)
    expect((await s('POST', '/consent')).status).toBe(200)
    const view = await s('GET', '')
    expect(view.body.state).toBe('sign')
    expect((await s('GET', '/document')).status).toBe(200)
    expect((await s('POST', '/adopt', { kind: 'signature', method: 'drawn', image: png() })).status).toBe(200)
    expect((await s('POST', '/adopt', { kind: 'initials', method: 'typed', image: png(120, 20, 20), typed_text: 'AE', typed_font: 'Dancing Script' })).status).toBe(200)
    for (const f of view.body.fields) {
      const value = f.type === 'signature' || f.type === 'initials' ? 'adopted' : f.type === 'text' ? name : f.type === 'checkbox' ? true : undefined
      if (value === undefined) continue
      const r = await s('PUT', `/fields/${f.id}`, { value })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    }
    if (opts.skipFinish) return null
    const done = await s('POST', '/finish', { intent: true })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    return done.body.outcome as 'signed' | 'sealing' | 'complete'
  }

  /** The finished PDF a recipient was emailed. */
  function attachment(email: string): Uint8Array {
    const m = h.outbox.find((x) => x.to.email === email && x.attachments?.length)
    if (!m) throw new Error(`no document was attached for ${email}`)
    return new Uint8Array(m.attachments![0]!.content)
  }

  const events = (id: string) => h.sql<{ seq: number; action: string; actor_kind: string; details: string; ip: string | null; device: string | null; doc_hash: string | null }>('SELECT * FROM events WHERE envelope_id = ? ORDER BY seq', id)
  const actions = (id: string) => events(id).map((e) => e.action)
  const text = async (bytes: Uint8Array) => {
    const pdf = await PDF.load(bytes)
    return pdf
      .getPages()
      .map((p) => p.extractText().text)
      .join('\n')
  }
  return { draft, send, sent, tokenFor, as, signAs, attachment, events, actions, text }
}
