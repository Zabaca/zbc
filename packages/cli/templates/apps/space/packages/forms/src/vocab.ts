/**
 * The words the core, the API and both browser entries share, each defined once. Types only, so the admin and the signer's
 * page import it without pulling in anything else. (A field's type is `FieldType`, in src/fields.ts.)
 */

/** An envelope's life: see src/signing/lifecycle.ts. */
export type EnvelopeStatus = 'draft' | 'sent' | 'prepared' | 'sealing' | 'completed' | 'declined' | 'cancelled' | 'expired'

export type RecipientStatus = 'waiting' | 'sent' | 'opened' | 'consented' | 'signed' | 'declined'

/** What a signer adopts once and applies wherever they sign. */
export type AdoptionKind = 'signature' | 'initials'

/** How they made it. Whatever the method, what is stored is a picture. */
export type AdoptionMethod = 'drawn' | 'typed' | 'uploaded'
