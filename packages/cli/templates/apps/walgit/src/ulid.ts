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
 * The millisecond timestamp a ULID was minted at, or `null` if it is not one.
 *
 * This is how an object's age is known without asking the store for metadata.
 * It matters for orphan collection: a pack uploaded seconds ago may belong to a
 * push still racing for the compare-and-swap, and deleting it would fail a push
 * that was about to succeed. A `LIST` returns keys and nothing else, so the
 * timestamp the key already carries is the only age available in one round trip.
 */
export function ulidTime(id: string): number | null {
  if (id.length < 10) return null
  let ms = 0
  for (let i = 0; i < 10; i += 1) {
    const value = CROCKFORD.indexOf(id[i]!)
    if (value < 0) return null
    ms = ms * 32 + value
  }
  return ms
}
