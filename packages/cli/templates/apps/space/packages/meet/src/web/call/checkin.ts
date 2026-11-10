// What a failed check-in means, decided from what is known when its reply comes back. Pure: no page, no
// media. The controller acts on the answer.

export type CheckInFailure =
  /** Stale: it began before this tab's own reconnect. Not an error and not a second window. */
  | 'ignore'
  /** 401: the seat was given up (30 silent seconds). Take it again. */
  | 'reconnect'
  /** 409 on the current connection: it was replaced by another window. */
  | 'end'
  /** Anything else (the network, a 5xx): count it, and show Reconnecting after a few in a row. */
  | 'count'

/**
 * `sent` is the generation the check-in carried; `current` is the tab's generation now. `current` only moves
 * when the join's reply arrives, and the server moves first, so a check-in that lands after the server bumped
 * the generation but before the reply gets a 409 while `sent === current`. `reconnecting` covers that whole
 * window.
 */
export function checkInFailure(status: number | null, sent: number, current: number, reconnecting: boolean): CheckInFailure {
  if (sent !== current || reconnecting) return 'ignore'
  if (status === 401) return 'reconnect'
  if (status === 409) return 'end'
  return 'count'
}
