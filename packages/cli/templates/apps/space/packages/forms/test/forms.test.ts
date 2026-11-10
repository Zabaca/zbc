// The form path, from outside: the operator builds, saves and publishes a form through the admin API, sends it, the
// filler answers on their link, the document is made from the answers and the agreement text, and it is signed and sealed by the
// signing core as any other. Plus the pure rules (visibility, validation, what is wrong with a definition) with no app at all.
// Real router, real migrations, real PDF engine and seal; Access stood in for by signed assertions, R2 by a bucket that honours
// the customer key, the mail binding by a recorder.
import { beforeEach, describe, expect, test } from 'bun:test'
import { verifyChain } from '../src/events'
import { type FormDefinition, MASKED, answerText, checkAnswer, readDefinition, visibleQuestions } from '../src/forms/definition'
import { fileKind } from '../src/forms/filler'
import { sweep } from '../src/signing'
import { NOON, harness } from './harness'
import { ALICE, BOB, kit } from './signing-kit'

const h = harness()
const k = kit(h)
beforeEach(() => h.reset())

const AGREEMENT = 'We will prepare your 2025 return.\nYou agree to pay our fee of $400, due on delivery.'

const FORM = {
  title: 'Intake and engagement',
  roles: [
    { name: 'Client', fields: [] },
    { name: 'CPA', fields: [{ label: 'PTIN', required: true }] },
  ],
  questions: [
    { id: 'q1', type: 'short', label: 'Full legal name', required: true },
    { id: 'q2', type: 'yesno', label: 'Do you own a business?', required: true },
    { id: 'q3', type: 'short', label: 'Business name', required: true, show: { match: 'all', rules: [{ question: 'q2', op: 'equals', value: 'yes' }] } },
    { id: 'q4', type: 'tin', label: 'Social Security number', required: true },
    { id: 'q5', type: 'file', label: 'Photo ID', required: true, max: 2, fileKinds: ['jpeg', 'png', 'pdf'] },
    { id: 'q6', type: 'statement', label: '', text: 'Please read the terms below.' },
    { id: 'q7', type: 'agreement', label: 'Engagement terms', text: AGREEMENT },
  ],
} as const

describe('the rules, with no app', () => {
  const def = readDefinition(FORM).def

  test('a question shows when the earlier answers say so, and a hidden one has no answer to look at', () => {
    const ids = (a: Record<string, any>) => visibleQuestions(def, a).map((q) => q.id)
    expect(ids({})).not.toContain('q3')
    expect(ids({ q2: false })).not.toContain('q3')
    expect(ids({ q2: true })).toContain('q3')
    // q4 reads nothing of q3, but a rule on a hidden question sees nothing: "answered" is false, "is not" is true.
    const chain = readDefinition({
      title: 't',
      roles: [{ name: 'Client' }],
      questions: [
        { id: 'a', type: 'yesno', label: 'A' },
        { id: 'b', type: 'short', label: 'B', show: { match: 'all', rules: [{ question: 'a', op: 'equals', value: 'yes' }] } },
        { id: 'c', type: 'short', label: 'C', show: { match: 'all', rules: [{ question: 'b', op: 'answered' }] } },
        { id: 'd', type: 'short', label: 'D', show: { match: 'all', rules: [{ question: 'b', op: 'not_equals', value: 'x' }] } },
      ],
    })
    expect(chain.problems).toEqual([])
    const shown = (a: Record<string, any>) => visibleQuestions(chain.def, a).map((q) => q.id)
    expect(shown({ a: false, b: 'stale' })).toEqual(['a', 'd'])
    expect(shown({ a: true, b: 'hello' })).toEqual(['a', 'b', 'c', 'd'])
    expect(shown({ a: true, b: 'x' })).toEqual(['a', 'b', 'c'])
  })

  test('all, any, contains, greater and less, on text, a multiple choice, a number and a date', () => {
    const d = readDefinition({
      title: 't',
      roles: [{ name: 'Client' }],
      questions: [
        { id: 'n', type: 'number', label: 'N' },
        { id: 'm', type: 'multi', label: 'M', options: ['red', 'green', 'blue'] },
        { id: 't', type: 'long', label: 'T' },
        { id: 'when', type: 'date', label: 'When' },
        { id: 'big', type: 'short', label: 'Big', show: { match: 'all', rules: [{ question: 'n', op: 'gt', value: '9' }] } },
        { id: 'small', type: 'short', label: 'Small', show: { match: 'all', rules: [{ question: 'n', op: 'lt', value: '9' }] } },
        { id: 'either', type: 'short', label: 'Either', show: { match: 'any', rules: [{ question: 'm', op: 'contains', value: 'red' }, { question: 't', op: 'contains', value: 'LLC' }] } },
        { id: 'both', type: 'short', label: 'Both', show: { match: 'all', rules: [{ question: 'm', op: 'equals', value: 'red' }, { question: 't', op: 'contains', value: 'llc' }] } },
        { id: 'late', type: 'short', label: 'Late', show: { match: 'all', rules: [{ question: 'when', op: 'gt', value: '2026-01-01' }] } },
      ],
    })
    expect(d.problems).toEqual([])
    const shown = (a: Record<string, any>) => visibleQuestions(d.def, a).map((q) => q.id).filter((i) => ['big', 'small', 'either', 'both', 'late'].includes(i))
    expect(shown({ n: 10 })).toEqual(['big'])
    expect(shown({ n: 3 })).toEqual(['small'])
    expect(shown({ m: ['red'] })).toEqual(['either'])
    expect(shown({ t: 'Acme LLC' })).toEqual(['either'])
    expect(shown({ m: ['red', 'blue'], t: 'Acme llc' })).toEqual(['either', 'both'])
    expect(shown({ when: '2026-10-31' })).toEqual(['late'])
    expect(shown({ when: '2025-10-31' })).toEqual([])
  })

  test('a condition may only look back, so a form can never loop', () => {
    const back = (rule: Record<string, unknown>) =>
      readDefinition({ title: 't', roles: [{ name: 'Client' }], questions: [{ id: 'a', type: 'short', label: 'A', show: { match: 'all', rules: [rule] } }, { id: 'b', type: 'short', label: 'B' }] }).problems
    expect(back({ question: 'b', op: 'answered' }).join(' ')).toContain('earlier question')
    expect(back({ question: 'a', op: 'answered' }).join(' ')).toContain('earlier question')
    expect(back({ question: 'nope', op: 'answered' }).join(' ')).toContain('earlier question')
  })

  test('what is wrong with a definition is said in plain words, all at once', () => {
    const r = readDefinition({
      title: '',
      roles: [{ name: 'Client' }, { name: 'client' }],
      questions: [{ id: 'q1', type: 'choice', label: 'Pick', options: ['only'] }, { id: 'q1', type: 'short', label: 'Again' }, { id: 'q3', type: 'wat', label: 'x' }],
    })
    expect(r.problems.join('\n')).toContain("The form's title is required.")
    expect(r.problems.join('\n')).toContain('Two signer roles share a name.')
    expect(r.problems.join('\n')).toContain('at least two options')
    expect(r.problems.join('\n')).toContain('repeats the id q1')
    expect(r.problems.join('\n')).toContain('unknown type')
    expect(readDefinition({ title: 't', roles: [{ name: 'A' }], questions: [] }, { publish: true }).problems.join(' ')).toContain('at least one question')
    expect(readDefinition({ title: 't', roles: [], questions: [] }).problems.join(' ')).toContain('at least one signer role')
  })

  test('a tax ID number is always sensitive, and an agreement is always required', () => {
    const d = readDefinition({ title: 't', roles: [{ name: 'Client' }], questions: [{ id: 'a', type: 'tin', label: 'SSN', sensitive: false }, { id: 'b', type: 'agreement', label: 'Terms', text: 'x', required: false }] }).def
    expect(d.questions.map((q) => [q.sensitive, q.required])).toEqual([[true, true], [false, true]])
  })

  test('answers are checked by type, and a character the document cannot print is refused with a plain message', () => {
    const q = (type: string, extra: Record<string, unknown> = {}) => readDefinition({ title: 't', roles: [{ name: 'C' }], questions: [{ id: 'a', type, label: 'A', ...extra }] }).def.questions[0]!
    expect(checkAnswer(q('email'), 'A@B.Example')).toEqual({ ok: true, value: 'a@b.example' })
    expect(checkAnswer(q('email'), 'nope')).toMatchObject({ ok: false })
    expect(checkAnswer(q('phone'), '(310) 555-0100')).toMatchObject({ ok: true })
    expect(checkAnswer(q('phone'), '12')).toMatchObject({ ok: false })
    expect(checkAnswer(q('number', { min: 1, max: 10 }), '5')).toEqual({ ok: true, value: 5 })
    expect(checkAnswer(q('number', { min: 1, max: 10 }), 11)).toMatchObject({ ok: false })
    expect(checkAnswer(q('date'), '2026-02-30')).toMatchObject({ ok: false })
    expect(checkAnswer(q('date'), '2026-02-28')).toMatchObject({ ok: true })
    expect(checkAnswer(q('tin'), '123-45-6789')).toMatchObject({ ok: true })
    expect(checkAnswer(q('tin'), '12-3456789')).toMatchObject({ ok: true })
    expect(checkAnswer(q('tin'), '12345')).toMatchObject({ ok: false })
    expect(checkAnswer(q('choice', { options: ['a', 'b'] }), 'c')).toMatchObject({ ok: false })
    expect(checkAnswer(q('multi', { options: ['a', 'b', 'c'] }), ['c', 'a', 'a'])).toEqual({ ok: true, value: ['a', 'c'] })
    expect(checkAnswer(q('short', { max: 5 }), 'abcdef')).toMatchObject({ ok: false })
    expect(checkAnswer(q('short'), 'José Müller')).toMatchObject({ ok: true })
    const cjk = checkAnswer(q('short'), '陈大文')
    expect(cjk).toMatchObject({ ok: false })
    expect((cjk as { reason: string }).reason).toBe('Chinese, Japanese and Korean letters cannot be printed on this document yet. Please write it in English letters.')
    // Latin with its extended and Vietnamese letters, Greek and Cyrillic are printed; what the font cannot draw is refused naming it.
    for (const ok of ['Nguyễn Thị Hằng', 'Łukasz Żółć', 'Dvořák', 'Παπαδόπουλος', 'Иванов Пётр', 'Zoë – “quoted”']) expect(checkAnswer(q('short'), ok), ok).toMatchObject({ ok: true })
    const arabic = checkAnswer(q('long'), 'مرحبا')
    expect((arabic as { reason: string }).reason).toBe('This document cannot print "م". It prints Latin, Greek and Cyrillic letters, so please use those.')
    expect((checkAnswer(q('short'), 'a 😀') as { reason: string }).reason).toContain('cannot print "😀"')
    // The same refusal holds for what an operator writes into a definition, so the PDF never prints a question mark.
    expect(readDefinition({ title: 't', roles: [{ name: 'C' }], questions: [{ id: 'a', type: 'agreement', label: 'Terms', text: '同意 this' }] }).problems.join(' ')).toContain('Chinese')
  })

  test('answers print as a person would write them', () => {
    expect(answerText({ type: 'yesno' }, true)).toBe('Yes')
    expect(answerText({ type: 'date' }, '2026-10-31')).toBe('Oct 31, 2026')
    expect(answerText({ type: 'multi' }, ['a', 'b'])).toBe('a, b')
    expect(MASKED).not.toMatch(/\d/)
  })

  test('a file is known by its first bytes, never its name', () => {
    expect(fileKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('jpeg')
    expect(fileKind(new TextEncoder().encode('%PDF-1.7\n...'))).toBe('pdf')
    expect(fileKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('png')
    expect(fileKind(new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0]))).toBe('heic')
    expect(fileKind(new TextEncoder().encode('<html>'))).toBeNull()
  })
})

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

