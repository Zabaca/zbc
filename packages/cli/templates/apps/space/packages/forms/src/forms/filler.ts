/**
 * The form path from the filler's side: the first signer of a form envelope answers its questions on their private
 * link, one at a time, saved as they go; the document does not exist until they finish. Every request carries the filler's token
 * (the signing core resolves it); the answers, uploads and the prepared document are this module's, and the document then enters the
 * signing core through `attachPrepared`, which knows nothing about forms.
 *
 *   formView     what the filler's screens need: the pinned definition, what they have answered, whether they may still change it
 *   saveAnswer   one answer, encrypted, as they go: a draft, so no event (like a signer's saved field)
 *   uploadFile / removeFile   a file for an upload question, encrypted under the envelope's key
 *   prepareForm  the answers and the agreement text become the prepared document; an `answered` event, then the core's `prepared`
 *
 * Changing an answer, or a file, after the document was made withdraws the document in the same batch (`reopenPrepared`) and the form
 * makes it again, with a new fingerprint and a new event, until the filler has signed (the core refuses after). So the document anyone
 * can sign always says what the saved answers say.
 * An answer to a question that is no longer shown (because an earlier answer changed) is dropped when the document is prepared.
 */
import { sha256Hex } from '../bytes'
import { appendEvents } from '../events'
import { layoutForm } from '../pdf/formpages'
import { canDrawChar } from '../pdf/glyphs'
import { type Actor, type Origin, attachPrepared, requireOperator, resolveToken, stateOf } from '../signing'
import { reopenPrepared } from '../signing/lifecycle'
import type { Resolved } from '../signing/signer'
import { type CoreDeps, type EnvelopeRow, ctx, dataKeyFor, eventFor, gone, isClientCopy, isoAt, linkEndsAt, loadClient } from '../signing/support'
import type { Stmt } from '../records'
import { badRequest, conflict } from '../store'
import { decryptText, encryptText, getSealed, putSealed } from '../vault'
import { type AnswerValue, type Answers, type FileKind, type FormDefinition, LIMITS, type Question, type UploadRef, answerText, answerable, checkAnswer, isAnswered, isSensitive, visibleQuestions } from './definition'
import { publishedVersion } from './store'

const ALL_KINDS: FileKind[] = ['pdf', 'jpeg', 'png', 'heic']
const KIND_TYPE: Record<FileKind, string> = { pdf: 'application/pdf', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic' }

/** What a file is, by its first bytes (never by its name or the type the browser claims). */
export function fileKind(b: Uint8Array): FileKind | null {
  const at = (i: number, s: string) => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0))
  if (b.length > 5 && at(0, '%PDF-')) return 'pdf'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length > 8 && b[0] === 0x89 && at(1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png'
  if (b.length > 12 && at(4, 'ftyp') && ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].some((brand) => at(8, brand))) return 'heic'
  return null
}

/**
 * A file's name as kept: the last path segment, no control characters, at most 120 characters, and a character the document's font cannot
 * draw (a Chinese file name from a phone) becomes an underscore, so the name in the document and in the admin are one name. The file's
 * SHA-256 beside it is what identifies it.
 */
export const cleanName = (raw: string): string =>
  [...raw.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 120)].map((ch) => (canDrawChar(ch) ? ch : '_')).join('') || 'file'

interface Filler {
  r: Resolved
  state: ReturnType<typeof stateOf>
  /** The form envelope's first signer. */
  isFiller: boolean
}

async function loadFiller(d: CoreDeps, token: string): Promise<Filler> {
  const r = await resolveToken(d, token)
  const isFiller = r.envelope.kind === 'form' && r.envelope.form_version_id !== null && r.recipient.kind === 'signer' && r.recipient.position === 1
  return { r, state: stateOf(d, r), isFiller }
}

/** The filler may still change answers: consented, not signed, nobody has signed the document, and the envelope is live. */
const editable = ({ r, state, isFiller }: Filler): boolean => isFiller && (state === 'preparing' || state === 'sign') && r.recipient.status === 'consented' && ['sent', 'prepared'].includes(r.envelope.status) && !r.recipients.some((p) => p.status === 'signed')

