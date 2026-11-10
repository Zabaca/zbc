import { type AiPort, classifyMail as classify, type MailForModel } from '../src/cloudflare/spam-check'
import { bundledContent } from '../src/workspace'

/**
 * Northfield's mailbox content (the personas and spam questions in the bundled install's workspace-content.json), as the suites that pin Northfield's words ask for it by address. Another company's suites build their own
 * (`readMailboxContent`, src/mailbox-content.ts) and give it to the harness.
 */
export const personaFor = (address: string) => bundledContent.persona(address)
export const hasSpamQuestions = (address: string) => bundledContent.hasSpamQuestions(address)
export const spamQuestionsFor = (address: string) => bundledContent.spamQuestions(address)

/** The kinds Clef chooses from for Ridgeway's mail and for ShiftLantern's, as Northfield's content lists them. */
export const CLEF_CATEGORIES = spamQuestionsFor('info@ridgewaycycles.example')?.categories ?? []
export const SHIFTLANTERN_CATEGORIES = spamQuestionsFor('hello@shiftlantern.example')?.categories ?? []

/** `classifyMail` with Northfield's questions for the mailbox named, as the Worker calls it (the questions come from the install's content). */
export const classifyMail = (port: AiPort, mail: MailForModel, options: { mailbox: string; timeoutMs?: number }) =>
  classify(port, mail, {
    questions: spamQuestionsFor(options.mailbox),
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
  })
