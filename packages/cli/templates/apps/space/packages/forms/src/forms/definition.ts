/**
 * A FORM'S DEFINITION and the pure rules over it: what questions a form asks, which are shown given the earlier
 * answers, what a valid answer is, and what is wrong with a definition. Pure and free of LibPDF, Hono and D1, so the Worker,
 * the builder's preview and the filler's screens run the SAME rules.
 *
 * A published version is this object frozen (the database refuses any later change, migrations/0001); a send is pinned to the
 * version it was sent with, so the signer answers exactly the form the operator reviewed.
 *
 * "Which question comes next" is VISIBILITY on earlier answers, not jumps: each question may carry a
 * condition on earlier questions, the next question is the next visible one, and an answer to a hidden question is dropped. A
 * condition may only look back, so a form can never loop; `checkDefinition` enforces it.
 */
import { whyNotDrawable } from '../pdf/glyphs'

export const QUESTION_TYPES = ['short', 'long', 'email', 'phone', 'number', 'date', 'choice', 'multi', 'dropdown', 'yesno', 'file', 'tin', 'statement', 'agreement'] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]

/** The types a signer answers by typing or choosing (not the file upload, which has its own call, and not display only). */
export const TYPE_LABELS: Record<QuestionType, string> = {
  short: 'Short text',
  long: 'Long text',
  email: 'Email address',
  phone: 'Phone number',
  number: 'Number',
  date: 'Date',
  choice: 'Single choice',
  multi: 'Multiple choice',
  dropdown: 'Dropdown',
  yesno: 'Yes or no',
  file: 'File upload',
  tin: 'Social Security or tax ID number',
  statement: 'Statement (display only)',
  agreement: 'Agreement text with an "I agree" box',
}

export const RULE_OPS = ['equals', 'not_equals', 'contains', 'answered', 'gt', 'lt'] as const
export type RuleOp = (typeof RULE_OPS)[number]

export const OP_LABELS: Record<RuleOp, string> = { equals: 'is', not_equals: 'is not', contains: 'contains', answered: 'has been answered', gt: 'is greater than', lt: 'is less than' }

export interface Rule {
  /** An EARLIER question's id. */
  question: string
  op: RuleOp
  /** Compared as written; absent for `answered`. A yes or no question is compared with "yes" or "no". */
  value?: string
}

export interface Condition {
  match: 'all' | 'any'
  rules: Rule[]
}

export const FILE_KINDS = ['pdf', 'jpeg', 'png', 'heic'] as const
export type FileKind = (typeof FILE_KINDS)[number]

export interface Question {
  /** Stable and never reused within a form: answers are stored under it. */
  id: string
  type: QuestionType
  label: string
  help?: string
  placeholder?: string
  required: boolean
  /** Marked in the definition: masked in the admin until revealed (which is an event), and the finished document goes by private link. A tax ID number is always sensitive. */
  sensitive: boolean
  /** Choice, multiple choice and dropdown. */
  options?: string[]
  /** Text: characters. Number: value. File: how many files. */
  min?: number
  max?: number
  /** File upload: what may be uploaded. */
  fileKinds?: FileKind[]
  /** Statement and agreement: the text, word for word. */
  text?: string
  /** Shown only when this holds of the earlier answers. */
  show?: Condition
}

/** A signer role after the filler, or the filler's own: its name and the text fields the form gives it on the signature page. */
export interface Role {
  name: string
  fields: { label: string; required: boolean }[]
}

export interface FormDefinition {
  /** The number the next question's id takes (`q<number>`): only ever goes up, so an id is never reused after a question is deleted. */
  nextId?: number
  title: string
  /** In signing order. Every question belongs to the first (the filler); each role has a block on the signature page. */
  roles: Role[]
  questions: Question[]
}

export interface UploadRef {
  id: string
  name: string
  size: number
}

export type AnswerValue = string | number | boolean | string[] | UploadRef[]
export type Answers = Record<string, AnswerValue>

export const LIMITS = {
  maxQuestions: 100,
  maxRoles: 4,
  maxRoleFields: 4,
  maxOptions: 30,
  maxLabel: 300,
  maxText: 8000,
  shortMax: 200,
  longMax: 5000,
  /** One file's size and a form's total number of files (assumptions in the spec). */
  fileBytes: 10 * 1024 * 1024,
  filesPerEnvelope: 10,
} as const

const ID = /^[a-z][a-z0-9_]{0,31}$/

