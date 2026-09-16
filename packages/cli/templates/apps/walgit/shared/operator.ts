/**
 * Who runs this deployment, and how to reach them.
 *
 * Deliberately NOT a capability (`shared/capabilities.ts`), and the distinction
 * is the same one that keeps the host out of that type: a capability is
 * something the push path enforces and the documents describe, derived from the
 * variables the container is told about. An operator is nobody's capability —
 * it is who is answerable for one — and no code path branches on it. So it is
 * derived here, passed beside the capabilities and the host, and read by the
 * two documents that state it.
 *
 * It is also EDGE-ONLY, and that is why neither variable appears in
 * `CONTAINER_ENV` (`shared/container-env.ts`). Nothing the container serves
 * names an operator, and adding a name there would cost a container restart on
 * every copy edit — `reconcileEnv` replaces the container whenever the
 * forwarded environment's fingerprint changes.
 *
 * Both halves are optional and either may stand alone: a host run by somebody
 * who publishes no address still says who runs it, and an address with no name
 * behind it is still somewhere to send a takedown. What must never happen is a
 * deployment that configured neither printing a placeholder — mail to a name
 * nobody reads is worse than the page admitting there is nobody to write to —
 * which is why nothing configured derives to `null` and the block leaves.
 */

/** The variables an operator is read from, and only those. */
export type OperatorVar = 'WALGIT_OPERATOR' | 'WALGIT_CONTACT'

/**
 * An environment named exactly by those variables.
 *
 * What a caller writing a LITERAL should annotate it with — a misspelled name
 * is then a compile error rather than a value quietly read as unset. That is
 * what every fixture in this package is typed as, following `CapabilityEnv`.
 */
export type OperatorEnv = Partial<Record<OperatorVar, string>>

/**
 * Who runs this deployment, with absence spelled `null` on each half rather
 * than as an omitted key — the same rule `Capabilities` follows, for the same
 * reason: an optional field defaults to "off" at a construction site that
 * forgot it.
 */
export type Operator = {
  /** Who is answerable for this host. */
  name: string | null
  /** Where to write about it — an email address, a URL, or free text. */
  contact: string | null
}

/**
 * Read an environment into who runs it, or `null` for "nobody is named here".
 *
 * Blank collapses to unset, the reading `seedValue` and `containerEnv` already
 * make of a blank variable: a value cleared to an empty string is a line
 * removed from the page, not a line with nothing in it.
 */
export function operatorFrom(
  env: OperatorEnv | Record<string, string | undefined>,
): Operator | null {
  const name = trimmed(env.WALGIT_OPERATOR)
  const contact = trimmed(env.WALGIT_CONTACT)
  if (name === null && contact === null) return null
  return { name, contact }
}

const trimmed = (raw: string | undefined): string | null => {
  if (raw === undefined) return null
  const value = raw.trim()
  return value === '' ? null : value
}

/**
 * Is this contact something a reader can click, and what does it become?
 *
 * Only the two shapes that are unambiguous — an address and an `https`/`http`
 * URL — and anything else stays text. A contact is operator-supplied free text
 * (a Matrix handle, a postal address, "open an issue on GitHub"), and guessing
 * a scheme for it would produce a link that goes nowhere, which is worse than
 * a line somebody has to copy.
 */
export function contactHref(contact: string): string | null {
  if (/^https?:\/\/\S+$/.test(contact)) return contact
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return `mailto:${contact}`
  return null
}
