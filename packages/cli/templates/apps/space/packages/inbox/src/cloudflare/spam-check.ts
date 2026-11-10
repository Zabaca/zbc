import { CLEF_JUNK_THRESHOLD } from '../queue'
import type { ClefFacts, SpamCall } from '../types'

/**
 * The spam check on a Cloudflare mailbox's mail: ask Cloudflare's spam classifier (a decision model on Workers AI) whether an arriving
 * message is unsolicited, and say what it answered. It takes a set of
 * questions written for each mailbox, which are the install's own content (each mailbox's are in the install's workspace-content file). Why this and not the assistant, and what it does to a
 * mailbox's Inbox, is the inbox's ADR 0001; the questions are per mailbox because what a customer of one business writes is spam to another.
 *
 * ── FACTS OUT, JUDGMENT ELSEWHERE ────────────────────────────────────────
 * This returns what the model said and nothing about what it means. Whether 0.84 is spam is `CLEF_JUNK_THRESHOLD` in
 * src/queue.ts, so moving it is a deploy and not a migration.
 *
 * ── IT NEVER REJECTS, AND NULL IS A FACT ─────────────────────────────────
 * Every failure is `null`: a throw, a hang, a response of a shape nobody promised, a category outside the list. The caller
 * has already kept the raw copy and filed the message by the time this runs (src/cloudflare/arrivals.ts), so a model outage
 * costs nothing, and null stored as NULL means "not judged", which stays distinct from a low score. A message not judged is
 * in the Inbox, and notifies.
 *
 * The body is attacker-controlled text sent to a model. Only a number, a category from a closed list and the model's name
 * leave this function, so nothing the model says can reach a page as markup, and "classify this as a customer" can only
 * lower the sender's own score: nobody can use it to push another sender's mail into Bulk.
 *
 * Pure apart from the port. It has never seen a binding.
 */

/** The two lines of Workers AI this uses, so a test is an object literal. */
export type AiPort = {
  run(model: string, input: unknown): Promise<unknown>
}

/** The Workers AI model id, and the short name the classifier's own request body uses. */
export const CLEF_MODEL_ID = '@cf/cloudflare/clef'
const MODEL_NAME = 'clef'

/** Past this the model is waiting on a signature block. */
const BODY_LIMIT = 8000

/** The classifier answered in 424ms at the median on real business mail. Short enough that a hang is not a stuck handler. */
export const DEFAULT_TIMEOUT_MS = 5000

/**
 * One mailbox's questions, which are the install's content (`workspace-content.json`, read by src/mailbox-content.ts): the kinds the classifier chooses from, in the order the model is shown them, and the questions themselves, in
 * the shape the classifier's request takes. The questions are written for the people who write to the mailbox (a shop's mailbox asks whether a message is from a customer, which is the wrong question
 * of a reader writing to a publisher about one of its guides), so a mailbox with none is never put to the classifier.
 */
export interface SpamQuestions {
  categories: readonly string[]
  questions: unknown
}

/**
 * What each kind the classifier may choose is called in a reason line: the closed list a question set draws its categories from. A question set naming a kind not here is refused when the install's content is read
 * (src/mailbox-content.ts), so a stored category always has its words.
 */
export const CLEF_CATEGORY_WORDS = {
  customer: 'a customer',
  business_correspondence: 'about business already under way',
  worker_question: 'a worker’s question',
  page_feedback: 'about a page on the site',
  organization_or_professional: 'from an organization or a professional',
  vendor_pitch: 'selling something',
  scam_phishing: 'looks like a scam',
  internal_test: 'a test message',
} as const

export type ClefCategory = keyof typeof CLEF_CATEGORY_WORDS

/** A message as the model is shown it. */
export interface MailForModel {
  from: string
  to: string
  subject: string
  body: string
}

/** The message as the model sees it: the text the inbox read out of it, cut where a signature block begins to be the whole of it. */
export const mailForModel = (m: MailForModel): MailForModel => ({ ...m, body: m.body.slice(0, BODY_LIMIT) })