async function publishedForm(client: { id: string }, definition: unknown = FORM) {
  const made = await h.tessa('POST', '/admin/api/forms', { client_id: client.id, title: 'Intake and engagement' })
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  const id = made.body.form.id as string
  const saved = await h.tessa('PUT', `/admin/api/forms/${id}/draft`, { definition })
  expect(saved.status, JSON.stringify(saved.body)).toBe(200)
  const pub = await h.tessa('POST', `/admin/api/forms/${id}/publish`)
  expect(pub.status, JSON.stringify(pub.body)).toBe(200)
  return { id, version: pub.body.versions[0] as { id: string; version: number; definition_hash: string; published_at: string } }
}

async function sendForm(client: { id: string }, versionId: string, extra: Record<string, unknown> = {}) {
  const r = await h.tessa('POST', '/admin/api/envelopes', { client_id: client.id, source: { type: 'form', form_version_id: versionId }, recipients: [ALICE, BOB], order: 'sequential', ...extra })
  if (r.status !== 201) return { status: r.status, body: r.body }
  const id = r.body.envelope.id as string
  await k.send(id)
  return { status: 201, id, body: r.body }
}

const upload = (token: string, question: string, bytes: Uint8Array, name = 'id.jpg') => h.request({ 'x-file-name': encodeURIComponent(name), 'cf-connecting-ip': '203.0.113.7' }, 'POST', `/s/api/s/${token}/uploads/${question}`, bytes as BodyInit)

/** The filler, from the link to the point their document is ready. */
async function fill(token: string, answers: Record<string, unknown> = {}, opts: { file?: boolean } = {}) {
  const s = k.as(token)
  expect((await s('POST', '/open')).status).toBe(200)
  expect((await s('POST', '/consent')).status).toBe(200)
  const values: Record<string, unknown> = { q1: 'Alice Example', q2: true, q3: "Alice's Bakery", q4: '123-45-6789', q7: true, ...answers }
  for (const [q, value] of Object.entries(values)) {
    const r = await s('PUT', `/answers/${q}`, { value })
    expect(r.status, `${q}: ${JSON.stringify(r.body)}`).toBe(200)
  }
  if (opts.file !== false) expect((await upload(token, 'q5', JPEG)).status).toBe(200)
  return s
}

describe('the clients list the Send screen reads', () => {
  test('a client\'s copy addresses are a list, as on the client\'s own page, so Send can show who is copied', async () => {
    await h.makeClient({ copy_addresses: ['books@pinecrest.example'] })
    const list = await h.tessa('GET', '/admin/api/clients')
    expect(list.body[0].copy_addresses).toEqual(['books@pinecrest.example'])
  })
})

describe('building and publishing', () => {
  test('a form is a draft until published; publishing freezes it and editing starts the next version', async () => {
    const client = await h.makeClient()
    const { id, version } = await publishedForm(client)
    expect(version).toMatchObject({ version: 1 })
    expect(version.definition_hash).toMatch(/^[0-9a-f]{64}$/)
    const first = h.sql<{ definition: string; published_at: string | null }>('SELECT definition, published_at FROM form_versions WHERE id = ?', version.id)[0]!
    expect(first.published_at).not.toBeNull()
    // The database itself refuses a change to what was published.
    expect(() => h.sql("UPDATE form_versions SET definition = '{}' WHERE id = ?", version.id)).toThrow(/never changes/)
    // Editing starts version 2 and leaves version 1 exactly as it was.
    const edit = await h.tessa('GET', `/admin/api/forms/${id}`)
    expect(edit.body.working).toMatchObject({ published: true, version: 1 })
    const changed = { ...edit.body.working.definition, title: 'Intake, revised' }
    const saved = await h.tessa('PUT', `/admin/api/forms/${id}/draft`, { definition: changed })
    expect(saved.body.working).toMatchObject({ published: false, version: 2 })
    expect(saved.body.form.title).toBe('Intake, revised')
    expect(h.sql<{ definition: string }>('SELECT definition FROM form_versions WHERE id = ?', version.id)[0]!.definition).toBe(first.definition)
    // A second save changes the same draft.
    await h.tessa('PUT', `/admin/api/forms/${id}/draft`, { definition: { ...changed, title: 'Intake, revised again' } })
    expect(h.sql('SELECT 1 FROM form_versions WHERE form_id = ?', id)).toHaveLength(2)
    const pub = await h.tessa('POST', `/admin/api/forms/${id}/publish`)
    expect(pub.body.versions.map((v: any) => v.version)).toEqual([2, 1])
    // Nothing left to publish.
    expect((await h.tessa('POST', `/admin/api/forms/${id}/publish`)).status).toBe(409)
    // Every write has its audit row.
    expect(h.sql<{ action: string }>("SELECT action FROM audit WHERE entity IN ('forms', 'form_versions') AND entity_id IN (SELECT id FROM form_versions WHERE form_id = ?1) OR entity_id = ?1 ORDER BY id", id).map((a) => a.action)).toEqual(['create', 'save-draft', 'publish', 'start-draft', 'save-draft', 'publish'])
  })

  test('an unfinished form saves as a draft but cannot be published, and a mistake is explained', async () => {
    const client = await h.makeClient()
    const made = await h.tessa('POST', '/admin/api/forms', { client_id: client.id, title: 'Empty' })
    const id = made.body.form.id
    expect((await h.tessa('POST', `/admin/api/forms/${id}/publish`)).body.error).toContain('at least one question')
    const bad = await h.tessa('PUT', `/admin/api/forms/${id}/draft`, { definition: { title: 'x', roles: [{ name: 'A' }], questions: [{ id: 'q1', type: 'choice', label: 'Pick', options: ['one'] }] } })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('at least two options')
  })

  test('the builder is the operator\'s: no sign-in is refused, and the lists are by client', async () => {
    const client = await h.makeClient()
    await publishedForm(client)
    expect((await h.call(null, 'GET', '/admin/api/forms')).status).toBe(401)
    const list = await h.tessa('GET', `/admin/api/forms?client=${client.id}`)
    expect(list.body).toHaveLength(1)
    expect(list.body[0]).toMatchObject({ title: 'Intake and engagement', client_name: 'Pinecrest', draft: null, published: { version: 1, roles: ['Client', 'CPA'], sensitive: true, questions: 7 } })
    const other = await h.makeClient({ slug: 'other', display_name: 'Other' })
    expect((await h.tessa('GET', `/admin/api/forms?client=${other.id}`)).body).toEqual([])
  })
})

describe('sending a form', () => {
  test('only a published version is sent, to the right client, with one signer for each role', async () => {
    const client = await h.makeClient()
    const { id, version } = await publishedForm(client)
    const draft = await h.tessa('PUT', `/admin/api/forms/${id}/draft`, { definition: { ...FORM, title: 'Next' } })
    expect(draft.status).toBe(200)
    const draftId = draft.body.working.versionId
    const refused = await sendForm(client, draftId)
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('published')
    const other = await h.makeClient({ slug: 'other', display_name: 'Other' })
    expect((await sendForm(other, version.id)).body.error).toContain('another client')
    const wrong = await h.tessa('POST', '/admin/api/envelopes', { client_id: client.id, source: { type: 'form', form_version_id: version.id }, recipients: [ALICE], order: 'sequential' })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error).toContain('2 signers (Client, then CPA)')
    expect(h.sql('SELECT 1 FROM envelopes')).toHaveLength(0)
  })

  test('the envelope is pinned to the version, a form with a private question is delivered by link, and only the filler is emailed', async () => {
    const client = await h.makeClient()
    const { version } = await publishedForm(client)
    const sent = await sendForm(client, version.id)
    expect(sent.status).toBe(201)
    const e = h.sql<{ kind: string; form_version_id: string; sensitive: number; status: string; prepared_key: string | null }>('SELECT * FROM envelopes')[0]!
    expect(e).toMatchObject({ kind: 'form', form_version_id: version.id, sensitive: 1, status: 'sent', prepared_key: null })
    expect(h.outbox.map((m) => m.to.email)).toEqual(['alice@example.test'])
    expect(k.actions(sent.id!)).toEqual(['created', 'sent', 'mailed'])
  })
})