/** Refuses with the plain reason a filler cannot change answers now. */
function mustEdit(f: Filler): void {
  if (!f.isFiller) throw gone('This form is for someone else.')
  if (f.state === 'consent') throw gone('Agree to sign electronically first.')
  if (f.state === 'signed' || f.r.recipients.some((p) => p.status === 'signed')) throw gone('The document has been signed, so the answers can no longer change.')
  if (!editable(f)) throw gone(f.state === 'expired' ? 'This link has expired.' : f.state === 'cancelled' ? 'This was cancelled.' : f.state === 'declined' ? 'This was declined.' : 'The answers cannot be changed now.')
}

async function definitionOf(d: CoreDeps, e: EnvelopeRow): Promise<FormDefinition> {
  const v = await publishedVersion(d.db, e.form_version_id!)
  if (!v) throw gone('This form is not available.')
  return v.def
}

interface UploadRow {
  id: string
  recipient_id: string
  question_id: string
  name: string
  content_type: string
  size: number
  sha256: string
  r2_key: string
}

const uploadsOf = async (d: CoreDeps, envelopeId: string): Promise<UploadRow[]> => (await d.db.prepare('SELECT id, recipient_id, question_id, name, content_type, size, sha256, r2_key FROM uploads WHERE envelope_id = ? ORDER BY created_at, id').bind(envelopeId).all<UploadRow>()).results

/**
 * An answer as it rests, before encryption: text as the text itself (so that revealing a sensitive answer, which hands the operator
 * the stored plaintext, shows what the customer typed), everything else as JSON.
 */
const TEXT_TYPES = new Set<Question['type']>(['short', 'long', 'email', 'phone', 'date', 'choice', 'dropdown', 'tin'])
const encodeAnswer = (q: Question, v: AnswerValue): string => (TEXT_TYPES.has(q.type) ? String(v) : JSON.stringify(v))
const decodeAnswer = (q: Question, text: string): AnswerValue => (TEXT_TYPES.has(q.type) ? text : (JSON.parse(text) as AnswerValue))

/** The filler's answers: decrypted, with each file question holding its uploads' refs. */
async function readAnswers(d: CoreDeps, e: EnvelopeRow, key: Uint8Array, def: FormDefinition): Promise<{ answers: Answers; uploads: UploadRow[] }> {
  const rows = (await d.db.prepare('SELECT question_id, value_enc FROM answers WHERE envelope_id = ?').bind(e.id).all<{ question_id: string; value_enc: string }>()).results
  const answers: Answers = {}
  for (const row of rows) {
    const q = def.questions.find((x) => x.id === row.question_id)
    if (q) answers[row.question_id] = decodeAnswer(q, await decryptText(key, row.value_enc, ctx.answer(e.id, row.question_id)))
  }
  const uploads = await uploadsOf(d, e.id)
  for (const u of uploads) answers[u.question_id] = [...((answers[u.question_id] as UploadRef[] | undefined) ?? []), { id: u.id, name: u.name, size: u.size }]
  return { answers, uploads }
}

export type FormView = { filler: false } | { filler: true; canEdit: boolean; definition: FormDefinition; answers: Answers; limits: { fileBytes: number; filesPerEnvelope: number } }

/** What the filler's screens need. Anyone else's link, or a link past answering, is `filler: false`. */
export async function formView(d: CoreDeps, token: string): Promise<FormView> {
  const f = await loadFiller(d, token)
  if (!f.isFiller || (f.state !== 'preparing' && f.state !== 'sign')) return { filler: false }
  const definition = await definitionOf(d, f.r.envelope)
  const { answers } = await readAnswers(d, f.r.envelope, await dataKeyFor(d, f.r.envelope), definition)
  return { filler: true, canEdit: editable(f), definition, answers, limits: { fileBytes: LIMITS.fileBytes, filesPerEnvelope: LIMITS.filesPerEnvelope } }
}

