/**
 * The consent a signer gives before anything else, and the intent they confirm before their signature is applied.
 * Versioned in code: the version and the SHA-256 of the exact text shown are recorded with the consent event, and the
 * certificate of completion prints the full text of the version each signer agreed to.
 *
 * A version is never edited once a signer may have seen it: a changed word is a new version, and the old one stays in
 * `TEXTS` so an envelope that recorded it can still print what it said. The current wording is the paralegal pass's
 * (a legal research pass): research to inform an attorney, not
 * legal advice, and the owner's sign-off on it is still the gate before a client uses the service.
 *
 * ONE EXCEPTION, recorded: '2026-11-01.1' gained its own-company first sentence (`ServiceWords.ownCompanyOnly`, for an install whose Forms sends only for its company) before any install that declares it had sent a document,
 * so no signer has seen it differently; the sentence a signer sees is the version's text for that install, and every other install's text is word for word what it was. A later change of this kind is a new version.
 */
import { sha256Hex } from './bytes'
import type { ServiceWords } from './service'

/** The version a new consent records. */
export const CONSENT_VERSION = '2026-11-01.1'

export const CONSENT_BUTTON = 'I agree, continue'

/** Where the sample PDF's link sits in the last paragraph: the signer's page draws a link in its place. */
export const SAMPLE_LINK = '[Open sample PDF]'

/** What the consent text says about the document and the business. */
export interface ConsentContext {
  display_name: string
  legal_name: string
  reply_to: string
  /** The envelope's title. */
  title: string
  /** The install's names for the service and who runs it: the only words of the text that are not the document's or the business's own (src/service.ts). */
  service: ServiceWords
}

type TextOf = (c: ConsentContext) => string[]

const TEXTS: Record<string, TextOf> = {
  // The first draft. Kept word for word for the envelopes that recorded it; no new envelope uses it.
  '2026-10-31.1': (c) => [
    `${c.display_name} is using ${c.service.name} to send you a document to sign electronically. ${c.service.runBy.name} runs the service for ${c.display_name}; it is not a party to what you sign.`,
    'By agreeing, you consent to receive this document, and any notices about it, and to sign it, electronically instead of on paper. This consent covers this document and the messages sent about it, and nothing else.',
    `You can ask for a paper copy at no charge by contacting ${c.display_name} at ${c.reply_to}. You can withdraw your consent at any time before you sign by selecting Decline, or by contacting ${c.display_name} at the same address. If you withdraw, this document will not be completed electronically and ${c.display_name} will deal with you on paper.`,
    'To sign you need a current web browser and a way to open PDF files. When everyone has signed, you will be emailed the finished document, and you can download a copy from the same link for 90 days.',
    'By selecting the button below you confirm that you can read this page on the device you are using and that you can open PDF files.',
  ],
  '2026-11-01.1': (c) => {
    const who = c.display_name
    return [
      c.service.ownCompanyOnly
        ? `${who} (${c.legal_name}) is using ${c.service.name}, which it runs itself, to send you ${c.title} to sign electronically.`
        : `${who} (${c.legal_name}) is using ${c.service.name} to send you ${c.title} to sign electronically. ${c.service.runBy.legalName} runs the service for ${who}; it is not a party to what you sign.`,
      `By selecting "${CONSENT_BUTTON}" you agree to receive this document, the finished copy and any notices about it electronically, and to sign it electronically instead of on paper. This consent covers this document only; ${who} will ask again for any other document.`,
      `You have the right to receive this document on paper instead. To ask for paper, or for a paper copy of anything you receive electronically, contact ${who} at ${c.reply_to}. ${who} does not charge for paper copies or for withdrawing your consent.`,
      `You can withdraw this consent at any time: before you sign, by selecting Decline (which ends this document for everyone asked to sign it) or by contacting ${who}; after you sign, by contacting ${who}. Withdrawing does not undo anything already signed or delivered electronically. Afterwards ${who} will deal with you on paper, which may take longer.`,
      `If your email address changes before this document is finished, tell ${who} at ${c.reply_to} so the link can go to your new address.`,
      'What you need: a phone, tablet or computer connected to the internet; a current version of Safari, Chrome, Edge or Firefox; access to the email account this was sent to; and a way to open and save PDF files (most devices have one built in; Adobe Acrobat Reader is free). To keep a copy you need space to save a file, or a printer.',
      `When everyone has signed you will get the finished document by email, either attached or as a private link that works for 90 days. Download and save it then. After that, ask ${who} for a copy.`,
      `Open this sample PDF: ${SAMPLE_LINK}. By selecting "${CONSENT_BUTTON}" you confirm that you could open it, that you can read this page on this device, and that you agree to the terms above.`,
    ]
  },
}

/** The paragraphs of one version for one document, or null for a version this code has never had. */
export const consentTextFor = (version: string, c: ConsentContext): string[] | null => TEXTS[version]?.(c) ?? null

/** What a signer is shown now. */
export const consentParagraphs = (c: ConsentContext): string[] => TEXTS[CONSENT_VERSION]!(c)

/** The hash of exactly what was shown: the version and every paragraph. */
export const consentHashOf = (version: string, paragraphs: string[]): Promise<string> => sha256Hex([version, ...paragraphs].join('\n'))

export const consentHash = (c: ConsentContext): Promise<string> => consentHashOf(CONSENT_VERSION, consentParagraphs(c))

/** What Finish asks the signer to confirm, in the signer's own name. Its hash is recorded with the signed event. */
export const intentText = (name: string): string => `I am ${name}. By selecting Finish and sign, I adopt the signature shown as mine and agree it is the legal equivalent of my handwritten signature on this document.`