describe('the filler', () => {
  async function started() {
    const client = await h.makeClient({ copy_addresses: ['books@pinecrest.example'] })
    const { version } = await publishedForm(client)
    const sent = await sendForm(client, version.id)
    const token = k.tokenFor('alice@example.test')
    return { client, version, id: sent.id!, token, s: k.as(token) }
  }

  test('sees the form only after consenting, answers one at a time with every answer saved encrypted, and resumes', async () => {
    const { id, token, s } = await started()
    expect((await s('GET', '/form')).body).toEqual({ filler: false })
    await s('POST', '/open')
    expect((await s('PUT', '/answers/q1', { value: 'x' })).status).toBe(410)
    await s('POST', '/consent')
    const view = await s('GET', '/form')
    expect(view.body).toMatchObject({ filler: true, canEdit: true, answers: {} })
    expect(view.body.definition.questions.map((q: any) => q.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'])
    expect((await s('GET', '')).body.state).toBe('preparing')
    expect((await s('PUT', '/answers/q1', { value: '  Alice Example ' })).status).toBe(200)
    expect((await s('PUT', '/answers/q4', { value: '123-45-6789' })).status).toBe(200)
    // Answers rest encrypted and bound to their place.
    const rows = h.sql<{ value_enc: string; question_id: string }>('SELECT * FROM answers')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.value_enc.startsWith('e1.'))).toBe(true)
    expect(JSON.stringify(h.sql('SELECT * FROM answers'))).not.toContain('123-45-6789')
    expect(JSON.stringify(h.sql('SELECT * FROM answers'))).not.toContain('Alice')
    // Coming back to the link later finds them.
    const again = await k.as(token)('GET', '/form')
    expect(again.body.answers).toEqual({ q1: 'Alice Example', q4: '123-45-6789' })
    // An empty value clears an answer. A draft writes no event.
    await s('PUT', '/answers/q1', { value: '' })
    expect((await s('GET', '/form')).body.answers).toEqual({ q4: '123-45-6789' })
    expect(k.actions(id)).not.toContain('answered')
  })

  test('a wrong answer, a made-up question and text the document cannot print are each refused plainly', async () => {
    const { s } = await started()
    await s('POST', '/open')
    await s('POST', '/consent')
    expect((await s('PUT', '/answers/q4', { value: '123' })).body.error).toContain('nine digits')
    expect((await s('PUT', '/answers/q9', { value: 'x' })).status).toBe(400)
    expect((await s('PUT', '/answers/q6', { value: 'x' })).body.error).toContain('text to read')
    expect((await s('PUT', '/answers/q5', { value: 'x' })).body.error).toContain('Upload a file')
    const cjk = await s('PUT', '/answers/q1', { value: '陈大文' })
    expect(cjk.status).toBe(400)
    expect(cjk.body.error).toBe('Chinese, Japanese and Korean letters cannot be printed on this document yet. Please write it in English letters.')
    expect((await s('PUT', '/answers/q7', { value: false })).status).toBe(200)
    expect(h.sql('SELECT 1 FROM answers')).toHaveLength(0)
  })

  test('files are stored encrypted, known by their bytes, limited in kind and number, and can be removed', async () => {
    const { s, token, id } = await started()
    await s('POST', '/open')
    await s('POST', '/consent')
    const html = await upload(token, 'q5', new TextEncoder().encode('<html>'), 'evil.jpg')
    expect(html.status).toBe(400)
    expect(((await html.json()) as any).error).toContain('PDF, a JPEG, a PNG or a HEIC')
    const heic = await upload(token, 'q5', new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0, 0, 0]), 'photo.heic')
    expect(((await heic.json()) as any).error).toContain('JPEG, PNG, PDF')
    expect((await upload(token, 'q5', new Uint8Array(0))).status).toBe(400)
    expect((await upload(token, 'q1', JPEG)).status).toBe(400)
    const one = await upload(token, 'q5', JPEG, '../../etc/passwd/id front.jpg')
    expect(one.status).toBe(200)
    const files = ((await one.json()) as any).files
    expect(files).toEqual([{ id: expect.any(String), name: 'id front.jpg', size: JPEG.length }])
    expect((await upload(token, 'q5', JPEG, 'back.jpg')).status).toBe(200)
    const third = await upload(token, 'q5', JPEG, 'third.jpg')
    expect(third.status).toBe(400)
    expect(((await third.json()) as any).error).toContain('at most 2')
    const rows = h.sql<{ r2_key: string; sha256: string; size: number }>('SELECT * FROM uploads')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    // R2 holds it under the envelope's own key: it opens only with that key.
    const stored = h.files().objects.get(rows[0]!.r2_key)!
    expect(stored.key).toBeDefined()
    expect(await h.files().get(rows[0]!.r2_key).catch((e: Error) => e.message)).toBe('The object was stored with a customer key; none was given')
    await h.request({ 'cf-connecting-ip': '203.0.113.7' }, 'DELETE', `/s/api/s/${token}/uploads/${files[0].id}`)
    expect(h.sql('SELECT 1 FROM uploads')).toHaveLength(1)
    expect(h.files().objects.has(rows[0]!.r2_key)).toBe(false)
    expect((await s('GET', '/form')).body.answers.q5).toHaveLength(1)
    expect(k.actions(id)).not.toContain('answered')
  })

  test('one file cannot exceed the limit, whatever its header says', async () => {
    const { s, token } = await started()
    await s('POST', '/open')
    await s('POST', '/consent')
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    big.set(JPEG)
    expect((await upload(token, 'q5', big)).status).toBe(413)
    expect(h.sql('SELECT 1 FROM uploads')).toHaveLength(0)
  })

  test('another signer\'s link has no form, and cannot answer', async () => {
    const { s, token } = await started()
    await fill(token)
    await s('POST', '/prepare')
    await k.signAs(token)
    const bob = k.as(k.tokenFor('bob@example.test'))
    expect((await bob('GET', '/form')).body).toEqual({ filler: false })
    await bob('POST', '/consent')
    expect((await bob('PUT', '/answers/q1', { value: 'Bob' })).status).toBe(410)
  })

  test('finishing is refused until every shown, required question is answered, and says which', async () => {
    const { s, token, id } = await started()
    await fill(token, { q2: true, q3: '' }, { file: false })
    const r = await s('POST', '/prepare')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('2 questions still need an answer: Business name, Photo ID.')
    expect(k.actions(id)).not.toContain('answered')
    // A hidden question is not asked, so it cannot hold the filler up.
    await s('PUT', '/answers/q2', { value: false })
    expect((await s('POST', '/prepare')).body.error).toBe('One question still needs an answer: Photo ID.')
  })
})

async function prepared() {
  const client = await h.makeClient({ copy_addresses: ['books@pinecrest.example'] })
  const { version } = await publishedForm(client)
  const sent = await sendForm(client, version.id)
  const token = k.tokenFor('alice@example.test')
  const s = await fill(token)
  const r = await s('POST', '/prepare')
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return { client, version, id: sent.id!, token, s, result: r.body }
}

async function documentText(s: ReturnType<typeof k.as>) {
  const res = await s('GET', '/document')
  expect(res.status).toBe(200)
  return k.text(new Uint8Array(await res.res.arrayBuffer()))
}

