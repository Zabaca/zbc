// The engine's half of the ephemeral-credential contract.
//
// A module says which of its outputs are CREDENTIALS (`secretOutputs`); this
// says what the engine then does with them. The rule is one sentence: **a
// secret output crosses an `imports` edge in memory and appears nowhere else.**
//
// "Nowhere else" is two concrete things, because those are the two places a
// minted credential actually leaked in the survey:
//
//   1. Text the engine prints — an apply's error, a readiness probe's last
//      failure. leeandco's `cloudflare-token` mints a token and hands it to a
//      dependent; when the dependent's provider call fails, the provider
//      echoes the Authorization header back into the message the engine then
//      prints. foundry's `incus-trust` gave up returning its credential at all
//      after mint-and-return "put a live bearer token into an agent's
//      persisted transcript twice in one morning".
//   2. `zbc apply --json`, which is a FILE. Its doc comment says "treat the
//      file as secret"; a credential that is redacted there needs no such
//      discipline from the caller.
//
// What this cannot reach, and does not pretend to: a module's own
// `console.log`, and the inherited stdio of a child process a module spawns
// (`wrangler`, `bun run build`). Those are the module's output, not the
// engine's, and the engine never sees the bytes.

import type { ModuleInstance, SecretOutputDeclaration } from '../../templates/infra/src/types'

/** What `zbc apply --json` writes in place of a credential. */
export const REDACTED = '[redacted]'

/**
 * A value short enough that redacting it would scrub unrelated text.
 *
 * A one- or two-character "credential" is not one, and substituting every `x`
 * in an error message destroys the diagnostic while protecting nothing. Real
 * minted values — a Cloudflare token, a GCP key, a Tailscale auth key — are far
 * above this; a module emitting something this short under `secretOutputs` has
 * emitted a placeholder, not a secret.
 */
const MIN_REDACTABLE_LENGTH = 8

/** One recorded credential: the literal, and every place it came from. */
interface RecordedSecret {
  value: string
  /**
   * Plural because two instances can emit the SAME value — a token re-derived
   * identically, one root minted twice. Attributing an error about the second
   * to the first sends the operator to the wrong instance file.
   */
  labels: string[]
}

export interface SecretOutputRegistry {
  /**
   * Remember the credentials in one instance's outputs. Called for every
   * applied instance, whether or not its module declares any — the registry,
   * not the caller, decides there is nothing to hide.
   */
  record(instance: ModuleInstance, outputs: unknown): void
  /** Whether this run has minted anything at all — see `redactError`. */
  hasSecrets(): boolean
  /**
   * `text` with every recorded credential replaced by `[redacted:
   * <instance>.<output>]`. Substring-literal, because that is the shape the
   * leak takes: a provider echoing a bearer token inside a longer message.
   */
  redactText(text: string): string
  /**
   * One instance's outputs as a document may carry them: every secret output
   * replaced by `[redacted]`, every other value verbatim.
   *
   * Keyed by declaration rather than by value, so an output that HAPPENS to
   * equal a credential elsewhere in the run is still reported — the engine
   * redacts what a module called secret, and does not guess.
   */
  redactOutputs(instance: ModuleInstance, outputs: unknown): unknown
}

/**
 * `err`, reduced to a message and a stack with every recorded credential
 * scrubbed out of both.
 *
 * A NEW Error, not a mutated one, and rebuilt whenever the run has minted
 * anything at all — not only when the message itself leaked. The leak that
 * matters most is the one a scrub of `.message` cannot see: a `fetch` or SDK
 * error whose `response`/`request`/`errors` field holds the bearer token it was
 * refused with. `bin/zbc.js` prints the whole object, own enumerable properties
 * included, so those fields are dropped rather than scrubbed — along with
 * `cause`, for the same reason.
 */
export function redactError(registry: SecretOutputRegistry | undefined, err: unknown): unknown {
  if (!registry || !(err instanceof Error) || !registry.hasSecrets()) return err
  const replacement = new Error(registry.redactText(err.message))
  replacement.stack = err.stack === undefined ? undefined : registry.redactText(err.stack)
  return replacement
}

