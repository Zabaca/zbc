// The line's Telnyx side, written down as code and applied by `bun scripts/telnyx-setup.ts` (docs/adr/0004, section 6).
// It is described in a file in the package and applied by a script that shows what it would change
// and changes it only when told.
//
// Idempotent: every step reads what is there first, and a second run with nothing left to do changes nothing. Dry-run by
// default: reads (GET) always happen, every write waits for `apply`. Buying the number spends money, so it has its own switch
// (`buy`) on top of `apply`. Never prints the API key. The shapes of the requests were read from Telnyx's docs
// and none has been run against an account: that is what the first real run, with the owner, is for.

import type { Install } from '@space/workspace'
import { LINE, lineWords } from './phone-line'
import { type E911Address, formatUs } from './phone-model'
import { type Http, TelnyxError, telnyxClient } from './telnyx'
import { nameFromEmail } from './workspace-model'

export interface SetupOptions {
  /** Make the changes. Without it, say what would change and touch nothing. */
  apply: boolean
  /** Also buy a 626 number if the account has none. Needs `apply`. */
  buy: boolean
  /**
   * Buy another number even though the account already has a 626 number or an order for one is still pending. Without it
   * a rerun never buys a second number (an order takes a while to land, and a second buy is a second monthly charge).
   */
  buyAnother?: boolean
  /** Use this number (E.164) instead of finding or buying one. It must already be on the account. */
  number?: string
  /** A person's 911 address, to put on their number: the way the person gives it in the app, done once here for the first one. */
  addresses: Array<{ email: string; address: E911Address }>
  /** The install the line is for: its company names the caller name, and its declaration says who has the dial pad. */
  install: Install
  /** The site's address, for the webhook URL. */
  site: string
  log: (line: string) => void
}

export interface SetupResult {
  /** Writes made, or that would be made in a dry run. */
  changes: number
  profileId: string | null
  connectionId: string | null
  number: string | null
  /** What is still to do by hand, in order. */
  todo: string[]
}

interface Item {
  id: string
  [k: string]: unknown
}

/** Every item of a list endpoint, page by page. */
async function listAll(http: Http, path: string): Promise<Item[]> {
  const out: Item[] = []
  for (let page = 1; page <= 20; page++) {
    const r = await http.request<{ data?: Item[]; meta?: { total_pages?: number } }>('GET', `${path}${path.includes('?') ? '&' : '?'}page[size]=250&page[number]=${page}`)
    out.push(...(r.data ?? []))
    if (page >= (r.meta?.total_pages ?? 1)) break
  }
  return out
}

