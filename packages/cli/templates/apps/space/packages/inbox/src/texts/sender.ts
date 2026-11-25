/**
 * How a business sender of texts (a short code, a sender that has a name instead of a number, a business chat) is told apart from a person, in one place. A person is the existing `sms` identity (the number in E.164):
 * the one the inbox joins to a contact that already holds the number. A business sender is NEVER joined to a number: it is a `manual` identity whose address begins `text:` and names its kind, so it can never be the
 * same identity as a person's, and the rule for automated senders (src/automated.ts) reads the prefix to file its chat under Bulk. Zero dependencies.
 */
import type { TextsChatKind } from './wire'

/** What every business sender's identity address begins with. */
export const TEXT_SENDER_PREFIX = 'text:'

/** The kinds of chat that are business senders (every kind but a person and a group). */
export type TextSenderKind = Exclude<TextsChatKind, 'person' | 'group'>

/** The one spelling of a business sender's identity address: the kind and the sender as the phone gives it, in lower case with the white space collapsed. */
export const textSenderAddress = (kind: TextSenderKind, address: string): string =>
  `${TEXT_SENDER_PREFIX}${kind}:${address.replace(/\s+/g, ' ').trim().toLowerCase()}`

/** Whether an identity's address is a business sender's. */
export const isTextSenderAddress = (address: string): boolean => address.startsWith(TEXT_SENDER_PREFIX)
