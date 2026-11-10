/**
 * What an install says about its mailboxes in its own words: each mailbox's assistant persona and its spam check's questions. They are CONTENT, not code (the company layer's ADR 0006): one JSON file beside the install's declaration (`workspace-content.json`), bundled into
 * the Worker at build as the declaration is (`@inbox/content`, vite.config.ts and tsconfig.json of the space), and read per mailbox through this module. A mailbox with no persona gets no assistant and a mailbox with no
 * spam questions gets no spam check, whatever a switch says; an install with no file at all has neither.
 *
 *   { "personas": { "<address>": { "role", "signature", "us", "rules"? } },
 *     "spamQuestions": { "<address>": { "categories": [...], "questions": { "category": {...}, "junk": {...} } } } }
 *
 * The addresses are the install's own: a persona is for a mailbox of one of its businesses (the Gmail account of the owner included, as `tessa@northfield.example` is), and spam questions are for a Cloudflare
 * mailbox its declaration lists (`cloudflareMailboxes`). A content file that disagrees with the declaration is refused when it is read, which is when the space's build loads (packages/space/vite.config.ts reads the file beside the declaration of any install it
 * builds, so nothing is bundled or deployed from a pair that disagrees) and again at the Worker's start, so a typo in an address is a failed build and not an assistant that quietly never speaks: a persona or questions for an address the declaration does not have, a question set whose kinds are not ones the spam classifier's reason lines have words for (spam-check.ts) or
 * whose first question does not describe exactly those kinds, and a mailbox declared with its spam check on that has no questions. The words themselves are not checked: they are the install's.
 *
 * Pure: the declaration and the parsed file in, the answers out. It has never seen a file or a binding.
 */
import type { Install } from '@space/workspace'
import type { Persona } from './assistant/prompt'
import { CLEF_CATEGORY_WORDS, type SpamQuestions } from './cloudflare/spam-check'

/** One install's mailbox content, asked by address (trimmed and lowercased). */
export interface MailboxContent {
  /** The persona the mailbox's assistant speaks with, or null: the assistant does nothing for a mailbox nobody has written one for. */
  persona(address: string | null | undefined): Persona | null
  /** The questions the mailbox's mail is put to, or null: a mailbox not named is never put to the spam classifier, and its switch refuses to turn on. */
  spamQuestions(address: string | null | undefined): SpamQuestions | null
  /** Whether the mailbox has spam questions. */
  hasSpamQuestions(address: string | null | undefined): boolean
  /** Whether any mailbox of the install has spam questions: the spam check's model binding is used only then. */
  anySpamQuestions(): boolean
}