export const isQuestionType = (t: unknown): t is QuestionType => typeof t === 'string' && (QUESTION_TYPES as readonly string[]).includes(t)
export const answerable = (q: Pick<Question, 'type'>): boolean => q.type !== 'statement'
export const isSensitive = (q: Pick<Question, 'type' | 'sensitive'>): boolean => q.type === 'tin' || q.sensitive

// ── What the PDF's font can draw ─────────────────────────────────────────

/** What is wrong with a text for the document, in a plain sentence; null when every character can be printed (src/pdf/glyphs.ts). */
export const refuseText = whyNotDrawable

// ── Visibility ───────────────────────────────────────────────────────────

/** The text an answer is compared as. A yes or no is "yes" or "no". */
function asText(v: AnswerValue | undefined): string {
  if (v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'string') return v.trim().toLowerCase()
  if (typeof v === 'number') return String(v)
  return (v as (string | UploadRef)[]).map((x) => (typeof x === 'string' ? x : x.name)).join('\n').toLowerCase()
}

export function isAnswered(q: Pick<Question, 'type'>, v: AnswerValue | undefined): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'boolean') return q.type === 'agreement' ? v : true
  return v.length > 0
}

/** A multiple choice (or a file question's names) holds an item. */
const has = (list: (string | UploadRef)[], want: string): boolean => list.some((x) => (typeof x === 'string' ? x : x.name).toLowerCase() === want)

function ruleHolds(rule: Rule, byId: Map<string, Question>, answers: Answers): boolean {
  const q = byId.get(rule.question)
  if (!q) return false
  const v = answers[q.id]
  if (rule.op === 'answered') return isAnswered(q, v)
  if (!isAnswered(q, v)) return rule.op === 'not_equals'
  const want = (rule.value ?? '').trim().toLowerCase()
  switch (rule.op) {
    case 'equals':
      return Array.isArray(v) ? has(v, want) : asText(v) === want
    case 'not_equals':
      return Array.isArray(v) ? !has(v, want) : asText(v) !== want
    case 'contains':
      return Array.isArray(v) ? has(v, want) : asText(v).includes(want)
    case 'gt':
    case 'lt': {
      const a = typeof v === 'number' ? v : Number(asText(v))
      const b = Number(want)
      if (Number.isNaN(a) || Number.isNaN(b)) {
        // Dates compare as written (YYYY-MM-DD sorts as time does).
        const x = asText(v)
        return rule.op === 'gt' ? x > want : x < want
      }
      return rule.op === 'gt' ? a > b : a < b
    }
  }
}

/**
 * The questions a signer is asked, in order, given the answers so far. A question is shown when its condition holds of the answers
 * to EARLIER SHOWN questions; one that is hidden has no answer, so a rule on it sees nothing.
 */
export function visibleQuestions(def: Pick<FormDefinition, 'questions'>, answers: Answers): Question[] {
  const byId = new Map<string, Question>()
  const shown: Question[] = []
  const seen: Answers = {}
  for (const q of def.questions) {
    byId.set(q.id, q)
    const c = q.show
    const visible = !c || c.rules.length === 0 || (c.match === 'any' ? c.rules.some((r) => ruleHolds(r, byId, seen)) : c.rules.every((r) => ruleHolds(r, byId, seen)))
    if (!visible) continue
    shown.push(q)
    if (answers[q.id] !== undefined) seen[q.id] = answers[q.id]!
  }
  return shown
}

// ── Answers ──────────────────────────────────────────────────────────────

const EMAIL = /^[^@\s,<>()"';:\\]+@[^@\s,<>()"';:\\]+\.[^@\s,<>()"';:\\]+$/
const TIN_SSN = /^\d{3}-?\d{2}-?\d{4}$/
const TIN_EIN = /^\d{2}-?\d{7}$/

function realDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/**
 * A value as stored, or the plain reason it is not acceptable. Empty values are not checked here (an unanswered question is
 * `isAnswered`'s business). A string is trimmed. Text that the document's font cannot print is refused here, at the question.
 */
