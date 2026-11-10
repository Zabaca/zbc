/**
 * The settings the owner may change, in one place so each is a one-line edit.
 */

// The names the service says about itself (who runs it, the footer's place, the contact address, the sender, the "via" suffix, the seal's reason) are the install's, not settings here: src/service.ts and the declaration's
// `formsService` and `senders`.

/** Finished records are kept this long unless the client says otherwise (years). */
export const DEFAULT_RETENTION_YEARS = 7

/** An unfinished envelope (declined, cancelled, expired, or a draft left alone) is deleted this long after it stops (days). */
export const UNFINISHED_RETENTION_DAYS = 90

/** A finished document holding a sensitive answer is delivered by a private link that works this long (days), every download logged. */
export const SENSITIVE_LINK_DAYS = 90

/** The longest logo an operator may upload (bytes). A logo is loaded by every email, so it stays small. */
export const MAX_LOGO_BYTES = 256 * 1024

/** A finished PDF up to this size is attached to its email; a larger one goes by private link (Cloudflare's message limit is 25 MiB with encoding overhead). */
export const MAIL_ATTACH_MAX_BYTES = 15 * 1024 * 1024

/** An envelope's defaults, each changeable per send. */
export const DEFAULTS = { expiresInDays: 30, reminderEveryDays: 3, reminderMax: 3 } as const

/** Scheduled reminders go out only between these local hours (9:00 up to 17:00) in the client's time zone. */
export const REMINDER_HOURS = { from: 9, until: 17 } as const

/** The most a signature image may be (bytes). */
export const MAX_ADOPTION_BYTES = 512 * 1024

/** How many recipients one envelope may have. */
export const MAX_RECIPIENTS = 20

/** How long an envelope may sit sealing before the sweep tries again (minutes). */
export const SEALING_RETRY_MINUTES = 10

/** The sweep tries to seal an envelope this many times, then gives up and tells the operator. */
export const SEALING_MAX_TRIES = 5