export class MailboxContentError extends Error {
  constructor(readonly problems: string[]) {
    super(`The install's mailbox content is not valid:\n- ${problems.join('\n- ')}`)
    this.name = 'MailboxContentError'
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

const key = (address: string | null | undefined): string =>
  typeof address === 'string' ? address.trim().toLowerCase() : ''

function unknownKeys(where: string, o: Obj, allowed: readonly string[], problems: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`${where}: unknown field "${k}"`)
}

function readPersonas(raw: unknown, install: Install, problems: string[]): Map<string, Persona> {
  const personas = new Map<string, Persona>()
  if (raw === undefined) return personas
  if (!isObj(raw)) {
    problems.push('personas: an object keyed by mailbox address')
    return personas
  }
  for (const [address, p] of Object.entries(raw)) {
    const where = `personas.${address}`
    const k = key(address)
    if (k !== address) problems.push(`${where}: the address is lower case and bare`)
    if (install.businessOf(k) === null)
      problems.push(`${where}: not a mailbox of any business of this install (businesses in the declaration)`)
    if (!isObj(p)) {
      problems.push(`${where}: an object with role, signature and us`)
      continue
    }
    unknownKeys(where, p, ['role', 'signature', 'us', 'rules'], problems)
    const role = text(p.role)
    const signature = text(p.signature)
    const us = text(p.us)
    if (role === null) problems.push(`${where}.role: required`)
    if (signature === null) problems.push(`${where}.signature: required`)
    if (us === null) problems.push(`${where}.us: required`)
    const rules = p.rules === undefined ? null : text(p.rules)
    if (p.rules !== undefined && rules === null) problems.push(`${where}.rules: a paragraph, or left out`)
    if (role !== null && signature !== null && us !== null)
      personas.set(k, { role, signature, us, ...(rules !== null && { rules }) })
  }
  return personas
}

/** One mailbox's question set, or null with what is wrong with it said in `problems`. */
function readQuestionSet(where: string, q: unknown, problems: string[]): SpamQuestions | null {
  if (!isObj(q)) {
    problems.push(`${where}: an object with categories and questions`)
    return null
  }
  unknownKeys(where, q, ['categories', 'questions'], problems)
  const known = Object.keys(CLEF_CATEGORY_WORDS)
  if (!Array.isArray(q.categories) || q.categories.length === 0 || q.categories.some((c) => typeof c !== 'string')) {
    problems.push(`${where}.categories: a list of the kinds Clef chooses from`)
    return null
  }
  const kinds = q.categories as string[]
  for (const c of kinds)
    if (!known.includes(c))
      problems.push(
        `${where}.categories: "${c}" is not a kind Clef's reason lines have words for (${known.join(', ')})`,
      )
  if (new Set(kinds).size !== kinds.length) problems.push(`${where}.categories: a kind is listed twice`)
  const asked = q.questions
  const criteria =
    isObj(asked) && isObj(asked.category) && isObj(asked.category.criteria)
      ? Object.keys(asked.category.criteria)
      : null
  if (!isObj(asked) || !isObj(asked.junk) || criteria === null) {
    problems.push(`${where}.questions: an object with a category question (with its criteria) and a junk question`)
    return null
  }
  if (criteria.length !== kinds.length || criteria.some((c) => !kinds.includes(c))) {
    problems.push(`${where}.questions.category.criteria: describes exactly the listed categories (${kinds.join(', ')})`)
  }
  return { categories: kinds, questions: asked }
}

function readQuestions(raw: unknown, install: Install, problems: string[]): Map<string, SpamQuestions> {
  const questions = new Map<string, SpamQuestions>()
  if (raw === undefined) return questions
  if (!isObj(raw)) {
    problems.push('spamQuestions: an object keyed by mailbox address')
    return questions
  }
  for (const [address, q] of Object.entries(raw)) {
    const where = `spamQuestions.${address}`
    const k = key(address)
    if (k !== address) problems.push(`${where}: the address is lower case and bare`)
    if (install.cloudflareMailbox(k) === null)
      problems.push(`${where}: not a Cloudflare mailbox of this install (cloudflareMailboxes in the declaration)`)
    const set = readQuestionSet(where, q, problems)
    if (set !== null) questions.set(k, set)
  }
  return questions
}

/** The mailbox content in `raw` (the parsed content file; `undefined` or `{}` is none) checked against the install's declaration, or a MailboxContentError naming everything wrong with it. */
export function readMailboxContent(raw: unknown, install: Install): MailboxContent {
  const problems: string[] = []
  const given = raw === undefined ? {} : raw
  if (!isObj(given)) throw new MailboxContentError(['the content is not an object'])
  unknownKeys('content', given, ['personas', 'spamQuestions'], problems)
  const personas = readPersonas(given.personas, install, problems)
  const questions = readQuestions(given.spamQuestions, install, problems)

  // A mailbox declared with its spam check on, with nothing to ask, is a switch that would refuse itself in the first request: refused now.
  for (const m of install.cloudflareMailboxes()) {
    if (m.spamCheck === true && !questions.has(m.address))
      problems.push(
        `cloudflareMailboxes: ${m.address} declares its spam check on, so it needs spamQuestions in the content`,
      )
  }

  if (problems.length > 0) throw new MailboxContentError(problems)
  return {
    persona: (address) => personas.get(key(address)) ?? null,
    spamQuestions: (address) => questions.get(key(address)) ?? null,
    hasSpamQuestions: (address) => questions.has(key(address)),
    anySpamQuestions: () => questions.size > 0,
  }
}