export function checkAnswer(q: Question, value: unknown): { ok: true; value: AnswerValue } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason })
  const text = (max: number, multiline: boolean) => {
    if (typeof value !== 'string') return no('Type an answer.')
    const s = value.normalize('NFC').replace(/\t/g, ' ').trim()
    if (s.length > max) return no(`That is over ${max} characters.`)
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) || (!multiline && /[\r\n]/.test(s))) return no(multiline ? 'That has a character that cannot be saved.' : 'This takes one line of text.')
    const bad = refuseText(s)
    if (bad) return no(bad)
    return { ok: true as const, value: multiline ? s.replace(/\r\n?/g, '\n') : s }
  }
  switch (q.type) {
    case 'short': {
      const r = text(Math.min(q.max ?? LIMITS.shortMax, LIMITS.shortMax), false)
      if (r.ok && q.min && (r.value as string).length < q.min) return no(`Use at least ${q.min} characters.`)
      return r
    }
    case 'long': {
      const r = text(Math.min(q.max ?? LIMITS.longMax, LIMITS.longMax), true)
      if (r.ok && q.min && (r.value as string).length < q.min) return no(`Use at least ${q.min} characters.`)
      return r
    }
    case 'email': {
      const r = text(254, false)
      if (!r.ok) return r
      return EMAIL.test(r.value as string) ? { ok: true, value: (r.value as string).toLowerCase() } : no('That does not look like an email address.')
    }
    case 'phone': {
      const r = text(30, false)
      if (!r.ok) return r
      const digits = (r.value as string).replace(/\D/g, '')
      return /^[+\d\s().-]+$/.test(r.value as string) && digits.length >= 7 && digits.length <= 15 ? r : no('That does not look like a phone number.')
    }
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : Number.NaN
      if (!Number.isFinite(n)) return no('Type a number.')
      if (q.min !== undefined && n < q.min) return no(`That is below ${q.min}.`)
      if (q.max !== undefined && n > q.max) return no(`That is above ${q.max}.`)
      return { ok: true, value: n }
    }
    case 'date':
      return typeof value === 'string' && realDate(value.trim()) ? { ok: true, value: value.trim() } : no('Choose a date.')
    case 'choice':
    case 'dropdown':
      return typeof value === 'string' && (q.options ?? []).includes(value) ? { ok: true, value } : no('Choose one of the options.')
    case 'multi': {
      if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) return no('Choose from the options.')
      const picked = [...new Set(value as string[])]
      if (picked.some((x) => !(q.options ?? []).includes(x))) return no('Choose from the options.')
      return { ok: true, value: (q.options ?? []).filter((o) => picked.includes(o)) }
    }
    case 'yesno':
      return typeof value === 'boolean' ? { ok: true, value } : no('Answer yes or no.')
    case 'tin': {
      if (typeof value !== 'string') return no('Type the number.')
      const s = value.trim()
      return TIN_SSN.test(s) || TIN_EIN.test(s) ? { ok: true, value: s } : no('Type nine digits, like 123-45-6789 or 12-3456789.')
    }
    case 'agreement':
      return value === true ? { ok: true, value: true } : no('Check the box to agree.')
    case 'file':
      return no('Upload a file for this question.')
    case 'statement':
      return no('This is text to read, not a question.')
  }
}

/** The visible, required questions with no answer yet: what stops a signer from continuing. */
export function missingAnswers(def: Pick<FormDefinition, 'questions'>, answers: Answers): Question[] {
  return visibleQuestions(def, answers).filter((q) => answerable(q) && q.required && !isAnswered(q, answers[q.id]))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** An answer as the finished document and the admin print it. */
export function answerText(q: Pick<Question, 'type'>, v: AnswerValue | undefined): string {
  if (v === undefined || !isAnswered(q, v)) return ''
  if (typeof v === 'boolean') return q.type === 'agreement' ? 'I agree' : v ? 'Yes' : 'No'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    const m = q.type === 'date' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null
    return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : v
  }
  return (v as (string | UploadRef)[]).map((x) => (typeof x === 'string' ? x : x.name)).join(', ')
}

/** A sensitive answer hidden: no length, no last digits, nothing a glance could read. */
export const MASKED = '••••••••'

// ── The definition itself ────────────────────────────────────────────────

export const blankDefinition = (title = 'Untitled form'): FormDefinition => ({ title, roles: [{ name: 'Client', fields: [] }], questions: [] })

/** The number after the highest `q<number>` in use. */
const inUse = (def: Pick<FormDefinition, 'questions'>): number => def.questions.reduce((n, q) => Math.max(n, Number(/^q(\d+)$/.exec(q.id)?.[1] ?? 0)), 0) + 1

/**
 * The id a new question takes, and the definition to keep: ids are NEVER reused, because answers are stored under them and a form
 * sent earlier (an older version) may still hold answers for a deleted question's id. `nextId` carries the highest number ever
 * issued across deletions and versions.
 */
