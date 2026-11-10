// The phone line's settings, written down once (docs/adr/0004): Telnyx, a 626 number named for the company (`lineWords`), 1,000 minutes a month in meet, and at Telnyx $5 a day,
// US only, at most $0.05 a minute, 3 calls at once; 911 on.
//
// Imported by the Worker, by the setup script (scripts/telnyx-setup.ts, which applies the Telnyx half of these), by the
// install kit (which secrets to push) and by the tests. No imports,
// so the deploy file can read it without pulling in the Worker.

export const LINE = {
  areaCode: '626',
  /** meet's own monthly meter: calls out are refused past this many minutes. 911 is never counted or refused. */
  monthlyMinutes: 1000,
  /** The Telnyx side, which holds even if meet has a bug: an outbound voice profile. */
  telnyx: {
    allowedCountries: ['US'],
    /** Destinations dearer than this a minute are refused by Telnyx. */
    maxRatePerMinute: 0.05,
    dailySpendLimit: '5.00',
    concurrentCalls: 3,
    profileName: 'meet outbound',
    connectionName: 'meet',
  },
  /** Telnyx's prepaid balance under this many dollars emails the owner (checked once a day). */
  lowBalanceUsd: 5,
  /** No call lasts longer than this: it is Telnyx's own maximum. */
  callLimitSecs: 14_400,
  /**
   * Telnyx's webhooks come here (relative to the site's address, which is the space's: https://space.northfield.example). It is under /r/ because that is the prefix of the
   * space's open paths that meet's guest door answers, so Telnyx is told this one address and no other.
   */
  webhookPath: '/r/api/phone/webhook',
  /**
   * A call to the number (docs/adr/0005): every person of the company with a phone registered rings at once
   * for `ringSeconds` (the line's setting, between the bounds, 20 by default); then the line's cell, if one is set, rings for
   * `cellRingSeconds` and must press 1; then a spoken greeting and a voicemail of at most `voicemailSeconds`. A live call is
   * never recorded: the voicemail is the only recording, started only after the greeting, on a call nobody answered.
   */
  inbound: {
    ringSeconds: 20,
    ringSecondsMin: 5,
    ringSecondsMax: 40,
    cellRingSeconds: 15,
    voicemailSeconds: 180,
    /** Telnyx's spoken voice for now; recording an own greeting is left out (docs/adr/0005). What it says names the company: `lineWords`. */
    /** Which voice names Telnyx accepts is for the hand test (docs/adr/0005): this is the one place to change it. */
    voice: 'Polly.Joanna',
    language: 'en-US',
    /** A browser phone's SIP address at Telnyx is `sip:<its credential's user name>@<this>`. */
    sipDomain: 'sip.telnyx.com',
  },
} as const

/** Telnyx's CNAM listing allows this many characters. */
const CALLER_NAME_MAX = 15

/**
 * The line's words that name the company, made from the install's company name (the declaration's `company.name`): no company's name is written here.
 *
 * - callerName: the caller name on phones and carriers that show names, cut to what a CNAM listing allows.
 * - greeting: what a caller hears when nobody answers, before the tone.
 * - screening: what the line's cell hears before it presses 1.
 */
export function lineWords(company: string): { callerName: string; greeting: string; screening: string } {
  return {
    callerName: company.slice(0, CALLER_NAME_MAX).trim(),
    greeting: `You have reached ${company}. Nobody can take your call right now. Please leave a message after the tone, and hang up when you are done.`,
    screening: `Call for ${company}. Press 1 to answer.`,
  }
}

/**
 * The Worker secrets the phone needs, all four or none. The Worker shows no dial pad unless every one is set, and the
 * deploy instance pushes them only when sops holds every one (`phoneSecretsToPush`).
 *
 * - TELNYX_API_KEY: the v2 API key. Server only; it never reaches a browser.
 * - TELNYX_PUBLIC_KEY: the account's webhook public key (portal, Account Settings, Keys and Credentials). Not secret,
 *   but unknown until the account exists, so it is kept beside the rest instead of as a placeholder in a file.
 * - TELNYX_CONNECTION_ID: the credential connection the browser phones register on and calls are dialed through.
 * - TELNYX_NUMBER: the line's number, E.164.
 *
 * The outbound voice profile's id is not here: only the setup script uses it (to attach it to the connection).
 */
export const PHONE_SECRETS = ['TELNYX_API_KEY', 'TELNYX_PUBLIC_KEY', 'TELNYX_CONNECTION_ID', 'TELNYX_NUMBER'] as const

/**
 * Which of the phone's secrets to push as Worker secrets, given the names sops holds: none when it holds none (the phone
 * stays hidden), all when it holds all, and a refusal when it holds some, so a half-set account fails the deploy
 * instance loading, before anything is deployed, and not after.
 */
export function phoneSecretsToPush(names: readonly string[]): readonly string[] {
  const have = PHONE_SECRETS.filter((n) => names.includes(n))
  if (have.length === 0) return []
  if (have.length < PHONE_SECRETS.length) {
    const missing = PHONE_SECRETS.filter((n) => !names.includes(n))
    throw new Error(`secrets.yaml has some of the phone's Telnyx secrets but lacks ${missing.join(', ')}: add all ${PHONE_SECRETS.length} or none`)
  }
  return PHONE_SECRETS
}