describe('the signing record', () => {
  test('the answers and the agreement text, word for word, are in the document, with the uploads listed by fingerprint', async () => {
    const { id, s, result } = await prepared()
    expect(result).toMatchObject({ pages: 2, sensitive: true })
    expect((await s('GET', '')).body.state).toBe('sign')
    const text = await documentText(s)
    expect(text).toContain('Intake and engagement')
    expect(text).toContain('Full legal name')
    expect(text).toContain('Alice Example')
    expect(text).toContain("Alice's Bakery")
    expect(text).toContain('123-45-6789')
    expect(text).toContain('Please read the terms below.')
    expect(text).toContain('We will prepare your 2025 return.')
    expect(text).toContain('You agree to pay our fee of $400, due on delivery.')
    expect(text).toContain('The signer checked the box: I agree.')
    // A line break in an agreement is a line break in the document, never a question mark.
    expect(text).toContain('2025 return.\nYou agree')
    expect(text).not.toContain('return.?')
    expect(text).toContain('Uploaded files')
    expect(text).toContain('id.jpg')
    const sha = h.sql<{ sha256: string }>('SELECT sha256 FROM uploads')[0]!.sha256
    expect(text.replace(/\s+/g, '')).toContain(sha)
    expect(text).toContain('Signatures')
    expect(text).toContain('Client: Alice Example')
    expect(text).toContain('CPA: Bob Preparer')
    expect(text).toContain('PTIN')
    // Each signer's fields are on the signature page: the filler signs and dates, the CPA signs, dates and fills the PTIN.
    const fields = h.sql<{ type: string; label: string; recipient: number; page: number }>('SELECT f.type, f.label, r.position AS recipient, f.page FROM fields f JOIN recipients r ON r.id = f.recipient_id ORDER BY r.position, f.y, f.x')
    expect(fields.map((f) => `${f.recipient}:${f.type}`)).toEqual(['1:signature', '1:date', '2:signature', '2:date', '2:text'])
    expect(new Set(fields.map((f) => f.page))).toEqual(new Set([1]))
    // The record: answered (the form version and the agreement's fingerprint, no answer's), then prepared, with the PDF's fingerprint.
    const events = k.events(id).filter((e) => ['answered', 'prepared'].includes(e.action))
    expect(events.map((e) => e.action)).toEqual(['answered', 'prepared'])
    const answered = JSON.parse(events[0]!.details)
    expect(answered).toMatchObject({ form_version: 1, questions: 6, uploads: 1, dropped: 0 })
    expect(answered.definition_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(answered.agreements).toEqual([{ question: 'q7', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(events[1]!.doc_hash).toBe(h.sql<{ prepared_sha256: string }>('SELECT prepared_sha256 FROM envelopes')[0]!.prepared_sha256)
    expect(JSON.stringify(h.sql('SELECT details FROM events'))).not.toContain('123-45-6789')
    expect(JSON.stringify(h.sql('SELECT details FROM events'))).not.toContain('Alice Example\\"')
  })

  test('changing an answer makes the document again, with a new fingerprint and a new event; an answer no longer shown is dropped', async () => {
    const { id, s } = await prepared()
    const before = h.sql<{ prepared_sha256: string }>('SELECT prepared_sha256 FROM envelopes')[0]!.prepared_sha256
    expect((await s('GET', '/form')).body.canEdit).toBe(true)
    await s('PUT', '/answers/q1', { value: 'Alice B. Example' })
    // The document that said the old answers is withdrawn at once: it cannot be shown or finished until it is made again.
    expect((await s('GET', '')).body.state).toBe('preparing')
    expect((await s('GET', '/document')).status).toBe(410)
    expect((await s('POST', '/finish', { intent: true })).status).toBe(410)
    await s('PUT', '/answers/q2', { value: false })
    const r = await s('POST', '/prepare')
    expect(r.status).toBe(200)
    expect(h.sql<{ prepared_sha256: string }>('SELECT prepared_sha256 FROM envelopes')[0]!.prepared_sha256).not.toBe(before)
    expect(k.actions(id).filter((a) => a === 'prepared')).toHaveLength(2)
    // Made, withdrawn by the first change, made again.
    expect(k.actions(id).filter((a) => a === 'answered')).toHaveLength(3)
    const text = await documentText(s)
    expect(text).toContain('Alice B. Example')
    expect(text).not.toContain("Alice's Bakery")
    expect(h.sql<{ question_id: string }>('SELECT question_id FROM answers ORDER BY question_id').map((a) => a.question_id)).not.toContain('q3')
    expect(JSON.parse(k.events(id).filter((e) => e.action === 'answered')[2]!.details)).toMatchObject({ dropped: 1 })
    expect(h.sql("SELECT 1 FROM events WHERE action = 'prepared'")).toHaveLength(2)
    // The log is still one unbroken chain.
    const rows = h.sql<any>('SELECT * FROM events WHERE envelope_id = ? ORDER BY seq', id)
    expect((await verifyChain(rows)).ok).toBe(true)
  })

  test('a file for a question that is no longer shown is dropped with its stored object', async () => {
    const client = await h.makeClient()
    const form = {
      ...FORM,
      questions: FORM.questions.map((q) => (q.id === 'q5' ? { ...q, show: { match: 'all', rules: [{ question: 'q2', op: 'equals', value: 'yes' }] } } : q)),
    }
    const { version } = await publishedForm(client, form)
    await sendForm(client, version.id)
    const token = k.tokenFor('alice@example.test')
    const s = await fill(token)
    const key = h.sql<{ r2_key: string }>('SELECT r2_key FROM uploads')[0]!.r2_key
    await s('PUT', '/answers/q2', { value: false })
    expect((await s('POST', '/prepare')).status).toBe(200)
    expect(h.sql('SELECT 1 FROM uploads')).toHaveLength(0)
    expect(h.files().objects.has(key)).toBe(false)
    expect(await documentText(s)).not.toContain('Uploaded files')
  })

  test('after the filler signs the answers are closed, and the countersigner signs the same document; both get it sealed', async () => {
    const { id, s, token } = await prepared()
    expect(h.outbox.map((m) => m.to.email)).toEqual(['alice@example.test'])
    expect(await k.signAs(token)).toBe('signed')
    expect(h.outbox.map((m) => m.to.email)).toEqual(['alice@example.test', 'bob@example.test'])
    const closed = await s('PUT', '/answers/q1', { value: 'Too late' })
    expect(closed.status).toBe(410)
    expect((await s('POST', '/prepare')).status).toBe(410)
    expect(await k.signAs(k.tokenFor('bob@example.test'), 'PTIN P01234567')).toBe('complete')
    const e = h.sql<{ status: string; finished_sha256: string }>('SELECT status, finished_sha256 FROM envelopes')[0]!
    expect(e.status).toBe('completed')
    expect(k.actions(id)).toEqual(expect.arrayContaining(['created', 'sent', 'opened', 'consented', 'answered', 'prepared', 'signed', 'completed']))
    // A private question made it private: no attachment anywhere, every party got a link.
    const done = h.outbox.filter((m) => /signed and complete/.test(m.subject))
    expect(done).toHaveLength(3)
    for (const m of done) {
      expect(m.attachments).toBeUndefined()
      expect(m.text).toContain('each download is recorded')
    }
    const finished = await k.as(token)('GET', '/download')
    expect(finished.status).toBe(200)
    const text = await k.text(new Uint8Array(await finished.res.arrayBuffer()))
    expect(text).toContain('You agree to pay our fee of $400')
    expect(text).toContain('PTIN P01234567')
    expect(text).toContain('Certificate of completion')
  })

  test('a document with no private answer is attached like any other', async () => {
    const client = await h.makeClient()
    const plain = { ...FORM, questions: FORM.questions.filter((q) => q.id !== 'q4' && q.id !== 'q5') }
    const { version } = await publishedForm(client, plain)
    await sendForm(client, version.id)
    expect(h.sql<{ sensitive: number }>('SELECT sensitive FROM envelopes')[0]!.sensitive).toBe(0)
    const token = k.tokenFor('alice@example.test')
    const s = k.as(token)
    await s('POST', '/open')
    await s('POST', '/consent')
    for (const [q, value] of Object.entries({ q1: 'Alice Example', q2: true, q3: 'Bakery', q7: true })) expect((await s('PUT', `/answers/${q}`, { value })).status).toBe(200)
    expect((await s('POST', '/prepare')).body).toMatchObject({ sensitive: false })
    await k.signAs(token)
    await k.signAs(k.tokenFor('bob@example.test'), 'P1')
    for (const m of h.outbox.filter((m) => /signed and complete/.test(m.subject))) expect(m.attachments).toHaveLength(1)
  })

  test('a mismatch of people and roles after sending is explained rather than breaking', async () => {
    const client = await h.makeClient()
    const { version } = await publishedForm(client)
    const sent = await sendForm(client, version.id)
    const token = k.tokenFor('alice@example.test')
    const s = await fill(token)
    h.sql("DELETE FROM recipients WHERE envelope_id = ? AND position = 2", sent.id!)
    const r = await s('POST', '/prepare')
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('2 signer roles but 1 person was named')
  })
})

describe('what the operator reads', () => {
  async function filled() {
    const client = await h.makeClient()
    const { version } = await publishedForm(client)
    const sent = await sendForm(client, version.id)
    const token = k.tokenFor('alice@example.test')
    const s = await fill(token)
    await s('POST', '/prepare')
    return { id: sent.id!, token, s }
  }

  test('answers are shown, a private one is masked and never decrypted here, and revealing it is an event', async () => {
    const { id } = await filled()
    const r = await h.tessa('GET', `/admin/api/envelopes/${id}/answers`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ form: true, title: 'Intake and engagement', version: { number: 1 }, documentReady: true })
    const byId = Object.fromEntries(r.body.items.map((i: any) => [i.id, i]))
    expect(byId.q1).toMatchObject({ label: 'Full legal name', value: 'Alice Example', sensitive: false, answered: true })
    expect(byId.q2.value).toBe('Yes')
    expect(byId.q4).toMatchObject({ sensitive: true, answered: true, value: null })
    expect(byId.q7.value).toBe('I agree')
    expect(JSON.stringify(r.body)).not.toContain('123-45-6789')
    expect(r.body.uploads).toHaveLength(1)
    // Reveal is the core's route, and it writes the event.
    const reveal = await h.tessa('POST', `/admin/api/envelopes/${id}/answers/q4/reveal`)
    expect(reveal.body.value).toBe('123-45-6789')
    expect(k.actions(id).filter((a) => a === 'sensitive-answer-revealed')).toHaveLength(1)
    expect(JSON.parse(k.events(id).find((e) => e.action === 'sensitive-answer-revealed')!.details)).toEqual({ question_id: 'q4' })
  })

  test('an operator downloads an uploaded file on the record; no sign-in, and a file that is not there, are refused', async () => {
    const { id } = await filled()
    const up = (await h.tessa('GET', `/admin/api/envelopes/${id}/answers`)).body.uploads[0]
    const res = await h.request({ 'cf-access-jwt-assertion': await h.sign({ email: 'tessa@northfield.example' }) }, 'GET', `/admin/api/envelopes/${id}/uploads/${up.id}`)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG)
    expect(res.headers.get('content-disposition')).toContain('id.jpg')
    const ev = k.events(id).filter((e) => e.action === 'copy-downloaded')
    // The event names the file by id and fingerprint, never by name: a timeline can be read with Claude's token.
    expect(JSON.parse(ev[0]!.details)).toEqual({ by: 'operator', upload_id: up.id, sha256: up.sha256 })
    expect(ev[0]!.details).not.toContain('id.jpg')
    expect((await h.call(null, 'GET', `/admin/api/envelopes/${id}/uploads/${up.id}`)).status).toBe(401)
    expect((await h.tessa('GET', `/admin/api/envelopes/${id}/uploads/nope`)).status).toBe(410)
  })

  test('a sample envelope has no answers to read, and a document withdrawn for a changed answer is said so', async () => {
    const { id, s } = await filled()
    const sample = await k.sent({ client: { id: h.sql<{ id: string }>('SELECT id FROM clients')[0]!.id } })
    expect((await h.tessa('GET', `/admin/api/envelopes/${sample.id}/answers`)).body).toEqual({ form: false })
    await s('PUT', '/answers/q1', { value: 'Changed my mind' })
    const r = await h.tessa('GET', `/admin/api/envelopes/${id}/answers`)
    expect(r.body.documentReady).toBe(false)
    expect(r.body.items.find((i: any) => i.id === 'q1').value).toBe('Changed my mind')
  })

  test('Claude\'s token can never read answers, reveal one or take a file', async () => {
    const { id } = await filled()
    const agent = { kind: 'agent' as const, label: 'agent:forms api (claude)', onWordOf: 'tessa@northfield.example' }
    const { answersFor, uploadForOperator } = await import('../src/forms/filler')
    await expect(answersFor(h.core(), agent, id)).rejects.toThrow(/Only an operator/)
    await expect(uploadForOperator(h.core(), agent, id, 'x', {})).rejects.toThrow(/Only an operator/)
  })

  test('retention deletes the answers, the uploads and their stored files with the envelope', async () => {
    const { id, token } = await filled()
    await k.signAs(token)
    await k.signAs(k.tokenFor('bob@example.test'), 'PTIN P0')
    expect(h.sql('SELECT 1 FROM answers')).not.toHaveLength(0)
    const keys = h.sql<{ r2_key: string }>('SELECT r2_key FROM uploads').map((u) => u.r2_key)
    h.sql("UPDATE envelopes SET purge_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", id)
    await sweep(h.core())
    expect(h.sql('SELECT 1 FROM answers')).toHaveLength(0)
    expect(h.sql('SELECT 1 FROM uploads')).toHaveLength(0)
    for (const key of keys) expect(h.files().objects.has(key)).toBe(false)
  })
})

// ── A change after the document was made, and the races around it ─────────────

/** An all-at-once form sent to Alice (the filler) and Bob (the CPA), with Alice's document made, so Bob has a link and may sign now. */
async function parallelPrepared() {
  const client = await h.makeClient()
  const { version } = await publishedForm(client)
  const sent = await sendForm(client, version.id, { order: 'parallel' })
  const token = k.tokenFor('alice@example.test')
  const s = await fill(token)
  expect((await s('POST', '/prepare')).status).toBe(200)
  const bobToken = k.tokenFor('bob@example.test')
  return { id: sent.id!, token, s, bobToken, bob: k.as(bobToken) }
}

/** Runs `before` the next time something is batched into the database, once: another request landing in the middle of this one. */
function beforeNextBatch(before: () => Promise<unknown>) {
  const env = h.env()
  const real = env.DB
  let armed = true
  env.DB = {
    prepare: (sql) => real.prepare(sql),
    batch: async (stmts) => {
      if (armed) {
        armed = false
        env.DB = real
        await before()
      }
      return real.batch(stmts)
    },
  }
}

/** Runs `before` the next time a file is stored under a key that contains `part`, once. */
function beforeNextPut(part: string, before: () => Promise<unknown>) {
  const env = h.env()
  const real = env.FILES
  let armed = true
  env.FILES = {
    put: async (key, value, opts) => {
      if (armed && key.includes(part)) {
        armed = false
        await before()
      }
      return real.put(key, value, opts)
    },
    get: (key, opts) => real.get(key, opts),
    delete: (key) => real.delete(key),
  }
}

const sha = () => h.sql<{ prepared_sha256: string }>('SELECT prepared_sha256 FROM envelopes')[0]!.prepared_sha256
const signedOf = (position: number) => h.sql<{ status: string }>('SELECT status FROM recipients WHERE position = ?', position)[0]!.status
const IP = { 'cf-connecting-ip': '203.0.113.7' }

describe('a file or an answer changed after the document was made', () => {
  test('removing an uploaded file withdraws the document the file was listed in, and its stored file goes only after', async () => {
    const client = await h.makeClient()
    const { version } = await publishedForm(client)
    await sendForm(client, version.id)
    const token = k.tokenFor('alice@example.test')
    const s = await fill(token)
    await s('POST', '/prepare')
    const row = h.sql<{ id: string; r2_key: string; sha256: string }>('SELECT id, r2_key, sha256 FROM uploads')[0]!
    const listed = sha()
    expect((await s('GET', '/document')).status).toBe(200)

    const res = await h.request(IP, 'DELETE', `/s/api/s/${token}/uploads/${row.id}`)
    expect(res.status).toBe(200)
    expect(h.sql('SELECT 1 FROM uploads')).toHaveLength(0)
    expect(h.files().objects.has(row.r2_key)).toBe(false)
    // No document that lists the file is left to sign: it cannot be shown, signed or finished until it is made again.
    expect((await s('GET', '')).body.state).toBe('preparing')
    expect((await s('GET', '/document')).status).toBe(410)
    expect((await s('POST', '/finish', { intent: true })).status).toBe(410)
    expect(h.sql<{ prepared_key: string | null }>('SELECT prepared_key FROM envelopes')[0]!.prepared_key).toBeNull()
    expect([...h.files().objects.keys()].filter((key) => key.includes('/prepared/'))).toHaveLength(0)
    // Making it again needs the file the question requires.
    expect((await s('POST', '/prepare')).body.error).toBe('One question still needs an answer: Photo ID.')
    expect((await upload(token, 'q5', new Uint8Array([...JPEG, 99]), 'id2.jpg')).status).toBe(200)
    expect((await s('POST', '/prepare')).status).toBe(200)
    expect(sha()).not.toBe(listed)
    const again = await documentText(s)
    expect(again).toContain('id2.jpg')
    expect(again.replace(/\s+/g, '')).not.toContain(row.sha256)
    // And the finished, sealed document lists only the file that is there.
    await k.signAs(token)
    await k.signAs(k.tokenFor('bob@example.test'), 'P1')
    const fin = await k.as(token)('GET', '/download')
    const text = await k.text(new Uint8Array(await fin.res.arrayBuffer()))
    expect(text).toContain('id2.jpg')
    expect(text.replace(/\s+/g, '')).not.toContain(row.sha256)
  })

  test('clearing an answer, or adding a file, withdraws the document the same way, in one event each', async () => {
    const { id, s, token } = await prepared()
    const before = k.actions(id).length
    await s('PUT', '/answers/q1', { value: '' })
    expect((await s('GET', '')).body.state).toBe('preparing')
    expect(k.actions(id).slice(before)).toEqual(['answered'])
    expect(JSON.parse(k.events(id).at(-1)!.details)).toMatchObject({ document_withdrawn: true })
    expect((await s('POST', '/finish', { intent: true })).status).toBe(410)
    expect((await s('POST', '/prepare')).body.error).toBe('One question still needs an answer: Full legal name.')
    // Once withdrawn, further changes are drafts again: no event each.
    await s('PUT', '/answers/q1', { value: 'Alice Example' })
    expect(k.actions(id).slice(before)).toEqual(['answered'])
    expect((await s('POST', '/prepare')).status).toBe(200)
    expect((await s('GET', '')).body.state).toBe('sign')
    // A file added to a made document withdraws it too.
    const keep = h.sql<{ id: string }>('SELECT id FROM uploads')[0]!.id
    await h.request(IP, 'DELETE', `/s/api/s/${token}/uploads/${keep}`)
    expect((await s('POST', '/prepare')).status).toBe(400)
    await upload(token, 'q5', new Uint8Array([...JPEG, 7]), 'new.jpg')
    expect((await s('POST', '/prepare')).status).toBe(200)
    expect((await upload(token, 'q5', new Uint8Array([...JPEG, 8]), 'newer.jpg')).status).toBe(200)
    expect((await s('GET', '')).body.state).toBe('preparing')
  })

  test('a change is refused once a signer has signed, and nothing is withdrawn, removed or deleted by the attempt', async () => {
    const { token, s, bobToken } = await parallelPrepared()
    await k.signAs(bobToken, 'P1')
    const row = h.sql<{ id: string; r2_key: string }>('SELECT id, r2_key FROM uploads')[0]!
    const kept = sha()
    expect((await s('PUT', '/answers/q1', { value: 'Too late' })).status).toBe(410)
    expect((await h.request(IP, 'DELETE', `/s/api/s/${token}/uploads/${row.id}`)).status).toBe(410)
    expect((await upload(token, 'q5', new Uint8Array([...JPEG, 5]), 'late.jpg')).status).toBe(410)
    expect((await s('POST', '/prepare')).status).toBe(410)
    expect(h.sql('SELECT 1 FROM uploads')).toHaveLength(1)
    expect(h.files().objects.has(row.r2_key)).toBe(true)
    expect(sha()).toBe(kept)
    expect((await s('GET', '')).body.state).toBe('sign')
  })

  test('removing a file while the CPA finishes: the removal does not apply, so the file stays and the document is the one they signed', async () => {
    const { id, token, s, bobToken, bob } = await parallelPrepared()
    await k.signAs(bobToken, 'P1', { skipFinish: true })
    const row = h.sql<{ id: string; r2_key: string }>('SELECT id, r2_key FROM uploads')[0]!
    const kept = sha()
    // Bob's Finish lands after Alice's request has read the document and before her batch runs.
    beforeNextBatch(async () => expect((await bob('POST', '/finish', { intent: true })).status).toBe(200))
    const res = await h.request(IP, 'DELETE', `/s/api/s/${token}/uploads/${row.id}`)
    expect(res.status).toBe(410)
    expect(h.sql('SELECT 1 FROM uploads')).toHaveLength(1)
    expect(h.files().objects.has(row.r2_key)).toBe(true)
    expect(sha()).toBe(kept)
    expect(h.sql<{ prepared_key: string | null }>('SELECT prepared_key FROM envelopes')[0]!.prepared_key).not.toBeNull()
    expect(signedOf(2)).toBe('signed')
    expect((await s('GET', '')).body.state).toBe('sign')
    expect(k.actions(id).filter((a) => a === 'answered')).toHaveLength(1)
  })

  test('a save while another signer signs does not land on an envelope someone has signed', async () => {
    const { token, s } = await parallelPrepared()
    // Withdraw the document first, so the next save is a plain draft; then Bob's row says signed between the read and the batch.
    await s('PUT', '/answers/q1', { value: 'Alice A. Example' })
    beforeNextBatch(async () => void h.sql("UPDATE recipients SET status = 'signed' WHERE position = 2"))
    const r = await s('PUT', '/answers/q1', { value: 'Should not land' })
    expect(r.status).toBe(410)
    const row = h.sql<{ question_id: string }>('SELECT question_id FROM answers WHERE question_id = ?', 'q1')
    expect(row).toHaveLength(1)
    h.sql("UPDATE recipients SET status = 'sent' WHERE position = 2")
    expect((await k.as(token)('GET', '/form')).body.answers.q1).toBe('Alice A. Example')
  })
})

describe('making the document races a signer', () => {
  test('the CPA finishes while the document is being made again: the new document is not written, and nothing the CPA signed is replaced', async () => {
    const { id, s, bobToken, bob } = await parallelPrepared()
    await k.signAs(bobToken, 'P1', { skipFinish: true })
    const v1 = sha()
    // Bob's Finish lands after the document was laid out and the signers read, before the batch.
    beforeNextPut('/prepared/', async () => {
      expect((await bob('POST', '/finish', { intent: true })).status).toBe(200)
    })
    const r = await s('POST', '/prepare')
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('nothing was changed')
    expect(sha()).toBe(v1)
    expect(signedOf(2)).toBe('signed')
    expect(h.sql('SELECT 1 FROM field_values fv JOIN fields f ON f.id = fv.field_id JOIN recipients r ON r.id = f.recipient_id WHERE r.position = 2').length).toBeGreaterThan(0)
    // Neither event of the lost attempt was written, and the file it stored is gone.
    expect(k.actions(id).filter((a) => a === 'answered')).toHaveLength(1)
    expect(k.actions(id).filter((a) => a === 'prepared')).toHaveLength(1)
    expect([...h.files().objects.keys()].filter((key) => key.includes('/prepared/'))).toHaveLength(1)
  })

  test('the CPA is mid-Finish when the document is made again: the Finish fails instead of signing a document that is gone', async () => {
    const { id, s, bobToken, bob } = await parallelPrepared()
    await k.signAs(bobToken, 'P1', { skipFinish: true })
    const v1 = sha()
    beforeNextBatch(async () => expect((await s('POST', '/prepare')).status).toBe(200))
    const r = await bob('POST', '/finish', { intent: true })
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('changed while you were finishing')
    expect(signedOf(2)).not.toBe('signed')
    expect(sha()).not.toBe(v1)
    expect(k.actions(id).filter((a) => a === 'signed')).toHaveLength(0)
    // The CPA looks at the new document and signs it.
    expect(await k.signAs(bobToken, 'P1')).toBe('signed')
  })

  test('the answers moved while the document was being made: it is not made from the old ones', async () => {
    const client = await h.makeClient()
    const { version } = await publishedForm(client)
    const sent = await sendForm(client, version.id)
    const token = k.tokenFor('alice@example.test')
    const s = await fill(token)
    // Another tab of the filler saves an answer after this request read them and before its batch.
    const other = k.as(token)
    beforeNextPut('/prepared/', async () => {
      expect((await other('PUT', '/answers/q1', { value: 'Changed in another tab' })).status).toBe(200)
    })
    const r = await s('POST', '/prepare')
    expect(r.status).toBe(409)
    expect(k.actions(sent.id!)).not.toContain('answered')
    expect(h.sql<{ prepared_key: string | null }>('SELECT prepared_key FROM envelopes')[0]!.prepared_key).toBeNull()
    // Made again, it says the answer that is saved.
    expect((await s('POST', '/prepare')).status).toBe(200)
    expect(await documentText(s)).toContain('Changed in another tab')
  })

  test('a lost race drops nothing: answers to a question no longer shown stay until a document is made', async () => {
    const client = await h.makeClient()
    const { version } = await publishedForm(client)
    await sendForm(client, version.id)
    const token = k.tokenFor('alice@example.test')
    const s = await fill(token)
    await s('PUT', '/answers/q2', { value: false })
    expect(h.sql('SELECT 1 FROM answers WHERE question_id = ?', 'q3')).toHaveLength(1)
    const other = k.as(token)
    beforeNextPut('/prepared/', async () => void (await other('PUT', '/answers/q1', { value: 'Moved' })))
    expect((await s('POST', '/prepare')).status).toBe(409)
    expect(h.sql('SELECT 1 FROM answers WHERE question_id = ?', 'q3')).toHaveLength(1)
    expect((await s('POST', '/prepare')).status).toBe(200)
    expect(h.sql('SELECT 1 FROM answers WHERE question_id = ?', 'q3')).toHaveLength(0)
  })
})

describe('upload limits hold under a race', () => {
  test('two uploads racing for the last place on a question: one lands, the other is refused and its stored file is removed', async () => {
    const client = await h.makeClient()
    const { version } = await publishedForm(client)
    await sendForm(client, version.id)
    const token = k.tokenFor('alice@example.test')
    const s = k.as(token)
    await s('POST', '/open')
    await s('POST', '/consent')
    expect((await upload(token, 'q5', JPEG, 'one.jpg')).status).toBe(200)
    const e = h.sql<{ id: string; client_id: string }>('SELECT id, client_id FROM envelopes')[0]!
    const alice = h.sql<{ id: string }>('SELECT id FROM recipients WHERE position = 1')[0]!
    // A competing upload lands after this one passed its checks, taking the last place (q5 takes 2).
    beforeNextPut('/uploads/', async () => {
      h.sql("INSERT INTO uploads (id, envelope_id, client_id, recipient_id, question_id, name, content_type, size, sha256, r2_key, created_at) VALUES ('rival', ?, ?, ?, 'q5', 'rival.jpg', 'image/jpeg', 1, 'x', 'envelopes/rival', 'a')", e.id, e.client_id, alice.id)
    })
    const late = await upload(token, 'q5', new Uint8Array([...JPEG, 1]), 'late.jpg')
    expect(late.status).toBe(400)
    expect(((await late.json()) as any).error).toContain('at most 2')
    expect(h.sql<{ name: string }>('SELECT name FROM uploads').map((u) => u.name).sort()).toEqual(['one.jpg', 'rival.jpg'])
    expect([...h.files().objects.keys()].filter((key) => key.includes('/uploads/'))).toHaveLength(1)
  })

  test('ten files in all, whatever the questions say', async () => {
    const client = await h.makeClient()
    const wide = { ...FORM, questions: FORM.questions.map((q) => (q.id === 'q5' ? { ...q, max: undefined } : q)) }
    const { version } = await publishedForm(client, wide)
    await sendForm(client, version.id)
    const token = k.tokenFor('alice@example.test')
    const s = k.as(token)
    await s('POST', '/open')
    await s('POST', '/consent')
    for (let i = 0; i < 10; i++) expect((await upload(token, 'q5', new Uint8Array([...JPEG, i]), `f${i}.jpg`)).status).toBe(200)
    const over = await upload(token, 'q5', new Uint8Array([...JPEG, 99]), 'f10.jpg')
    expect(over.status).toBe(400)
    expect(((await over.json()) as any).error).toContain('At most 10')
    expect(h.sql('SELECT 1 FROM uploads')).toHaveLength(10)
  })
})

describe('text the document prints', () => {
  test('a tab in an answer is a space, never a question mark', async () => {
    expect(checkAnswer(readDefinition(FORM).def.questions[0]!, 'Alice\tExample')).toEqual({ ok: true, value: 'Alice Example' })
    const d = readDefinition({ ...FORM, title: 'Tab\tTitle', questions: [{ id: 'q1', type: 'agreement', label: 'Terms', text: 'one\ttwo' }] })
    expect(d.problems).toEqual([])
    expect(d.def.title).toBe('Tab Title')
    expect(d.def.questions[0]!.text).toBe('one two')
  })

  test('Vietnamese, Polish and Cyrillic names print on the form pages, the signature page and the certificate', async () => {
    const client = await h.makeClient({ display_name: 'Công ty Nguyễn & Łukasz', legal_name: 'Nguyễn Łukasz LLC' })
    const { version } = await publishedForm(client)
    const people = [
      { role: 'Client', name: 'Nguyễn Thị Hằng', email: 'hang@example.test' },
      { role: 'CPA', name: 'Иван Петров', email: 'ivan@example.test' },
    ]
    const made = await h.tessa('POST', '/admin/api/envelopes', { client_id: client.id, source: { type: 'form', form_version_id: version.id }, recipients: people, order: 'sequential' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    await k.send(made.body.envelope.id)
    const token = k.tokenFor('hang@example.test')
    const s = await fill(token, { q1: 'Nguyễn Thị Hằng', q3: 'Tiệm bánh Łukasz Żółć' })
    expect((await s('POST', '/prepare')).status).toBe(200)
    const doc = await documentText(s)
    for (const must of ['Nguyễn Thị Hằng', 'Tiệm bánh Łukasz Żółć', 'Client: Nguyễn Thị Hằng', 'CPA: Иван Петров', 'Công ty Nguyễn & Łukasz']) expect(doc, must).toContain(must)
    await k.signAs(token, 'Nguyễn Thị Hằng')
    await k.signAs(k.tokenFor('ivan@example.test'), 'Иван')
    const fin = await k.as(token)('GET', '/download')
    const text = await k.text(new Uint8Array(await fin.res.arrayBuffer()))
    // The certificate page names each person as the operator typed them.
    expect(text).toContain('Certificate of completion')
    expect(text).toContain('Nguyễn Thị Hằng')
    expect(text).toContain('Иван Петров')
    expect(text).toContain('Công ty Nguyễn & Łukasz')
    expect(text).not.toMatch(/Nguy\?n|\?\?\?/)
  })

  test('a file name the font cannot draw is kept as underscores, so the document and the admin say one name', async () => {
    const { cleanName } = await import('../src/forms/filler')
    expect(cleanName('身份证 front.png')).toBe('___ front.png')
    expect(cleanName('Hằng\u0000/../scan.pdf')).toBe('scan.pdf')
    expect(cleanName('Nguyễn.pdf')).toBe('Nguyễn.pdf')
    expect(cleanName('')).toBe('file')
  })
})

describe("a form's question ids and its signers", () => {
  test('an id is never reused after a question is deleted, across saves and versions', async () => {
    const { addQuestion } = await import('../src/forms/definition')
    let def = readDefinition({ title: 't', roles: [{ name: 'Client' }], questions: [] }).def
    const q = (id: string) => ({ id, type: 'short' as const, label: id, required: true, sensitive: false })
    def = addQuestion(def, q)
    def = addQuestion(def, q)
    expect(def.questions.map((x) => x.id)).toEqual(['q1', 'q2'])
    def = { ...def, questions: [def.questions[0]!] }
    def = addQuestion(def, q)
    expect(def.questions.map((x) => x.id)).toEqual(['q1', 'q3'])
    // The counter travels through a save, so a deleted id stays deleted.
    const saved = readDefinition(JSON.parse(JSON.stringify({ ...def, questions: [def.questions[0]!] }))).def
    expect(addQuestion(saved, q).questions.map((x) => x.id)).toEqual(['q1', 'q4'])
  })

  test('Send must name the form\'s roles, in order, and is told which', async () => {
    const client = await h.makeClient()
    const { version } = await publishedForm(client)
    const send = (recipients: unknown[]) => h.tessa('POST', '/admin/api/envelopes', { client_id: client.id, source: { type: 'form', form_version_id: version.id }, recipients, order: 'sequential' })
    const wrong = await send([ALICE, { role: 'Signer 2', name: 'Bob', email: 'bob@example.test' }])
    expect(wrong.status).toBe(400)
    expect(wrong.body.error).toBe(`This form's signers are Client, then CPA. Set each signer's Role to that, in that order: signer 2 is "Signer 2" and should be "CPA".`)
    expect((await send([BOB, ALICE])).body.error).toContain('signer 1 is "CPA" and should be "Client"')
    expect((await send([ALICE, { ...BOB, role: ' cpa ' }])).status).toBe(201)
    expect(h.sql('SELECT 1 FROM envelopes')).toHaveLength(1)
  })

  test("the signer's page says whether it is a form's, so the questions are asked for only on one", async () => {
    await k.sent()
    expect((await k.as(k.tokenFor('alice@example.test'))('GET', '')).body.kind).toBe('document')
  })
})

describe('a change that changes nothing leaves the document alone', () => {
  test('saving the answer that is already saved, or clearing one that is not there, does not withdraw the document', async () => {
    const { id, s } = await prepared()
    const events = k.actions(id).length
    const kept = sha()
    expect((await s('PUT', '/answers/q1', { value: 'Alice Example' })).status).toBe(200)
    expect((await s('PUT', '/answers/q1', { value: '  Alice Example  ' })).status).toBe(200)
    expect((await s('PUT', '/answers/q2', { value: true })).status).toBe(200)
    expect((await s('PUT', '/answers/q9', { value: '' })).status).toBe(400)
    expect(k.actions(id)).toHaveLength(events)
    expect(sha()).toBe(kept)
    expect((await s('GET', '')).body.state).toBe('sign')
    // A real change still does.
    await s('PUT', '/answers/q1', { value: 'Alice B. Example' })
    expect((await s('GET', '')).body.state).toBe('preparing')
  })

  test('an upload refused because the last place was taken does not withdraw the document', async () => {
    const { id, token, s } = await prepared()
    const e = h.sql<{ id: string; client_id: string }>('SELECT id, client_id FROM envelopes')[0]!
    const alice = h.sql<{ id: string }>('SELECT id FROM recipients WHERE position = 1')[0]!
    // The document lists one file; q5 takes two. A rival takes the second place after this upload passed its checks.
    beforeNextPut('/uploads/', async () => {
      h.sql("INSERT INTO uploads (id, envelope_id, client_id, recipient_id, question_id, name, content_type, size, sha256, r2_key, created_at) VALUES ('rival', ?, ?, ?, 'q5', 'rival.jpg', 'image/jpeg', 1, 'x', 'envelopes/rival', 'a')", e.id, e.client_id, alice.id)
    })
    const kept = sha()
    const events = k.actions(id).length
    const late = await upload(token, 'q5', new Uint8Array([...JPEG, 1]), 'late.jpg')
    expect(late.status).toBe(400)
    expect(sha()).toBe(kept)
    expect(k.actions(id)).toHaveLength(events)
    expect(h.sql<{ prepared_key: string | null }>('SELECT prepared_key FROM envelopes')[0]!.prepared_key).not.toBeNull()
    expect((await s('GET', '')).body.state).toBe('sign')
    expect([...h.files().objects.keys()].filter((key) => key.includes('/uploads/'))).toHaveLength(1)
  })

  test('removing a file that is already gone does not withdraw the document', async () => {
    const { id, token, s } = await prepared()
    const row = h.sql<{ id: string; r2_key: string }>('SELECT id, r2_key FROM uploads')[0]!
    const kept = sha()
    const events = k.actions(id).length
    // The same removal lands first (a double tap): this one finds the row gone when its batch runs.
    beforeNextBatch(async () => void h.sql('DELETE FROM uploads WHERE id = ?', row.id))
    const res = await h.request(IP, 'DELETE', `/s/api/s/${token}/uploads/${row.id}`)
    expect(res.status).toBe(200)
    expect(sha()).toBe(kept)
    expect(k.actions(id)).toHaveLength(events)
    expect(h.sql<{ prepared_key: string | null }>('SELECT prepared_key FROM envelopes')[0]!.prepared_key).not.toBeNull()
    expect((await s('GET', '')).body.state).toBe('sign')
    // And one that was never there.
    expect((await h.request(IP, 'DELETE', `/s/api/s/${token}/uploads/${row.id}`)).status).toBe(200)
    expect(k.actions(id)).toHaveLength(events)
    expect(row.r2_key).toBeTruthy()
  })
})

describe('what an edit of a form draft may name', () => {
  test('a PATCH of the people meets the same checks as a send, so the roles and the count cannot be bypassed', async () => {
    const client = await h.makeClient()
    const { version } = await publishedForm(client)
    const made = await h.tessa('POST', '/admin/api/envelopes', { client_id: client.id, source: { type: 'form', form_version_id: version.id }, recipients: [ALICE, BOB], order: 'sequential' })
    const id = made.body.envelope.id as string
    const patch = (recipients: unknown[]) => h.tessa('PATCH', `/admin/api/envelopes/${id}`, { recipients })
    const one = await patch([ALICE])
    expect(one.status).toBe(400)
    expect(one.body.error).toContain('2 signers (Client, then CPA)')
    const wrong = await patch([ALICE, { role: 'Signer 2', name: 'Bob', email: 'bob@example.test' }])
    expect(wrong.status).toBe(400)
    expect(wrong.body.error).toContain('signer 2 is "Signer 2" and should be "CPA"')
    expect(h.sql('SELECT 1 FROM recipients WHERE envelope_id = ? AND kind = ?', id, 'signer')).toHaveLength(2)
    // The right people, and a change that names none, are fine; so is a copy recipient beside them.
    expect((await patch([ALICE, { ...BOB, email: 'bob2@example.test' }, { role: 'Copy', name: 'Books', email: 'books@example.test', kind: 'copy' }])).status).toBe(200)
    expect((await h.tessa('PATCH', `/admin/api/envelopes/${id}`, { note: 'Hello' })).status).toBe(200)
    // A document envelope is not held to a form's roles.
    const sample = await k.draft({ client })
    expect((await h.tessa('PATCH', `/admin/api/envelopes/${sample.id}`, { recipients: [{ ...ALICE, role: 'Whoever' }, { ...BOB, role: 'Else' }] })).status).toBe(200)
  })
})

describe('reminders while the document is withdrawn', () => {
  test('the filler is still reminded, and the countersigner, who has nothing to sign, is not', async () => {
    const { s } = await parallelPrepared()
    // Bob was emailed with the document; the filler then starts changing an answer, which withdraws it.
    await s('PUT', '/answers/q1', { value: 'Alice A. Example' })
    h.sql("UPDATE envelopes SET reminder_every_days = 1, reminder_max = 3")
    const before = h.outbox.length
    h.setClock(NOON + 2 * 86_400_000)
    expect((await sweep(h.core())).reminded).toBe(1)
    expect(h.outbox.slice(before).map((m) => m.to.email)).toEqual(['alice@example.test'])
    // Made again, the countersigner is reminded as usual.
    expect((await s('POST', '/prepare')).status).toBe(200)
    h.setClock(NOON + 4 * 86_400_000)
    await sweep(h.core())
    expect(h.outbox.map((m) => m.to.email)).toContain('bob@example.test')
  })
})

// ── The customer's uploads, for the client's copy addresses ───────────────────

const PLAIN = {
  title: 'Photo release',
  roles: [{ name: 'Client', fields: [] }],
  questions: [
    { id: 'q1', type: 'short', label: 'Full legal name', required: true },
    { id: 'q5', type: 'file', label: 'Photo ID', required: false, max: 2, fileKinds: ['jpeg', 'png', 'pdf'] },
    { id: 'q7', type: 'agreement', label: 'Terms', text: 'You agree.' },
  ],
} as const

const BOOKS = 'books@pinecrest.example'
const DAY = 86_400_000

describe('the client\'s copy addresses and the files their customer uploaded', () => {
  /** A form with a private question and one uploaded file, signed by both, for a client whose copy address is BOOKS. */
  async function completeSensitive(client?: { id: string }, extra: Record<string, unknown> = {}) {
    const c = client ?? (await h.makeClient({ copy_addresses: [BOOKS] }))
    const { version } = await publishedForm(c)
    const sent = await sendForm(c, version.id, extra)
    expect(sent.status).toBe(201)
    const alice = k.tokenFor('alice@example.test')
    await fill(alice)
    expect((await k.as(alice)('POST', '/prepare')).status).toBe(200)
    await k.signAs(alice)
    expect(await k.signAs(k.tokenFor('bob@example.test'), 'PTIN P0')).toBe('complete')
    return { client: c, id: sent.id!, books: k.tokenFor(BOOKS), alice }
  }

  /** A form with nothing private, with or without a file, signed by one person. */
  async function completePlain(withFile: boolean, files = 1) {
    const client = await h.makeClient({ copy_addresses: [BOOKS] })
    const { version } = await publishedForm(client, PLAIN)
    const sent = await sendForm(client, version.id, { recipients: [ALICE] })
    expect(sent.status).toBe(201)
    const alice = k.tokenFor('alice@example.test')
    const s = k.as(alice)
    await s('POST', '/open')
    await s('POST', '/consent')
    await s('PUT', '/answers/q1', { value: 'Alice Example' })
    await s('PUT', '/answers/q7', { value: true })
    for (let i = 0; withFile && i < files; i++) expect((await upload(alice, 'q5', JPEG, `passport-scan-${i}.jpg`)).status).toBe(200)
    expect((await s('POST', '/prepare')).status).toBe(200)
    expect(await k.signAs(alice)).toBe('complete')
    return { id: sent.id! }
  }

  const completionTo = (email: string) => h.outbox.find((m) => m.to.email === email && /signed and complete/.test(m.subject))!

  test('the completion email to the client\'s copy address carries the link and a count, and the files are never attached or named', async () => {
    await completeSensitive()
    const mail = completionTo(BOOKS)
    expect(mail.attachments).toBeUndefined()
    expect(mail.text).toMatch(/\/s\/[A-Za-z0-9_-]{43}/)
    expect(mail.text).toContain('The same page lists the file the customer uploaded.')
    expect(mail.text).toContain('each download is recorded')
    for (const secret of ['id.jpg', 'Alice Example', "Alice's Bakery", '123-45-6789', 'Photo ID']) {
      expect(mail.text, secret).not.toContain(secret)
      expect(mail.html, secret).not.toContain(secret)
    }
    // The customer and the countersigner are not the business: their mail does not speak of files.
    for (const email of ['alice@example.test', 'bob@example.test']) expect(completionTo(email).text).not.toContain('uploaded')
  })

  test('a document that goes attached still gets the link, with the count, in the copy address\'s email only', async () => {
    await completePlain(true)
    const mail = completionTo(BOOKS)
    expect(mail.attachments).toHaveLength(1)
    expect(mail.attachments![0]!.type).toBe('application/pdf')
    // One file reads in the singular all the way through.
    expect(mail.text).toContain('The file the customer uploaded is not attached, because it may be private. Use the button to see and download it.')
    expect(mail.text).not.toContain('they may')
    expect(mail.text).toMatch(/\/s\/[A-Za-z0-9_-]{43}/)
    expect(mail.text).toContain('The link works until')
    expect(mail.html).toContain('See the uploaded file')
    expect(mail.text + mail.html).not.toContain('passport-scan')
    // Alice is the customer, not a copy address: the plain attached email, no link.
    const hers = completionTo('alice@example.test')
    expect(hers.attachments).toHaveLength(1)
    expect(hers.text).not.toMatch(/\/s\/[A-Za-z0-9_-]{43}/)
  })

  test('two files read in the plural', async () => {
    await completePlain(true, 2)
    const mail = completionTo(BOOKS)
    expect(mail.text).toContain('The 2 files the customer uploaded are not attached, because they may be private. Use the button to see and download them.')
    expect(mail.html).toContain('See the uploaded files')
    expect(mail.text + mail.html).not.toContain('passport-scan')
  })

  test('a form with no uploads sends the copy address no link at all when the document is attached', async () => {
    await completePlain(false)
    const mail = completionTo(BOOKS)
    expect(mail.attachments).toHaveLength(1)
    expect(mail.text).not.toMatch(/\/s\//)
    expect(mail.text).not.toContain('uploaded')
    expect(mail.html).not.toContain('See the uploaded')
  })

  test('a form with a private question but no upload keeps the old link-only email', async () => {
    const client = await h.makeClient({ copy_addresses: [BOOKS] })
    const { version } = await publishedForm(client, { ...FORM, questions: FORM.questions.map((q) => (q.id === 'q5' ? { ...q, required: false } : q)) })
    await sendForm(client, version.id)
    const alice = k.tokenFor('alice@example.test')
    await fill(alice, {}, { file: false })
    await k.as(alice)('POST', '/prepare')
    await k.signAs(alice)
    await k.signAs(k.tokenFor('bob@example.test'), 'PTIN P0')
    expect(h.sql('SELECT 1 FROM uploads')).toHaveLength(0)
    const mail = completionTo(BOOKS)
    expect(mail.text).toMatch(/\/s\/[A-Za-z0-9_-]{43}/)
    expect(mail.text).not.toContain('uploaded')
  })

  test('the link lists the files and each download is an event, with the recipient and the file\'s fingerprint', async () => {
    const { id, books } = await completeSensitive()
    const list = await k.as(books)('GET', '/uploads')
    expect(list.status).toBe(200)
    expect(list.body.files).toEqual([{ id: expect.any(String), name: 'id.jpg', size: JPEG.length, content_type: 'image/jpeg' }])
    const res = await k.as(books)('GET', `/uploads/${list.body.files[0].id}`)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.res.arrayBuffer())).toEqual(JPEG)
    expect(res.headers.get('content-disposition')).toContain('id.jpg')
    expect(res.headers.get('cache-control')).toBe('no-store')
    await k.as(books)('GET', `/uploads/${list.body.files[0].id}`)
    const downloads = k.events(id).filter((e) => e.action === 'copy-downloaded')
    expect(downloads).toHaveLength(2)
    const sha = h.sql<{ sha256: string }>('SELECT sha256 FROM uploads')[0]!.sha256
    const recipient = h.sql<{ id: string }>('SELECT id FROM recipients WHERE email = ?', BOOKS)[0]!.id
    for (const e of downloads) {
      expect(JSON.parse(e.details)).toEqual({ recipient_id: recipient, upload_id: list.body.files[0].id, sha256: sha })
      expect(e.actor_kind).toBe('recipient')
    }
    // Listing is not a download.
    await k.as(books)('GET', '/uploads')
    expect(k.events(id).filter((e) => e.action === 'copy-downloaded')).toHaveLength(2)
  })

  test('the link works for 90 days after completion and then refuses both the list and the file', async () => {
    const { id, books } = await completeSensitive()
    const upId = (await k.as(books)('GET', '/uploads')).body.files[0].id as string
    h.setClock(NOON + 89 * DAY)
    expect((await k.as(books)('GET', `/uploads/${upId}`)).status).toBe(200)
    h.setClock(NOON + 90 * DAY + 60_000)
    const late = await k.as(books)('GET', `/uploads/${upId}`)
    expect(late.status).toBe(410)
    expect(late.body.error).toContain('run out')
    expect((await k.as(books)('GET', '/uploads')).status).toBe(410)
    expect(k.events(id).filter((e) => e.action === 'copy-downloaded')).toHaveLength(1)
  })

  test('another envelope\'s file is refused, even for the same client and the same copy address, and nothing is logged', async () => {
    const first = await completeSensitive()
    const books1 = first.books
    const mine = (await k.as(books1)('GET', '/uploads')).body.files[0].id as string
    // A second envelope for the same client, to the same people; its own link for the same copy address.
    h.outbox.length = 0
    const second = await completeSensitive(first.client)
    const books2 = second.books
    expect(books2).not.toBe(books1)
    const theirs = (await k.as(books2)('GET', '/uploads')).body.files[0].id as string
    expect(theirs).not.toBe(mine)
    expect((await k.as(books1)('GET', `/uploads/${theirs}`)).status).toBe(410)
    expect((await k.as(books2)('GET', `/uploads/${mine}`)).status).toBe(410)
    expect((await k.as(books1)('GET', '/uploads/nope')).status).toBe(410)
    expect(k.events(first.id).filter((e) => e.action === 'copy-downloaded')).toHaveLength(0)
    expect(k.events(second.id).filter((e) => e.action === 'copy-downloaded')).toHaveLength(0)
  })

  test('only the client\'s own copy addresses: the customer, the countersigner and another copy recipient are refused', async () => {
    const other = { role: 'Copy', name: 'Other', email: 'other@example.test', kind: 'copy' as const }
    const { alice, books } = await completeSensitive(undefined, { recipients: [ALICE, BOB, other] })
    const id = (await k.as(books)('GET', '/uploads')).body.files[0].id as string
    for (const token of [alice, k.tokenFor('bob@example.test'), k.tokenFor('other@example.test')]) {
      expect((await k.as(token)('GET', '/uploads')).body).toEqual({ files: [] })
      expect((await k.as(token)('GET', `/uploads/${id}`)).status).toBe(410)
    }
    expect(completionTo('other@example.test').text).not.toContain('uploaded')
    expect(h.sql("SELECT 1 FROM events WHERE action = 'copy-downloaded'")).toHaveLength(0)
    // A made-up link leads nowhere, with the one message every dead link gets.
    expect((await k.as('A'.repeat(43))('GET', `/uploads/${id}`)).status).toBe(404)
  })

  test('Claude\'s token cannot use it: the admin route refuses a service token, an agent has no path, and a service token is no link', async () => {
    const { id, books } = await completeSensitive()
    const upId = (await k.as(books)('GET', '/uploads')).body.files[0].id as string
    const service = { common_name: 'abc.access' }
    expect((await h.call(service, 'GET', `/admin/api/envelopes/${id}/uploads/${upId}`)).status).toBe(403)
    expect((await h.call(service, 'GET', `/admin/api/envelopes/${id}`)).status).toBe(403)
    // The same assertion carried to the public route is no credential there: only a recipient's own link is.
    const asService = await h.call(service, 'GET', `/s/api/s/${'B'.repeat(43)}/uploads/${upId}`, undefined, { headers: { 'cf-connecting-ip': '203.0.113.7' } })
    expect(asService.status).toBe(404)
    // The copy link's functions take a token, never an actor, so there is no agent path; the operator's stays operator-only.
    const agent = { kind: 'agent' as const, label: 'agent:forms api (claude)', onWordOf: 'tessa@northfield.example' }
    const { uploadForOperator } = await import('../src/forms/filler')
    await expect(uploadForOperator(h.core(), agent, id, upId, {})).rejects.toThrow(/Only an operator/)
    // What the admin shows an envelope never carries a recipient's link.
    const view = await h.tessa('GET', `/admin/api/envelopes/${id}`)
    expect(JSON.stringify(view.body)).not.toContain(books)
    expect(h.sql("SELECT 1 FROM events WHERE action = 'copy-downloaded'")).toHaveLength(0)
  })
})