export function addQuestion(def: FormDefinition, make: (id: string) => Question): FormDefinition {
  const n = Math.max(def.nextId ?? 1, inUse(def))
  return { ...def, nextId: n + 1, questions: [...def.questions, make(`q${n}`)] }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * Reads an untrusted object into a clean definition (unknown keys dropped, defaults filled in) and lists everything wrong with it
 * in sentences an operator can act on. `publish` adds what only a finished form needs. An empty `problems` means `def` is fit to store.
 */
export function readDefinition(raw: unknown, opts: { publish?: boolean } = {}): { def: FormDefinition; problems: string[] } {
  const problems: string[] = []
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const clean = (v: unknown, what: string, max: number, opts2: { required?: boolean; multiline?: boolean } = {}): string | undefined => {
    if (v === undefined || v === null || v === '') {
      if (opts2.required) problems.push(`${what} is required.`)
      return undefined
    }
    if (typeof v !== 'string') {
      problems.push(`${what} must be text.`)
      return undefined
    }
    const s = (opts2.multiline ? v.replace(/\r\n?/g, '\n') : v).normalize('NFC').replace(/\t/g, ' ').trim()
    if (s === '') {
      if (opts2.required) problems.push(`${what} is required.`)
      return undefined
    }
    if (s.length > max) problems.push(`${what} is over ${max} characters.`)
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) || (!opts2.multiline && /\n/.test(s))) problems.push(`${what} has a character that cannot be saved.`)
    const bad = refuseText(s)
    if (bad) problems.push(`${what}: ${bad}`)
    return s
  }

  const title = clean(o.title, 'The form\'s title', 120, { required: true }) ?? ''

  const rawRoles = Array.isArray(o.roles) ? o.roles : []
  if (rawRoles.length < 1) problems.push('A form needs at least one signer role.')
  if (rawRoles.length > LIMITS.maxRoles) problems.push(`A form has at most ${LIMITS.maxRoles} signer roles.`)
  const roles: Role[] = rawRoles.slice(0, LIMITS.maxRoles).map((r, i) => {
    const ro = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    const name = clean(ro.name, `Role ${i + 1}'s name`, 40, { required: true }) ?? ''
    const rawFields = Array.isArray(ro.fields) ? ro.fields : []
    if (rawFields.length > LIMITS.maxRoleFields) problems.push(`Role ${i + 1} has at most ${LIMITS.maxRoleFields} fields of its own.`)
    const fields = rawFields.slice(0, LIMITS.maxRoleFields).map((f, j) => {
      const fo = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>
      return { label: clean(fo.label, `Role ${i + 1}'s field ${j + 1} label`, 60, { required: true }) ?? '', required: fo.required !== false }
    })
    return { name, fields }
  })
  if (new Set(roles.map((r) => r.name.toLowerCase())).size !== roles.length) problems.push('Two signer roles share a name.')

  const rawQuestions = Array.isArray(o.questions) ? o.questions : []
  if (rawQuestions.length > LIMITS.maxQuestions) problems.push(`A form has at most ${LIMITS.maxQuestions} questions.`)
  const questions: Question[] = []
  const ids = new Set<string>()
  const earlier = new Map<string, Question>()
  rawQuestions.slice(0, LIMITS.maxQuestions).forEach((r, i) => {
    const qo = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    const at = `Question ${i + 1}`
    const type = isQuestionType(qo.type) ? qo.type : null
    if (!type) {
      problems.push(`${at} has an unknown type.`)
      return
    }
    const id = str(qo.id) ?? ''
    if (!ID.test(id)) problems.push(`${at} has no valid id.`)
    if (ids.has(id)) problems.push(`${at} repeats the id ${id}.`)
    ids.add(id)
    const display = type === 'statement' || type === 'agreement'
    const label = clean(qo.label, `${at}'s label`, LIMITS.maxLabel, { required: !display }) ?? ''
    const q: Question = { id, type, label, required: display ? type === 'agreement' : qo.required !== false && qo.required !== 0, sensitive: type === 'tin' ? true : qo.sensitive === true }
    const help = clean(qo.help, `${at}'s help text`, 500, { multiline: true })
    if (help) q.help = help
    const placeholder = clean(qo.placeholder, `${at}'s placeholder`, 100)
    if (placeholder) q.placeholder = placeholder
    if (display) {
      const text = clean(qo.text, `${at}'s text`, LIMITS.maxText, { required: true, multiline: true })
      if (text) q.text = text
    }
    if (type === 'choice' || type === 'multi' || type === 'dropdown') {
      const options = (Array.isArray(qo.options) ? qo.options : []).map((x) => clean(x, `${at}'s option`, 100)).filter((x): x is string => x !== undefined)
      if (options.length < 2) problems.push(`${at} needs at least two options.`)
      if (options.length > LIMITS.maxOptions) problems.push(`${at} has at most ${LIMITS.maxOptions} options.`)
      if (new Set(options.map((x) => x.toLowerCase())).size !== options.length) problems.push(`${at} repeats an option.`)
      q.options = options
    }
    const limit = (v: unknown, name: string): number | undefined => {
      if (v === undefined || v === null || v === '') return undefined
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        problems.push(`${at}'s ${name} must be a number.`)
        return undefined
      }
      return v
    }
    if (type === 'short' || type === 'long' || type === 'number' || type === 'file') {
      const min = type === 'file' ? undefined : limit(qo.min, 'minimum')
      const max = limit(qo.max, type === 'file' ? 'most files' : 'maximum')
      if (min !== undefined) q.min = min
      if (max !== undefined) q.max = max
      if (min !== undefined && max !== undefined && min > max) problems.push(`${at}'s minimum is above its maximum.`)
      if (type === 'file' && max !== undefined && (!Number.isInteger(max) || max < 1 || max > LIMITS.filesPerEnvelope)) problems.push(`${at} takes 1 to ${LIMITS.filesPerEnvelope} files.`)
    }
    if (type === 'file') {
      const kinds = (Array.isArray(qo.fileKinds) ? qo.fileKinds : [...FILE_KINDS]).filter((k): k is FileKind => (FILE_KINDS as readonly string[]).includes(k as string))
      if (kinds.length === 0) problems.push(`${at} must allow at least one kind of file.`)
      q.fileKinds = [...new Set(kinds)]
    }
    // A condition looks back only: a rule on this question or a later one is refused, so a form cannot loop.
    if (qo.show !== undefined && qo.show !== null) {
      const co = (typeof qo.show === 'object' ? qo.show : {}) as Record<string, unknown>
      const rules = (Array.isArray(co.rules) ? co.rules : []).map((x, j): Rule | null => {
        const rule = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
        const target = earlier.get(str(rule.question) ?? '')
        const rn = `${at}'s condition ${j + 1}`
        if (!target) {
          problems.push(`${rn} must look at an earlier question.`)
          return null
        }
        if (!answerable(target)) {
          problems.push(`${rn} looks at a statement, which has no answer.`)
          return null
        }
        const op = (RULE_OPS as readonly string[]).includes(rule.op as string) ? (rule.op as RuleOp) : null
        if (!op) {
          problems.push(`${rn} has an unknown test.`)
          return null
        }
        const value = str(rule.value)?.trim()
        if (op !== 'answered' && !value) problems.push(`${rn} needs a value to compare with.`)
        if ((op === 'gt' || op === 'lt') && target.type !== 'number' && target.type !== 'date') problems.push(`${rn}: only a number or a date can be greater or less.`)
        if ((op === 'gt' || op === 'lt') && target.type === 'number' && value && Number.isNaN(Number(value))) problems.push(`${rn} needs a number.`)
        if (op === 'contains' && target.type !== 'short' && target.type !== 'long' && target.type !== 'multi') problems.push(`${rn}: only text or a multiple choice can contain something.`)
        if (value && value.length > 200) problems.push(`${rn}'s value is too long.`)
        return op === 'answered' ? { question: target.id, op } : { question: target.id, op, value: value ?? '' }
      })
      const kept = rules.filter((x): x is Rule => x !== null)
      if (kept.length > 0) q.show = { match: co.match === 'any' ? 'any' : 'all', rules: kept }
    }
    questions.push(q)
    earlier.set(id, q)
  })
  if (opts.publish) {
    if (questions.length === 0) problems.push('Add at least one question before publishing.')
    if (!questions.some((q) => q.type !== 'statement')) problems.push('A form needs at least one question to answer, not only statements.')
  }
  const nextId = Math.max(typeof o.nextId === 'number' && Number.isInteger(o.nextId) && o.nextId > 0 ? o.nextId : 1, inUse({ questions }))
  return { def: { nextId, title, roles, questions }, problems }
}

/** Does any question in the form hold private information? Decides the Send screen's default and the delivery by private link. */
export const hasSensitive = (def: Pick<FormDefinition, 'questions'>): boolean => def.questions.some((q) => answerable(q) && isSensitive(q))
