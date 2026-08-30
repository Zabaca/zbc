/**
 * Signed pushes: the one seed the capability hangs off.
 *
 * A push certificate is a claim about *who moved this ref*, signed by the
 * pusher and carrying a nonce this server issued (docs/adr/0011). Everything
 * about it is a `receive-pack` capability rather than a transport feature —
 * which is why it works over smart-HTTP with no SSH anywhere (ADR-0008) — and
 * `git-receive-pack` advertises that capability if, and only if, the receiving
 * repository has `receive.certNonceSeed` set. With no seed a client asking for
 * `--signed=yes` is refused by its OWN git, before a byte reaches the network:
 * `fatal: the receiving end does not support --signed push`. That refusal is
 * the correct answer for a deployment that has not turned provenance on, and it
 * is why this needs no flag of its own — the seed IS the flag.
 *
 * Configuration, never generated. The nonce is an HMAC of the seed and a
 * timestamp, and a client holds one across the round trip between advertisement
 * and push. The container's disk is a cache that is wiped on every restart
 * (ADR-0007), so a seed minted at boot would be a different seed on the other
 * side of a restart and would reject every certificate in flight. It therefore
 * arrives as an environment variable, and joins the forward list in
 * `shared/container-env.ts` like every other value the container boots with.
 *
 * Nothing here verifies anything. A signed push lands exactly as an unsigned
 * one does; what the certificate says is somebody else's ticket.
 */

/**
 * The configured seed, or `null` for "this deployment does not take signed
 * pushes".
 *
 * Blank reads as unset, the same collapse `containerEnv` makes at the seam and
 * `positiveNumber` makes for the size caps: a variable cleared to an empty
 * string is a capability turned off, not a capability seeded with nothing. git
 * would take `""` as a seed and derive perfectly usable nonces from it, so the
 * two spellings have to collapse here rather than at the config write.
 */
export function pushCertSeed(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.WALGIT_PUSH_CERT_SEED
  if (raw === undefined) return null
  const seed = raw.trim()
  return seed === '' ? null : seed
}

/** Does this instance take signed pushes? The seed, read as a yes/no. */
export function signedPushEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return pushCertSeed(env) !== null
}