function questionOf(def: FormDefinition, id: string): Question {
  const q = def.questions.find((x) => x.id === id)
  if (!q) throw badRequest('That question is not on this form.')
  return q
}

const actorOf = (f: Filler) => ({ kind: 'recipient' as const, id: f.r.recipient.id, email: f.r.recipient.email, name: f.r.recipient.name })

/** One write of a change: SQL that already has its WHERE, run with the guard added to it. */
type Write = (run: (sql: string, ...binds: unknown[]) => void) => void

/**
 * One change to the filler's answers or files, as ONE guarded batch that lands entirely or not at all. Returns whether it landed.
 *
 *  - Before a document exists (or after it was withdrawn): a draft, no event. It lands only while the envelope has no document, the
 *    filler is still consenting and NOBODY has signed (an all-at-once envelope's others may be signing), and it moves the filler's
 *    `values_version`, which is what stops a document being made from answers that moved after they were read (`prepareForm`).
 *  - While a document exists: the document is WITHDRAWN in the same batch (`reopenPrepared`, one event), so no document ever lists an
 *    upload or an answer that is gone, and the filler cannot Finish a document their answers no longer say: they make it again
 *    first, after the change. Nothing is withdrawn by a change that did not land.
 */
async function apply(d: CoreDeps, f: Filler, origin: Origin, reason: string, write: Write, when?: { sql: string; binds: unknown[] }): Promise<boolean> {
  const e = f.r.envelope
  if (e.status === 'prepared' && e.prepared_key) {
    return reopenPrepared(d, actorOf(f), origin, e.id, { reason, changes: (g) => write((sql, ...binds) => void g.mutate(sql, ...binds)), when })
  }
  const cond = `EXISTS (SELECT 1 FROM envelopes WHERE id = ? AND status IN ('sent', 'prepared') AND prepared_key IS NULL) AND EXISTS (SELECT 1 FROM recipients WHERE id = ? AND status = 'consented') AND NOT EXISTS (SELECT 1 FROM recipients WHERE envelope_id = ? AND status = 'signed')`
  const guard = [e.id, f.r.recipient.id, e.id]
  const stmts: Stmt[] = []
  const run = (sql: string, ...binds: unknown[]) => void stmts.push(d.db.prepare(`${sql} AND ${cond}`).bind(...binds, ...guard))
  run('UPDATE recipients SET values_version = values_version + 1 WHERE id = ?', f.r.recipient.id)
  write(run)
  // The last statement answers whether the guard held: a batch is one transaction, so if it holds at the end it held throughout.
  stmts.push(d.db.prepare(`SELECT 1 AS ok WHERE ${cond}`).bind(...guard))
  const results = await d.db.batch(stmts)
  return (results[results.length - 1]!.results as unknown[]).length > 0
}

const TRIES = 3
const CHANGED = 'That could not be saved because the document changed while you were working. Reload the page.'

/** Saves one answer (an empty value clears it). Before a document exists, a draft with no event; after, it withdraws the document (see `apply`). */
export async function saveAnswer(d: CoreDeps, token: string, origin: Origin, questionId: string, value: unknown): Promise<void> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const f = await loadFiller(d, token)
    mustEdit(f)
    const e = f.r.envelope
    const q = questionOf(await definitionOf(d, e), questionId)
    if (!answerable(q)) throw badRequest('That is text to read, not a question.')
    if (q.type === 'file') throw badRequest('Upload a file for this question.')
    const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0) || (q.type === 'agreement' && value === false)
    let enc: string | null = null
    let plain = ''
    if (!empty) {
      const checked = checkAnswer(q, value)
      if (!checked.ok) throw badRequest(checked.reason)
      plain = encodeAnswer(q, checked.value)
      enc = await encryptText(await dataKeyFor(d, e), plain, ctx.answer(e.id, q.id))
    }
    // An answer that is what is already saved changes nothing, so it must not withdraw the document either.
    const saved = await d.db.prepare('SELECT value_enc FROM answers WHERE envelope_id = ? AND question_id = ?').bind(e.id, q.id).first<{ value_enc: string }>()
    if (!saved && !enc) return
    if (saved && enc && (await decryptText(await dataKeyFor(d, e), saved.value_enc, ctx.answer(e.id, q.id))) === plain) return
    const at = isoAt(d.now())
    const landed = await apply(d, f, origin, 'an answer changed', (run) => {
      run('DELETE FROM answers WHERE envelope_id = ? AND question_id = ?', e.id, q.id)
      if (enc) run('INSERT INTO answers (envelope_id, client_id, question_id, value_enc, answered_at) SELECT ?, ?, ?, ?, ? WHERE 1 = 1', e.id, e.client_id, q.id, enc, at)
    })
    if (landed) return
  }
  throw conflict(CHANGED)
}