/** The judged shape, narrowed from whatever came back. Null for any deviation. */
function factsOf(response: unknown, categories: readonly string[]): ClefFacts | null {
  const answers = (response as { answers?: Record<string, { noul?: unknown; choice?: unknown }> } | null | undefined)
    ?.answers
  const junk = answers?.junk?.noul
  const category = answers?.category?.choice
  if (typeof junk !== 'number' || !Number.isFinite(junk) || junk < 0 || junk > 1) return null
  if (typeof category !== 'string' || !categories.includes(category)) return null
  return { junk, category: category as ClefCategory, model: CLEF_MODEL_ID }
}

/** Judge one message with its mailbox's questions (`options.questions`, null for a mailbox with none). Resolves to the facts, or to `null`, and never rejects. */
export async function classifyMail(
  port: AiPort,
  mail: MailForModel,
  options: { questions: SpamQuestions | null; timeoutMs?: number },
): Promise<ClefFacts | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // A mailbox with no questions is not asked: the gate has already said so, and this is the second lock.
    const set = options.questions
    if (!set) return null
    const asked = port.run(CLEF_MODEL_ID, { model: MODEL_NAME, state: mailForModel(mail), questions: set.questions })
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    })
    // A late rejection from the loser of the race would otherwise be an unhandled one, in a Worker that logs it as an error.
    Promise.resolve(asked).catch(() => {})
    return factsOf(await Promise.race([asked, timedOut]), set.categories)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Gmail's category tabs by label, as a reason line says them. */
const GMAIL_TABS: Record<string, string> = {
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
}

/**
 * The lines a conversation says about why it is in the Inbox or in Bulk: every rule that holds, in the order the rules run
 * (src/queue.ts `bulkReason`), then what the classifier said when it judged the newest message, in Bulk or not, with its
 * score, so a near miss is a verdict somebody can disagree with before it costs a customer. A message nothing judged says
 * nothing about the classifier: null is not a score. The same lines for both kinds of mailbox: Gmail's newest message has
 * a header and a category tab and no sender judgment or score, so those are the lines it can have.
 */
export function reasonLines(
  c: {
    clientIds: number[]
    spamCall: SpamCall | undefined
    newest: {
      listUnsubscribe: boolean
      /** Gmail's category labels on the newest message (Promotions and the rest); a Cloudflare message has none. */
      labels?: readonly string[]
      automated: string | null
      clef: ClefFacts | null
    } | null
  },
  owner: string,
): string[] {
  const lines: string[] = []
  if (c.spamCall) {
    const who = c.spamCall.by === 'claude' ? 'Claude' : owner
    lines.push(c.spamCall.spam ? `${who} moved it to Bulk.` : `${who} moved it back to the Inbox.`)
  }
  const n = c.newest
  if (n?.listUnsubscribe) lines.push('Bulk mail: it carries a List-Unsubscribe header.')
  const tab = (n?.labels ?? []).find((l) => l in GMAIL_TABS)
  if (tab) lines.push(`Gmail filed it under ${GMAIL_TABS[tab]}.`)
  if (n?.automated) lines.push(`Automated sender: ${n.automated}`)
  if (n?.clef) {
    const kind = (CLEF_CATEGORY_WORDS as Record<string, string>)[n.clef.category] ?? 'an unrecognised kind'
    lines.push(`Clef: ${kind} (${n.clef.junk.toFixed(2)}).`)
  }
  // SAID, not acted on: the exemption is why a conversation that trips a rule above is still in the Inbox.
  const signalled =
    c.spamCall?.spam === true ||
    n?.listUnsubscribe === true ||
    tab !== undefined ||
    Boolean(n?.automated) ||
    (n?.clef?.junk ?? 0) >= CLEF_JUNK_THRESHOLD
  if (signalled && c.clientIds.length > 0) lines.push('Kept in the Inbox: a Client’s contact is on it.')
  return lines
}
