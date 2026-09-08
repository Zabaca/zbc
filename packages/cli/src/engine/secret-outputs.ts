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

/** One recorded credential: the literal, and where it came from. */
interface RecordedSecret {
  value: string
  label: string
}

export interface SecretOutputRegistry {
  /**
   * Remember the credentials in one instance's outputs. Called for every
   * applied instance, whether or not its module declares any — the registry,
   * not the caller, decides there is nothing to hide.
   */
  record(instance: ModuleInstance, outputs: unknown): void
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

/** `err`, with every recorded credential scrubbed from its message. */
export function redactError(registry: SecretOutputRegistry | undefined, err: unknown): unknown {
  if (!registry || !(err instanceof Error)) return err
  const redacted = registry.redactText(err.message)
  if (redacted === err.message) return err
  // A new Error rather than a mutated one: the original may be a provider SDK's
  // subclass carrying the raw value in other fields, and rethrowing it would
  // leak exactly what the message no longer does. `cause` is dropped for the
  // same reason.
  const replacement = new Error(redacted)
  replacement.stack = err.stack === undefined ? undefined : registry.redactText(err.stack)
  return replacement
}

export function createSecretOutputRegistry(): SecretOutputRegistry {
  const secrets: RecordedSecret[] = []

  return {
    record(instance, outputs) {
      for (const [key] of declaredSecrets(instance)) {
        const value = readOutput(outputs, key)
        if (value === undefined || value.length < MIN_REDACTABLE_LENGTH) continue
        if (secrets.some((s) => s.value === value)) continue
        secrets.push({ value, label: `${instance.name}.${key}` })
      }
    },
    redactText(text) {
      let result = text
      // Longest first: a credential that contains another (R2's derived secret
      // is a hash OF the token value in some modules) must not be half-scrubbed
      // by the shorter one, leaving the rest of the longer one in the message.
      for (const secret of [...secrets].sort((a, b) => b.value.length - a.value.length)) {
        result = result.split(secret.value).join(`[redacted: ${secret.label}]`)
      }
      return result
    },
    redactOutputs(instance, outputs) {
      const declared = declaredSecrets(instance)
      if (declared.length === 0 || outputs === null || typeof outputs !== 'object') return outputs
      const copy: Record<string, unknown> = { ...(outputs as Record<string, unknown>) }
      for (const [key] of declared) {
        if (key in copy) copy[key] = REDACTED
      }
      return copy
    },
  }
}

/** The `secretOutputs` entries a module declared, as pairs. */
function declaredSecrets(
  instance: ModuleInstance,
): Array<[string, SecretOutputDeclaration | undefined]> {
  const declared = instance._definition.secretOutputs
  return declared ? Object.entries(declared) : []
}

function readOutput(outputs: unknown, key: string): string | undefined {
  if (outputs === null || typeof outputs !== 'object') return undefined
  const value = (outputs as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}