/** A number order that must be waited for before another is placed: still pending, or just placed for a number not yet listed. */
function blocksBuying(order: Item, area: string): boolean {
  const status = String(order.status ?? '')
  const numbers = (order.phone_numbers as Array<{ phone_number?: string }> | undefined) ?? []
  // An order that lists its numbers blocks only if one is in this area code; one that does not is assumed to be ours.
  const hereabouts = numbers.length === 0 || numbers.some((n) => String(n.phone_number ?? '').startsWith(`+1${area}`))
  if (!hereabouts) return false
  if (!['success', 'failure', 'cancelled', 'canceled', 'expired'].includes(status)) return true
  const placed = Date.parse(String(order.created_at ?? ''))
  return status === 'success' && Number.isFinite(placed) && Date.now() - placed < 24 * 3_600_000
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const num = (v: unknown): number => Number(v)

/** A password nobody keeps: the connection logs phones in with telephony credentials, never with its own user name. */
function throwaway(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return `Mt${[...bytes].map((b) => b.toString(36).padStart(2, '0')).join('')}9`
}

export async function runSetup(http: Http, o: SetupOptions): Promise<SetupResult> {
  const result: SetupResult = { changes: 0, profileId: null, connectionId: null, number: null, todo: [] }
  const say = (line: string) => o.log(line)
  const company = o.install.company.name
  const callerName = lineWords(company).callerName
  const verb = o.apply ? 'DONE ' : 'WOULD'
  /** One write: done, or only said, depending on `apply`. */
  async function change<T>(what: string, run: () => Promise<T>): Promise<T | null> {
    result.changes += 1
    say(`  ${verb} ${what}`)
    return o.apply ? await run() : null
  }
  say(o.apply ? 'Applying to the Telnyx account.' : 'Dry run: nothing will be changed. Pass --apply to make these changes.')

  // 1. The outbound voice profile: what Telnyx itself enforces, whatever meet does.
  say('\n1. Outbound voice profile (US only, a price ceiling, a daily spend limit, a call limit)')
  const t = LINE.telnyx
  const wantProfile = {
    name: t.profileName,
    traffic_type: 'conversational',
    service_plan: 'global',
    enabled: true,
    concurrent_call_limit: t.concurrentCalls,
    whitelisted_destinations: [...t.allowedCountries],
    max_destination_rate: t.maxRatePerMinute,
    daily_spend_limit: t.dailySpendLimit,
    daily_spend_limit_enabled: true,
    call_recording: { call_recording_type: 'none' },
  }
  const profile = (await listAll(http, '/outbound_voice_profiles')).find((p) => p.name === t.profileName)
  if (!profile) {
    const made = await change(`create the profile "${t.profileName}": ${t.allowedCountries.join(', ')} only, at most $${t.maxRatePerMinute} a minute, $${t.dailySpendLimit} a day, ${t.concurrentCalls} calls at once`, () =>
      http.request<{ data: Item }>('POST', '/outbound_voice_profiles', wantProfile),
    )
    result.profileId = made?.data.id ?? null
  } else {
    result.profileId = profile.id
    const drift: string[] = []
    if (profile.enabled !== true) drift.push('enabled')
    if (num(profile.concurrent_call_limit) !== t.concurrentCalls) drift.push(`calls at once (${String(profile.concurrent_call_limit)})`)
    if (!same([...((profile.whitelisted_destinations as string[]) ?? [])].sort(), [...t.allowedCountries].sort())) drift.push(`destinations (${String(profile.whitelisted_destinations)})`)
    if (num(profile.max_destination_rate) !== t.maxRatePerMinute) drift.push(`price ceiling (${String(profile.max_destination_rate)})`)
    if (num(profile.daily_spend_limit) !== num(t.dailySpendLimit) || profile.daily_spend_limit_enabled !== true) drift.push(`daily limit (${String(profile.daily_spend_limit)}, on: ${String(profile.daily_spend_limit_enabled)})`)
    if (drift.length === 0) say(`  OK    the profile "${t.profileName}" already has the limits`)
    else await change(`set the profile's ${drift.join(', ')}`, () => http.request('PATCH', `/outbound_voice_profiles/${profile.id}`, wantProfile))
  }

  // 2. The credential connection browsers register on: calls parked, the webhook, the profile above.
  say('\n2. Credential connection (every browser call is held until meet decides)')
  const webhookUrl = `${o.site.replace(/\/+$/, '')}${LINE.webhookPath}`
  const wantConnection = (profileId: string | null) => ({
    active: true,
    webhook_event_url: webhookUrl,
    webhook_api_version: '2',
    webhook_timeout_secs: 25,
    outbound: { call_parking_enabled: true, outbound_voice_profile_id: profileId ?? '(the new profile)' },
  })
  const connection = (await listAll(http, '/credential_connections')).find((c) => c.connection_name === t.connectionName)
  if (!connection) {
    const made = await change(`create the connection "${t.connectionName}" (its own user name and password are made and thrown away: phones log in with credentials meet makes)`, () =>
      http.request<{ data: Item }>('POST', '/credential_connections', { connection_name: t.connectionName, user_name: `meet${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, password: throwaway(), active: true }),
    )
    result.connectionId = made?.data.id ?? null
    await change(`point it at ${webhookUrl}, park outbound calls, attach the profile`, () => http.request('PATCH', `/credential_connections/${result.connectionId}`, wantConnection(result.profileId)))
  } else {
    result.connectionId = connection.id
    const out = (connection.outbound ?? {}) as Record<string, unknown>
    const drift: string[] = []
    if (connection.active !== true) drift.push('active')
    if (connection.webhook_event_url !== webhookUrl) drift.push(`webhook address (${String(connection.webhook_event_url)})`)
    if (out.call_parking_enabled !== true) drift.push('park outbound calls')
    if (result.profileId && out.outbound_voice_profile_id !== result.profileId) drift.push('outbound voice profile')
    if (drift.length === 0) say(`  OK    the connection "${t.connectionName}" is set`)
    else await change(`set the connection's ${drift.join(', ')}`, () => http.request('PATCH', `/credential_connections/${connection.id}`, wantConnection(result.profileId)))
  }

  // 3. The number: an existing 626 number on the account, or one bought (only with --buy), then its caller name.
  say(`\n3. The ${LINE.areaCode} number and its caller name "${callerName}"`)
  const owned = await listAll(http, '/phone_numbers')
  let number: Item | undefined
  if (o.number) {
    number = owned.find((n) => n.phone_number === o.number)
    if (!number) throw new Error(`${o.number} is not on this Telnyx account`)
  } else {
    const mine = owned.filter((n) => String(n.phone_number).startsWith(`+1${LINE.areaCode}`))
    if (mine.length > 1 && !o.buyAnother) throw new Error(`The account has ${mine.length} ${LINE.areaCode} numbers (${mine.map((n) => n.phone_number).join(', ')}): say which with --number`)
    // With --buy-another the number to use is the one bought below, not one already there.
    number = o.buyAnother ? undefined : mine[0]
  }
  // An order placed earlier may not have landed yet: buying again would be a second number and a second monthly charge.
  const waiting = number || o.buyAnother ? [] : (await listAll(http, '/number_orders')).filter((order) => blocksBuying(order, LINE.areaCode))
  if (!number && waiting.length > 0) {
    const named = waiting.map((w) => String(w.id)).join(', ')
    say(`  WAIT  an order for a ${LINE.areaCode} number is still on the account (${named}): not buying another`)
    result.todo.push(`The order for the ${LINE.areaCode} number (${named}) has not landed: run this again in a minute. Only if it was refused for good, pass --apply --buy --buy-another to buy a different one.`)
  } else if (!number) {
    const found = await http.request<{ data?: Array<{ phone_number: string }> }>(
      'GET',
      `/available_phone_numbers?filter[country_code]=US&filter[national_destination_code]=${LINE.areaCode}&filter[phone_number_type]=local&filter[features][]=voice&filter[features][]=emergency&filter[limit]=5`,
    )
    const have = new Set(owned.map((n) => n.phone_number))
    const pick = found.data?.map((n) => n.phone_number).find((n) => !have.has(n))
    if (!pick) {
      result.todo.push(`Telnyx has no ${LINE.areaCode} number with voice and 911 to buy right now: try later, or pick another area code with the owner.`)
      say(`  STOP  no ${LINE.areaCode} number is on offer`)
    } else if (!(o.apply && o.buy)) {
      result.changes += 1
      say(`  WOULD buy ${pick} (${formatUs(pick.slice(2))}), a monthly charge and 911 service: pass --apply --buy to buy it`)
      result.todo.push(`Buy the number: run with --apply --buy once the owner has said yes to ${pick}.`)
    } else {
      await change(`buy ${pick}`, () => http.request('POST', '/number_orders', { phone_numbers: [{ phone_number: pick }] }))
      number = (await listAll(http, '/phone_numbers')).find((n) => n.phone_number === pick)
      if (!number) {
        result.todo.push(`The order for ${pick} is placed but not on the account yet: run this script again in a minute.`)
        say(`  WAIT  the order for ${pick} is not on the account yet`)
      }
    }
  }
  if (number) {
    result.number = number.phone_number as string
    say(`  OK    the number is ${result.number}`)
    if (result.connectionId && number.connection_id !== result.connectionId) {
      await change(`attach ${result.number} to the connection`, () => http.request('PATCH', `/phone_numbers/${(number as Item).id}`, { connection_id: result.connectionId }))
    }
    const voice = (await http.request<{ data?: { cnam_listing?: { cnam_listing_enabled?: boolean; cnam_listing_details?: string } } }>('GET', `/phone_numbers/${number.id}/voice`)).data
    if (voice?.cnam_listing?.cnam_listing_enabled === true && voice.cnam_listing.cnam_listing_details === callerName) {
      say(`  OK    caller name "${callerName}" is listed`)
    } else {
      await change(`list the caller name "${callerName}" for ${result.number}`, () =>
        http.request('PATCH', `/phone_numbers/${(number as Item).id}/voice`, { cnam_listing: { cnam_listing_enabled: true, cnam_listing_details: callerName } }),
      )
    }
  }

  // 4. 911: the address of each person who has the dial pad, on the number their 911 calls leave from.
  say('\n4. 911 addresses (each person gives theirs in the app; this does the first one now)')
  for (const [email, { emergencyNumber }] of Object.entries(o.install.phonePeople())) {
    const onNumber = emergencyNumber === 'line' ? result.number : emergencyNumber
    const given = o.addresses.find((a) => a.email === email)
    if (!onNumber) {
      say(`  SKIP  ${email}: the number their 911 calls leave from is not on the account yet`)
      continue
    }
    const n = (number && onNumber === result.number ? number : (await listAll(http, '/phone_numbers')).find((x) => x.phone_number === onNumber)) as Item | undefined
    if (!n) {
      say(`  SKIP  ${email}: ${onNumber} is not on this account`)
      result.todo.push(`${email}'s 911 number ${onNumber} is not on the Telnyx account: order it, then run this again.`)
      continue
    }
    const emergency = (await http.request<{ data?: { emergency?: { emergency_enabled?: boolean; emergency_address_id?: string } } }>('GET', `/phone_numbers/${n.id}/voice`)).data?.emergency
    if (emergency?.emergency_enabled === true && emergency.emergency_address_id) {
      say(`  OK    911 is on for ${onNumber} with an address (${email} changes it from the phone panel, which puts the new one on it)`)
    } else if (!given) {
      say(`  TODO  911 is off for ${onNumber}: no address given for ${email} (--address ${email}=Street|Unit|City|ST|ZIP)`)
      result.todo.push(`911 for ${email}: they give their address in the phone panel the first time, or pass --address here.`)
    } else {
      await change(`put ${email}'s address (${given.address.street}, ${given.address.city}) on ${onNumber} for 911`, async () => {
        const words = nameFromEmail(email).split(' ')
        return telnyxClient(http, { connectionId: result.connectionId ?? '' }).registerEmergencyAddress(onNumber, given.address, { first: words[0] ?? company, last: words.slice(1).join(' ') || company, business: company })
      })
    }
  }

  // 5. What this cannot do: the account itself and the things done on other companies' pages.
  const balance = await http.request<{ data?: { available_credit?: string } }>('GET', '/balance').catch((e: unknown) => (e instanceof TelnyxError ? null : Promise.reject(e)))
  say(`\nBalance on the account: ${balance?.data?.available_credit ? `$${balance.data.available_credit}` : 'not readable'}`)
  result.todo.push(
    'Prepaid balance with automatic top-up OFF (Telnyx portal, Billing): the balance is the most the line can ever cost.',
    'The webhook public key (portal, Account Settings, Keys and Credentials) goes into sops as TELNYX_PUBLIC_KEY.',
    'Register the number with the Free Caller Registry (a web form; outward-facing, on the owner\'s word).',
    'Calls in (docs/adr/0005): nothing more is set here. Once meet is applied, call the number and check Telnyx\'s log shows the call on the connection and meet\'s webhook an incoming call; the hand test at the end of ADR 0005 lists what the documentation did not settle. Set the cell and the ring time in the Phone panel.',
  )
  if (result.connectionId && result.number) {
    say('\nPut these in the install\'s secrets file (sops), then apply the space:')
    say('  TELNYX_API_KEY        the key you ran this with (already in sops)')
    say('  TELNYX_PUBLIC_KEY     from the portal, as above')
    say(`  TELNYX_CONNECTION_ID  ${result.connectionId}`)
    say(`  TELNYX_NUMBER         ${result.number}`)
  }
  say('')
  say(o.apply ? `${result.changes} change${result.changes === 1 ? '' : 's'} made.` : `${result.changes} change${result.changes === 1 ? '' : 's'} would be made.`)
  for (const line of result.todo) say(`  By hand: ${line}`)
  return result
}