/** Stores a file for an upload question, encrypted with the envelope's key. Its kind is read from its bytes. */
export async function uploadFile(d: CoreDeps, token: string, origin: Origin, questionId: string, file: { name: string; bytes: Uint8Array }): Promise<UploadRef[]> {
  const id = crypto.randomUUID()
  let r2Key: string | null = null
  try {
    for (let attempt = 0; attempt < TRIES; attempt++) {
      const f = await loadFiller(d, token)
      mustEdit(f)
      const e = f.r.envelope
      const q = questionOf(await definitionOf(d, e), questionId)
      if (q.type !== 'file') throw badRequest('That question does not take a file.')
      if (file.bytes.length === 0) throw badRequest('That file is empty.')
      if (file.bytes.length > LIMITS.fileBytes) throw badRequest(`That file is over ${LIMITS.fileBytes / 1048576} MB, which is the most.`)
      const kind = fileKind(file.bytes)
      if (!kind) throw badRequest('Upload a PDF, a JPEG, a PNG or a HEIC photo.')
      if (!(q.fileKinds ?? ALL_KINDS).includes(kind)) throw badRequest(`This question takes ${(q.fileKinds ?? ALL_KINDS).map((k) => k.toUpperCase()).join(', ')} files; that is a ${kind.toUpperCase()}.`)
      const most = q.max ?? LIMITS.filesPerEnvelope
      const have = await uploadsOf(d, e.id)
      const limited = () => (have.length >= LIMITS.filesPerEnvelope ? badRequest(`At most ${LIMITS.filesPerEnvelope} files can be uploaded.`) : badRequest(`This question takes at most ${most} ${most === 1 ? 'file' : 'files'}. Remove one to add another.`))
      if (have.length >= LIMITS.filesPerEnvelope || have.filter((u) => u.question_id === q.id).length >= most) throw limited()
      if (!r2Key) {
        r2Key = `envelopes/${e.id}/uploads/${id}`
        await putSealed(d.files, r2Key, await dataKeyFor(d, e), file.bytes, KIND_TYPE[kind])
      }
      const row = [id, e.id, e.client_id, f.r.recipient.id, q.id, cleanName(file.name), KIND_TYPE[kind], file.bytes.length, await sha256Hex(file.bytes), r2Key, isoAt(d.now())]
      // The counts are part of the insert, so two uploads racing for the last place cannot both land.
      const landed = await apply(d, f, origin, 'a file was added', (run) =>
        run(
          'INSERT INTO uploads (id, envelope_id, client_id, recipient_id, question_id, name, content_type, size, sha256, r2_key, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM uploads WHERE envelope_id = ?) < ? AND (SELECT COUNT(*) FROM uploads WHERE envelope_id = ? AND question_id = ?) < ?',
          ...row,
          e.id,
          LIMITS.filesPerEnvelope,
          e.id,
          q.id,
          most,
        ),
        {
          sql: '(SELECT COUNT(*) FROM uploads WHERE envelope_id = ?) < ? AND (SELECT COUNT(*) FROM uploads WHERE envelope_id = ? AND question_id = ?) < ?',
          binds: [e.id, LIMITS.filesPerEnvelope, e.id, q.id, most],
        },
      )
      if (!landed) continue
      const stored = (await uploadsOf(d, e.id)).filter((u) => u.question_id === q.id)
      if (!stored.some((u) => u.id === id)) throw limited()
      return stored.map((u) => ({ id: u.id, name: u.name, size: u.size }))
    }
    throw conflict(CHANGED)
  } catch (err) {
    // Whatever stopped it, a file that is in storage and in no row is not left there.
    if (r2Key) await d.files.delete(r2Key)
    throw err
  }
}

