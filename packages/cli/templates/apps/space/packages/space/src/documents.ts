// A document as the page is given it: title, state, counts and one time, and nothing else. Shared by People (a person's page lists the documents they are on)
// and a conversation (the documents sent from it, drawn as cards), because both are forms' summaries read the same way.
//
// WHAT NEVER APPEARS: a signer's name or address, a link, an answer (private or not), a file's name. The shape below has no field for them, so no change to
// the page can show one; a document holding a private answer is drawn exactly as any other (its title and state), because forms' summary is the same for it.

import type { DocumentState, Documents, Reached } from '@space/workspace'

// What a person is told of a document, in words: shared by the person's page and the card, so the two say it alike.
export const DOCUMENT_WORDS: Record<DocumentState, string> = {
  draft: 'Draft, not sent',
  sent: 'Out for signature',
  prepared: 'Out for signature',
  sealing: 'Being sealed',
  completed: 'Signed and back',
  declined: 'Declined',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

export function documentLine(d: Pick<ShownDocument, 'state' | 'signed' | 'signers'>): string {
  const progress = d.state === 'sent' || d.state === 'prepared' ? `, ${d.signed} of ${d.signers} signed` : ''
  return `${DOCUMENT_WORDS[d.state]}${progress}`
}

/** A document as the page is shown it, on a person's page and as a card in a conversation: title, state and counts. Nothing it holds. */
export interface ShownDocument {
  id: string
  title: string
  state: DocumentState
  signers: number
  signed: number
  /** When it last moved: finished, else sent, else made. */
  at: number
}

export type DocumentsPart =
  | { state: 'ok'; documents: ShownDocument[]; more: boolean }
  | { state: 'not-open-to-you' | 'could-not-be-reached'; message: string }

/** How many documents a person's page, or a conversation, lists: the newest; forms says when there are more. */
export const DOCUMENTS_SHOWN = 25

/** The documents part from forms' answer: the summaries cut down to the shape above, or the sentence that says forms did not give them (`notListed` finishes "Forms could not be reached just now, so ..."). */
export function documentsPartOf(answer: Reached<Documents>, notListed: string): DocumentsPart {
  if (answer.ok) {
    return {
      state: 'ok',
      documents: answer.value.documents.map((d) => ({ id: d.id, title: d.title, state: d.state, signers: d.signers, signed: d.signed, at: d.completedAt ?? d.sentAt ?? d.createdAt })),
      more: answer.value.more,
    }
  }
  return answer.kind === 'refused'
    ? { state: 'not-open-to-you', message: 'Documents are not open to you.' }
    : { state: 'could-not-be-reached', message: `Forms could not be reached just now, so ${notListed}` }
}
