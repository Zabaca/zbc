/**
 * A ULID, for naming WAL objects.
 *
 * The sequence number already orders the log; the ULID is what makes a key
 * unique when two nodes compute the same next sequence and both upload before
 * either wins the compare-and-swap. The loser's object must not overwrite the
 * winner's, or a rejected push would corrupt a published one.
 *
 * Hand-rolled rather than a dependency: this is thirty lines and the push path
 * is the one place in walgit where a supply-chain surprise is unrecoverable.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function ulid(now: number = Date.now()): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32]! + time
    t = Math.floor(t / 32)
  }
  const random = crypto.getRandomValues(new Uint8Array(16))
  let rand = ''
  for (let i = 0; i < 16; i += 1) rand += CROCKFORD[random[i]! % 32]!
  return time + rand
}

/**
 * The millisecond timestamp encoded in a ULID's first ten characters.
 *
 * This is what makes "how old is this object?" answerable from the key alone,
 * with no store metadata call and no per-object bookkeeping — which orphan
 * collection needs, because the one thing it must never do is delete a pack
 * belonging to a push that is still in flight.
 *
 * Returns null for anything that is not a ULID. A caller that cannot date an
 * object must treat it as too young to touch, never as ancient.
 */
export function ulidTime(id: string): number | null {
  if (id.length < 10) return null
  let t = 0
  for (let i = 0; i < 10; i += 1) {
    const digit = CROCKFORD.indexOf(id[i]!)
    if (digit < 0) return null
    t = t * 32 + digit
  }
  return t
}