/**
 * Removes an upload. Its stored file is deleted only AFTER the batch that removes its row has landed, and that batch withdraws the document
 * that listed it (`apply`), so a document that lists a file is never left without it.
 */
export async function removeFile(d: CoreDeps, token: string, origin: Origin, uploadId: string): Promise<void> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const f = await loadFiller(d, token)
    mustEdit(f)
    const e = f.r.envelope
    const row = (await uploadsOf(d, e.id)).find((u) => u.id === uploadId)
    if (!row) return
    const landed = await apply(d, f, origin, 'a file was removed', (run) => run('DELETE FROM uploads WHERE id = ? AND envelope_id = ?', row.id, e.id), { sql: 'EXISTS (SELECT 1 FROM uploads WHERE id = ? AND envelope_id = ?)', binds: [row.id, e.id] })
    if (landed) {
      await d.files.delete(row.r2_key)
      return
    }
  }
  throw conflict(CHANGED)
}

/**
 * The filler has answered: the answers and the agreement text, exactly as shown, become the prepared document. An `answered` event
 * records the form version and the SHA-256 of each agreement's text (not of any answer: a hash of a nine-digit number can be guessed
 * from), then the core's `prepared` event records the document's fingerprint; they are written in ONE batch (`attachPrepared`), which
 * also holds the filler's saved answers to the version this document was made from, so a lost race writes neither, drops nothing and
 * deletes nothing. Answers to questions no longer shown are dropped in that batch, and their files from storage after it.
 */
