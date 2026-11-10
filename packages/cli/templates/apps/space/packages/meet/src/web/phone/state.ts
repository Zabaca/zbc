// The dial pad's pure parts: what a number box accepts, how a call's timer reads, and what a call's phase says to a person.
// No React and no network, so `bun test` covers them.

import { type CallLogRow, EMERGENCY, MESSAGES, type Reason, formatUs, parseDestination } from '../../phone-model'
import type { Phase } from './sdk'

/** What a number box keeps of what was typed or pasted: digits, a leading +, and the punctuation people paste. At most 24 characters. */
export function cleanTyped(raw: string): string {
  const kept = raw.replace(/[^\d+()\-.\s]/g, '')
  const plus = kept.trimStart().startsWith('+') ? '+' : ''
  return `${plus}${kept.replace(/\+/g, '')}`.slice(0, 24)
}

/**
 * How the number reads in the box: a number that can be a US one gets its shape as it is typed (a pasted "+1 626-555-0123"
 * included), and anything else, 911 or a foreign number that will be refused with its reason, is left as typed.
 */
export function shown(typed: string): string {
  let digits = typed.replace(/\D/g, '')
  if (typed.trimStart().startsWith('+')) {
    if (!digits.startsWith('1')) return typed
    digits = digits.slice(1)
  } else if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  return digits.length === 0 || digits.length > 10 || !/^[2-9]/.test(digits) ? typed : formatUs(digits)
}

/** A key pressed on the pad, added to the box. */
export const press = (typed: string, key: string): string => shown(cleanTyped(`${typed}${key}`))

/** The last digit taken off, the way a phone's delete key does. */
export function backspace(typed: string): string {
  const plus = typed.trimStart().startsWith('+') ? '+' : ''
  return shown(`${plus}${typed.replace(/\D/g, '').slice(0, -1)}`)
}

/** True when the box holds 911: a call to it is placed at once, with nothing asked of meet first. */
export function isEmergencyTyped(typed: string): boolean {
  const p = parseDestination(typed)
  return p.ok && p.dest.kind === 'emergency'
}

export const EMERGENCY_TEXT = EMERGENCY

/** 0:07, 12:03, 1:02:03. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/**
 * Why meet's webhook refused or could not place a call, in words, from the log row it wrote: the page's first step already said
 * no to what it could, so this is for the rest (the approval spent or expired, the month used up since, a dial that failed).
 * Null for a row that is neither.
 */
export function refusalText(row: Pick<CallLogRow, 'outcome' | 'reason'>): string | null {
  if (row.outcome === 'failed') return 'The call could not be connected. Try again.'
  if (row.outcome !== 'refused') return null
  if (row.reason && Object.hasOwn(MESSAGES, row.reason)) return MESSAGES[row.reason as Reason]
  return 'meet did not approve that call. Dial it again.'
}

/** What the call bar says. */
export function phaseText(phase: Phase, cause?: string): string {
  switch (phase) {
    case 'dialing':
      return 'Calling'
    case 'ringing':
      return 'Ringing'
    case 'active':
      return 'Connected'
    case 'ended':
      return cause === 'refused' || cause === 'CALL_REJECTED' ? 'meet did not allow that call' : cause === 'network' ? 'Could not reach meet' : 'Call ended'
  }
}

/** The tab's title while a call to the line's number rings, flashed against the usual one so it is noticed from another tab. */
export const ringTitle = (display: string): string => `Call from ${display || 'an unknown number'} - meet`

/** The ring's cadence: the usual two seconds on and four off. */
export const RING_ON_MS = 2000
export const RING_OFF_MS = 4000

/** What a row of the log says of how a call ended. */
export function outcomeText(r: Pick<CallLogRow, 'outcome' | 'minutes' | 'answeredBy'>): string {
  switch (r.outcome) {
    case 'completed':
      return `${r.minutes} min`
    case 'not-answered':
      return 'No answer'
    case 'refused':
      return 'Refused'
    case 'failed':
      return 'Did not connect'
    case 'abandoned':
      return 'Hung up first'
    case 'dialing':
      return 'In progress'
    case 'ringing':
      return 'Ringing'
    case 'answered':
      return `Answered${r.answeredBy ? ` by ${r.answeredBy}` : ''}, ${r.minutes} min`
    case 'forwarded':
      return `Taken on the cell, ${r.minutes} min`
    case 'voicemail':
      return 'Left a voicemail'
    case 'missed':
      return 'Missed'
  }
}
