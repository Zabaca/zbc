// What a device remembers between calls: the name, and the Noise cancellation and
// Blur choices. localStorage can throw (private windows, blocked site data), so
// every access is wrapped and the page works without it.

import { NAME_MAX } from '../model'

/**
 * The name a call link brings with it (`/r/<call>?as=Ines`): the space's Join button on a card adds the person's own name, so the lobby is not asked for
 * one. It only fills the box, which the person can still change; a name that is empty after cleaning is none.
 */
export function nameFromLink(search: string): string | null {
  const raw = new URLSearchParams(search).get('as')
  // the control characters themselves are what is being removed
  const name = raw === null ? '' : raw.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim()
  return name === '' ? null : name
}

export const PREF = { name: 'meet.name', noise: 'meet.noise', blur: 'meet.blur' } as const

export function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

export const writeFlag = (key: string, on: boolean): void => writePref(key, on ? '1' : '0')