export async function prepareForm(d: CoreDeps, token: string, origin: Origin): Promise<{ pages: number; sensitive: boolean }> {
  const f = await loadFiller(d, token)
  mustEdit(f)
  const e = f.r.envelope
  // The filler's saved-answers version, read with the token and BEFORE the answers: any change after it fails the batch.
  const valuesVersion = f.r.recipient.values_version
  const version = await publishedVersion(d.db, e.form_version_id!)
  if (!version) throw gone('This form is not available.')
  const def = version.def
  const key = await dataKeyFor(d, e)
  const { answers, uploads } = await readAnswers(d, e, key, def)

  const visible = visibleQuestions(def, answers).filter(answerable)
  const problems: string[] = []
  const missing: string[] = []
  for (const q of visible) {
    const v = answers[q.id]
    if (!isAnswered(q, v)) {
      if (q.required) missing.push(q.label || 'the agreement')
      continue
    }
    if (q.type === 'file') continue
    const checked = checkAnswer(q, v)
    if (!checked.ok) problems.push(`${q.label || 'The agreement'}: ${checked.reason}`)
  }
  if (missing.length > 0) problems.unshift(`${missing.length === 1 ? 'One question still needs' : `${missing.length} questions still need`} an answer: ${missing.join(', ')}.`)
  if (problems.length > 0) throw badRequest(problems.join(' '))

  const signers = f.r.recipients.filter((p) => p.kind === 'signer').sort((a, b) => a.position - b.position)
  if (signers.length !== def.roles.length) throw conflict(`This form has ${def.roles.length} signer ${def.roles.length === 1 ? 'role' : 'roles'} but ${signers.length} ${signers.length === 1 ? 'person was' : 'people were'} named. Ask ${(await loadClient(d.db, e.client_id)).display_name} to send it again.`)

  const shown = new Set(visible.map((q) => q.id))
  const keep = uploads.filter((u) => shown.has(u.question_id))
  const dropAnswers = Object.keys(answers).filter((id) => !shown.has(id) && !uploads.some((u) => u.question_id === id))
  const dropUploads = uploads.filter((u) => !shown.has(u.question_id))

  const client = await loadClient(d.db, e.client_id)
  const logoObject = client.logo_key ? await d.files.get(client.logo_key) : null
  const prepared = await layoutForm({
    title: e.title,
    client,
    service: d.service,
    logo: logoObject && client.logo_type ? { bytes: new Uint8Array(await logoObject.arrayBuffer()), type: client.logo_type } : null,
    def,
    answers,
    uploads: keep.map((u) => ({ questionId: u.question_id, name: u.name, size: u.size, sha256: u.sha256 })),
    signers: signers.map((p) => ({ name: p.name })),
  })
  const sensitive = visible.some((q) => isSensitive(q) && isAnswered(q, answers[q.id]))

  const actor = actorOf(f)
  const agreements = await Promise.all(visible.filter((q) => q.type === 'agreement').map(async (q) => ({ question: q.id, sha256: await sha256Hex(q.text ?? '') })))
  await attachPrepared(d, actor, origin, e.id, prepared, {
    sensitive,
    first: {
      event: eventFor(actor, origin, { action: 'answered', details: { form_version: version.row.version, definition_sha256: version.row.definition_hash, questions: visible.length, uploads: keep.length, dropped: dropAnswers.length + dropUploads.length, agreements } }),
      changes: (g) => {
        for (const id of dropAnswers) g.mutate('DELETE FROM answers WHERE envelope_id = ? AND question_id = ?', e.id, id)
        for (const u of dropUploads) g.mutate('DELETE FROM uploads WHERE id = ? AND envelope_id = ?', u.id, e.id)
      },
      whenRecipient: { id: f.r.recipient.id, status: ['consented'], valuesVersion },
    },
  })
  if (dropUploads.length > 0) await d.files.delete(dropUploads.map((u) => u.r2_key))
  return { pages: prepared.pages.length, sensitive }
}

// ── The operator's side: reading what was answered ──────────────────────

export interface AnswerItem {
  id: string
  label: string
  type: Question['type']
  sensitive: boolean
  answered: boolean
  /** Null for a sensitive answer, which an operator reveals on the record, and for a file question. */
  value: string | null
}

/**
 * What a form envelope's filler answered, for an operator: every shown question with its answer, except that a sensitive one is never
 * RETURNED here (the answers are decrypted to work out which questions are shown, but a private one's value does not leave this function;
 * revealing it is its own event, `revealAnswer` in the signing core).
 */
export async function answersFor(d: CoreDeps, actor: Actor, envelopeId: string) {
  requireOperator(actor, 'read a customer\'s answers')
  const e = await d.db.prepare('SELECT * FROM envelopes WHERE id = ?').bind(envelopeId).first<EnvelopeRow>()
  if (!e) throw gone('That envelope is not here.')
  if (e.kind !== 'form' || !e.form_version_id) return { form: false as const }
  const v = await publishedVersion(d.db, e.form_version_id)
  if (!v) return { form: false as const }
  const key = await dataKeyFor(d, e)
  const { answers, uploads } = await readAnswers(d, e, key, v.def)
  const items: AnswerItem[] = visibleQuestions(v.def, answers).filter(answerable).map((q) => {
    const sensitive = isSensitive(q)
    const has = isAnswered(q, answers[q.id])
    return { id: q.id, label: q.label || 'Agreement', type: q.type, sensitive, answered: has, value: sensitive || q.type === 'file' || !has ? null : answerText(q, answers[q.id]) }
  })
  return {
    form: true as const,
    title: e.title,
    version: { number: v.row.version, hash: v.row.definition_hash },
    items,
    uploads: uploads.filter((u) => answers[u.question_id] !== undefined).map((u) => ({ id: u.id, question_id: u.question_id, name: u.name, content_type: u.content_type, size: u.size, sha256: u.sha256 })),
    /** False while the customer has not made the document yet, or has withdrawn it to change an answer: the answers below are then the latest, and no document says them. */
    documentReady: e.prepared_key !== null,
  }
}

