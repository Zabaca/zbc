// Whether this Worker has a phone, decided from what it was deployed with. Kept out of index.ts (which imports the Durable
// Object classes and so cannot be loaded by `bun test`) so the rule "no dial pad unless everything is there" is tested.

import { type DevTelnyx, devTelnyx } from './dev-telnyx'
import { PHONE_SECRETS } from './phone-line'
import type { PhoneRuntime } from './phone-routes'
import { telnyxClient, telnyxHttp } from './telnyx'

export interface PhoneEnv {
  TELNYX_API_KEY?: string
  TELNYX_PUBLIC_KEY?: string
  TELNYX_CONNECTION_ID?: string
  TELNYX_NUMBER?: string
  /** Local development only: Telnyx and the page's phone stood in for, honoured on a localhost host alone. */
  FAKE_TELNYX?: string
}

/** One stand-in per process, so the browser check can read what it was asked across requests. */
let DEV_TELNYX: DevTelnyx | null = null

/**
 * The phone, or null. Null means no dial pad for anyone and a webhook that is not there: a half-set account never ships a
 * broken pad. The stand-in needs FAKE_TELNYX=1 and a localhost host; the real one needs every secret, in the shape it
 * should have (a US number in E.164, and a public key that is 32 bytes of base64).
 */
export function phoneRuntime(env: PhoneEnv, local: boolean, log: (message: string) => void = console.error): PhoneRuntime | null {
  if (local && env.FAKE_TELNYX === '1') {
    DEV_TELNYX ??= devTelnyx()
    return { telnyx: DEV_TELNYX, publicKey: '', number: '+16265550100', connectionId: 'dev-connection', sdk: 'fake', dev: true }
  }
  const { TELNYX_API_KEY: key, TELNYX_PUBLIC_KEY: pub, TELNYX_CONNECTION_ID: connection, TELNYX_NUMBER: number } = env
  const held = [key, pub, connection, number].filter(Boolean).length
  if (held === 0) return null
  if (held < PHONE_SECRETS.length) {
    log(`the phone is hidden: only ${held} of its ${PHONE_SECRETS.length} secrets (${PHONE_SECRETS.join(', ')}) are set`)
    return null
  }
  if (!/^\+1\d{10}$/.test(number as string) || !/^[A-Za-z0-9+/_-]{43}=?$/.test(pub as string)) {
    log('the phone is hidden: TELNYX_NUMBER or TELNYX_PUBLIC_KEY is not in the shape expected')
    return null
  }
  return { telnyx: telnyxClient(telnyxHttp(key as string), { connectionId: connection as string }), publicKey: pub as string, number: number as string, connectionId: connection as string, sdk: 'telnyx', dev: false }
}
