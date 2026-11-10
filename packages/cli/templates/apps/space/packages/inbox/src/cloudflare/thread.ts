/**
 * Which conversation an arriving message in a Cloudflare mailbox joins: three rules, in that
 * order, and the order is the design, as pure functions over what the store read, so every case is a table test.
 *
 *   1. In-Reply-To, or else References, naming a message this mailbox already holds (one it received or one the inbox
 *      sent). The only rule that is actually correct: the sender's mail client said which message it answers.
 *   2. The same subject (Re:, Fwd: and the like stripped, case ignored) with an OUTSIDE participant in common with a
 *      conversation already held. A heuristic, knowingly wrong at the edges, which is why it is second and why the
 *      participant test is not optional: without it two strangers who both wrote "Question" read each other's mail.
 *   3. Anything else starts a conversation of its own.
 *
 * "Outside" means not us: the mailbox's own address and every other address on its domain. Every message in a mailbox has
 * one of ours on it by definition (an arriving one is addressed to us), so counting ours would make "shares a
 * participant" true of any two messages and leave the subject to decide alone. Which addresses are ours is the caller's
 * to say (`isOurs`), because it is a fact about the deployment and not about this function.
 *
 * It never merges conversations and never moves a message. A reply to something from before the mailbox's first message
 * names a message the inbox never held, so by rule 1 alone it starts a conversation (a fresh start, by choice), unless rule 2 finds an earlier message since the switch that matches.
 */

/** A subject as threading compares it: prefixes stripped, runs of space collapsed, case ignored. */
export function subjectKey(subject: string): string {
  return subject
    .replace(/^(\s*(re|fwd?|aw)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * The Message-IDs to look for, in the order they are asked: the one answered first, then References from the newest to
 * the oldest (the nearest ancestor is the likeliest to be held). Each once, the message's own id never among them, and at most
 * `limit`, so a header a stranger made enormous costs a bounded number of reads.
 */
export function referenceOrder(
  own: string | null,
  inReplyTo: string | null,
  references: readonly string[],
  limit = 25,
): string[] {
  const ordered = [...(inReplyTo ? [inReplyTo] : []), ...[...references].reverse()]
  const out: string[] = []
  for (const id of ordered) if (id !== own && !out.includes(id)) out.push(id)
  return out.slice(0, limit)
}

/** An outside address on the arriving message or on a held conversation, lower case. */
export const outsiders = (addresses: readonly string[], isOurs: (address: string) => boolean): string[] => [
  ...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => !isOurs(a))),
]

export interface SubjectCandidate {
  id: string
  /** Outside participants of the conversation, lower case. */
  outside: readonly string[]
}

/**
 * Rule 2: the first candidate (the caller hands them newest first, all of them the same subject) that shares an outside
 * participant with the arriving message. Null when there is none, and also when the arriving message has no outside
 * participant at all, which leaves nothing to compare: the safe direction, a conversation of its own.
 */
export function bySubject(outside: readonly string[], candidates: readonly SubjectCandidate[]): string | null {
  if (outside.length === 0) return null
  return candidates.find((c) => c.outside.some((a) => outside.includes(a)))?.id ?? null
}
