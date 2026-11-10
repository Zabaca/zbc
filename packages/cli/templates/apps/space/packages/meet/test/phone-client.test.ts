// The dial pad's pure parts, with no browser: what the number box takes and shows, the timer, and what each phase says.
import { describe, expect, test } from 'bun:test'
import { phaseOf } from '../src/web/phone/sdk'
import { backspace, cleanTyped, elapsed, isEmergencyTyped, outcomeText, phaseText, press, refusalText, ringTitle, shown } from '../src/web/phone/state'

describe('the number box', () => {
  test('keeps digits, a leading plus and the punctuation people paste, and drops everything else', () => {
    expect(cleanTyped('(626) 555-0123')).toBe('(626) 555-0123')
    expect(cleanTyped('abc626xyz')).toBe('626')
    expect(cleanTyped('+1 626 555 0123')).toBe('+1 626 555 0123')
    expect(cleanTyped('62+6')).toBe('626')
    expect(cleanTyped('1'.repeat(40))).toHaveLength(24)
  })

  test('a US number takes its shape as the digits arrive, with or without the 1 or the plus', () => {
    expect(shown('626')).toBe('626')
    expect(shown('6265')).toBe('(626) 5')
    expect(shown('6265550123')).toBe('(626) 555-0123')
    expect(shown('16265550123')).toBe('(626) 555-0123')
    expect(shown('+1 626-555-0123')).toBe('(626) 555-0123')
  })

  test('what cannot be a US number is left as typed, so its refusal reads against what was typed', () => {
    expect(shown('+44 20 7946 0958')).toBe('+44 20 7946 0958')
    expect(shown('1')).toBe('1')
    expect(shown('0265550123')).toBe('0265550123')
    expect(shown('911')).toBe('911')
  })

  test('keys add digits one at a time, and delete takes one off', () => {
    let box = ''
    for (const k of '6265550123') box = press(box, k)
    expect(box).toBe('(626) 555-0123')
    expect(backspace(box)).toBe('(626) 555-012')
    expect(backspace('(626) 5')).toBe('626')
    expect(backspace('6')).toBe('')
    expect(backspace('')).toBe('')
    expect(backspace('+1 626')).toBe('62')
  })

  test('911 is told apart from any other number, and only as 911', () => {
    expect(isEmergencyTyped('911')).toBe(true)
    expect(isEmergencyTyped(' 911 ')).toBe(true)
    expect(isEmergencyTyped('933')).toBe(false)
    expect(isEmergencyTyped('9111')).toBe(false)
    expect(isEmergencyTyped('+1 911')).toBe(true)
    expect(isEmergencyTyped('+911')).toBe(false)
    expect(isEmergencyTyped('')).toBe(false)
  })
})

describe('the call bar', () => {
  test('the timer reads minutes and seconds, and hours when it gets there', () => {
    expect(elapsed(0)).toBe('0:00')
    expect(elapsed(7_400)).toBe('0:07')
    expect(elapsed(725_000)).toBe('12:05')
    expect(elapsed(3_723_000)).toBe('1:02:03')
    expect(elapsed(-5)).toBe('0:00')
  })

  test('Telnyx’s states are the page’s four phases', () => {
    expect(['new', 'requesting', 'trying', 'recovering'].map(phaseOf)).toEqual(['dialing', 'dialing', 'dialing', 'dialing'])
    expect(['early', 'ringing'].map(phaseOf)).toEqual(['ringing', 'ringing'])
    expect(['active', 'answering', 'held'].map(phaseOf)).toEqual(['active', 'active', 'active'])
    expect(['hangup', 'destroy', 'purge'].map(phaseOf)).toEqual(['ended', 'ended', 'ended'])
    expect(phaseOf('something new')).toBeNull()
  })

  test('each phase says what is happening, and an ended call says why when meet refused it', () => {
    expect(phaseText('dialing')).toBe('Calling')
    expect(phaseText('ringing')).toBe('Ringing')
    expect(phaseText('active')).toBe('Connected')
    expect(phaseText('ended')).toBe('Call ended')
    expect(phaseText('ended', 'refused')).toBe('meet did not allow that call')
    expect(phaseText('ended', 'network')).toBe('Could not reach meet')
  })
})

describe('why a call meet’s webhook refused was refused, in words', () => {
  test('a reason meet’s rules know is told as they tell it', () => {
    expect(refusalText({ outcome: 'refused', reason: 'cap' })).toContain('minutes are used up')
    expect(refusalText({ outcome: 'refused', reason: 'setup' })).toContain('911 address')
    expect(refusalText({ outcome: 'refused', reason: 'territory' })).toContain('Canada')
  })
  test('an approval that was spent, expired or missing says to dial again', () => {
    for (const reason of ['ticket', 'no-ticket', null]) expect(refusalText({ outcome: 'refused', reason })).toBe('meet did not approve that call. Dial it again.')
  })
  test('a dial that failed says so, and a call that went through says nothing', () => {
    expect(refusalText({ outcome: 'failed', reason: 'dial' })).toContain('could not be connected')
    for (const outcome of ['completed', 'not-answered', 'abandoned', 'dialing'] as const) expect(refusalText({ outcome, reason: null })).toBeNull()
  })
})

describe('calls in, as the page words them', () => {
  const row = (outcome: Parameters<typeof outcomeText>[0]['outcome'], minutes = 0, answeredBy: string | null = null) => ({ outcome, minutes, answeredBy })

  test('each way a call in can end has its words, and a call out keeps its own', () => {
    expect(outcomeText(row('answered', 3, 'Tessa'))).toBe('Answered by Tessa, 3 min')
    expect(outcomeText(row('answered', 1))).toBe('Answered, 1 min')
    expect(outcomeText(row('forwarded', 2))).toBe('Taken on the cell, 2 min')
    expect(outcomeText(row('voicemail'))).toBe('Left a voicemail')
    expect(outcomeText(row('missed'))).toBe('Missed')
    expect(outcomeText(row('ringing'))).toBe('Ringing')
    expect(outcomeText(row('completed', 4))).toBe('4 min')
    expect(outcomeText(row('refused'))).toBe('Refused')
  })

  test('the title that flashes names the caller, and says so plainly when the number was withheld', () => {
    expect(ringTitle('(213) 555-0199')).toBe('Call from (213) 555-0199 - meet')
    expect(ringTitle('')).toBe('Call from an unknown number - meet')
    expect(ringTitle('(213) 555-0199')).not.toContain('\u2014')
  })

  test('Telnyx’s call states for a call ringing this phone read as ringing, answered, and over', () => {
    expect(phaseOf('ringing')).toBe('ringing')
    expect(phaseOf('answering')).toBe('active')
    expect(phaseOf('active')).toBe('active')
    expect(phaseOf('hangup')).toBe('ended')
  })
})