/**
 * An uploaded file for an operator. Every download is an event; an agent can never take one. The event carries the file's id and SHA-256
 * and never its name: a timeline can be read with Claude's token, and a name like "ssn-card.jpg" is itself private.
 */
export async function uploadForOperator(d: CoreDeps, actor: Actor, envelopeId: string, uploadId: string, origin: Origin): Promise<{ bytes: Uint8Array; name: string; type: string }> {
  requireOperator(actor, 'download an uploaded file')
  const e = await d.db.prepare('SELECT * FROM envelopes WHERE id = ?').bind(envelopeId).first<EnvelopeRow>()
  const row = e ? (await uploadsOf(d, e.id)).find((u) => u.id === uploadId) : undefined
  if (!e || !row) throw gone('That file is not here.')
  const bytes = await getSealed(d.files, row.r2_key, await dataKeyFor(d, e))
  if (!bytes) throw gone('That file is no longer in storage.')
  await appendEvents(d.db, e, [eventFor(actor, origin, { action: 'copy-downloaded', details: { by: 'operator', upload_id: row.id, sha256: row.sha256 } })], { now: d.now() })
  return { bytes, name: row.name, type: row.content_type }
}

/**
 * The files a customer uploaded, for the client's own copy addresses, on the copy recipient's private link: the link the completion email
 * carries and the finished document's link are one, so it works for the same 90 days from completion and is refused after, and only a
 * recipient who is one of the client's copy addresses can use it (a signer, or anyone else an operator added as a copy, is refused).
 * The files are those of THIS envelope only: a file is looked up among its uploads, never by the id alone.
 */
async function copyUploads(d: CoreDeps, token: string, others: 'refuse' | 'empty'): Promise<{ r: Resolved; rows: UploadRow[] }> {
  const r = await resolveToken(d, token)
  // Anyone else's list is empty, which says nothing; anyone else's file is refused.
  if (others === 'empty' && !isClientCopy(r.client, r.recipient)) return { r, rows: [] }
  if (stateOf(d, r) !== 'complete') throw gone('The files are ready when everyone has signed.')
  if (linkEndsAt(r.envelope) <= d.now()) throw gone('This link has run out. Ask the business that sent it for another copy.')
  if (!isClientCopy(r.client, r.recipient)) throw gone('That file is not here.')
  return { r, rows: await uploadsOf(d, r.envelope.id) }
}

/** The names and sizes of the files, for the page the link opens. Nobody else's link gets a list: it is empty. */
export async function uploadsForCopy(d: CoreDeps, token: string): Promise<{ files: { id: string; name: string; size: number; content_type: string }[] }> {
  const { rows } = await copyUploads(d, token, 'empty')
  return { files: rows.map((u) => ({ id: u.id, name: u.name, size: u.size, content_type: u.content_type })) }
}

/** One of the files, from the copy recipient's link. Every download is an event, with the recipient and the file's fingerprint. */
export async function uploadForCopy(d: CoreDeps, token: string, uploadId: string, origin: Origin): Promise<{ bytes: Uint8Array; name: string; type: string }> {
  const { r, rows } = await copyUploads(d, token, 'refuse')
  const row = rows.find((u) => u.id === uploadId)
  if (!row) throw gone('That file is not here.')
  const bytes = await getSealed(d.files, row.r2_key, await dataKeyFor(d, r.envelope))
  if (!bytes) throw gone('That file is no longer in storage.')
  await appendEvents(d.db, r.envelope, [eventFor({ kind: 'recipient', id: r.recipient.id, email: r.recipient.email, name: r.recipient.name }, origin, { action: 'copy-downloaded', details: { recipient_id: r.recipient.id, upload_id: row.id, sha256: row.sha256 } })], { now: d.now() })
  return { bytes, name: row.name, type: row.content_type }
}