export function createSecretOutputRegistry(): SecretOutputRegistry {
  // Kept longest-first on insert, not on every read: a credential that CONTAINS
  // another (a token and a header line quoting it) must be scrubbed before the
  // shorter one, or the shorter pass leaves the rest of the longer value in the
  // text. `redactText` runs once per failed readiness attempt, so the ordering
  // is established where it costs once.
  const secrets: RecordedSecret[] = []
  /** Declared keys already reported as unrecordable — warn once, not per apply. */
  const warned = new Set<string>()

  return {
    record(instance, outputs) {
      for (const [key] of declaredSecrets(instance)) {
        const label = `${instance.name}.${key}`
        const value = readOutput(outputs, key)
        if (value === undefined) continue
        // A declared credential the registry cannot scrub is the one case where
        // the two halves of this contract disagree: `redactOutputs` still writes
        // `[redacted]` for it, while the printed text would carry it verbatim.
        // Say so rather than let the module author believe it is covered.
        if (value.length < MIN_REDACTABLE_LENGTH) {
          if (!warned.has(label)) {
            warned.add(label)
            console.warn(
              `  ⚠ ${label} is declared a secret output but its value is too short to redact ` +
                `safely (${value.length} chars) — it will NOT be scrubbed from printed errors.`,
            )
          }
          continue
        }
        const existing = secrets.find((s) => s.value === value)
        if (existing) {
          if (!existing.labels.includes(label)) existing.labels.push(label)
          continue
        }
        secrets.push({ value, labels: [label] })
        secrets.sort((a, b) => b.value.length - a.value.length)
      }
    },
    hasSecrets() {
      return secrets.length > 0
    },
    redactText(text) {
      let result = text
      for (const secret of secrets) {
        result = result.split(secret.value).join(`[redacted: ${secret.labels.join(', ')}]`)
      }
      return result
    },
    redactOutputs(instance, outputs) {
      // Two passes, because they answer two different questions. The first is
      // by DECLARATION — this instance said `tokenValue` is a credential, so it
      // is `[redacted]` whatever it holds, including a value too short or too
      // structured for the second pass to find. The second is by VALUE, and it
      // is what makes "a declared credential never lands on disk" true rather
      // than "…unless an importer re-emits it as an output of its own".
      const declared = declaredSecrets(instance)
      let result = outputs
      if (declared.length > 0 && result !== null && typeof result === 'object') {
        const copy: Record<string, unknown> = { ...(result as Record<string, unknown>) }
        for (const [key] of declared) {
          if (key in copy) copy[key] = REDACTED
        }
        result = copy
      }
      return redactValues(result, (text) => this.redactText(text))
    },
  }
}

/**
 * `value` with every string in it — however deeply nested — run through
 * `redact`. Structural, because an output is whatever a module's schema says
 * and several are arrays or records.
 */
function redactValues(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((entry) => redactValues(entry, redact))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        redactValues(entry, redact),
      ]),
    )
  }
  return value
}

/**
 * The `secretOutputs` entries a module actually declared, as pairs.
 *
 * An explicitly `undefined` entry — `{ tokenValue: undefined }`, which the
 * `Partial` type admits — is dropped HERE so that all three readers (record,
 * redactOutputs, `assertRotationSafe`) agree it was never declared. They
 * disagreed when each decided for itself.
 */
export function declaredSecrets(
  instance: ModuleInstance,
): Array<[string, SecretOutputDeclaration]> {
  const declared = instance._definition.secretOutputs
  if (!declared) return []
  return Object.entries(declared).filter(
    (entry): entry is [string, SecretOutputDeclaration] => entry[1] !== undefined,
  )
}

/**
 * One declared output as a redactable literal.
 *
 * A credential is not always a string: ceo's `gcp` emits a service-account KEY,
 * which is a JSON object, and recording only strings would write `[redacted]`
 * for it on disk while printing it verbatim in every error. Serialized, its
 * literal is exactly what a message quoting it would contain.
 */
function readOutput(outputs: unknown, key: string): string | undefined {
  if (outputs === null || typeof outputs !== 'object') return undefined
  const value = (outputs as Record<string, unknown>)[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    // A cyclic output cannot be serialized, and there is no literal to scrub.
    return undefined
  }
}

/**
 * The outputs of `instance`'s module that a holder OUTSIDE the apply keeps —
 * `rotates: 'never'`. Replacing such a resource rotates a value nobody handed
 * the holders, so both engine paths that would replace one ask this first.
 */
export function heldCredentials(instance: ModuleInstance): string[] {
  return declaredSecrets(instance)
    .filter(([, decl]) => decl.rotates === 'never')
    .map(([key]) => key)
}
