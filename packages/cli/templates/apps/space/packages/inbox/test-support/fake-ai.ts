import type { AiPort } from '../src/cloudflare/spam-check'

/**
 * Workers AI, in memory, that answers or fails as a test says: what the spam check is driven against. It records every call (so
 * a test reads what Clef was SHOWN: the model id, the message, the questions) and answers from a queue of steps, one per call,
 * then from `fallback` when the queue is empty. NOT evidence about Clef: what it scores, how long it takes and what the binding
 * returns for a real message is the live check (packages/inbox/docs/runbooks/inbox-cloudflare-mailbox.md). The response shape is the one a measurement of the real
 * model recorded, written out by hand.
 */

export type AiStep = { kind: 'reply'; response: unknown } | { kind: 'fail'; message: string } | { kind: 'hang' }

/** What Clef answers: the probability that the message is unsolicited, and the kind it chose. */
export const clef = (junk: unknown, category: unknown = 'customer'): AiStep => ({
  kind: 'reply',
  response: { answers: { junk: { noul: junk }, category: { choice: category } } },
})

/** An obvious pitch. */
export const spam = (junk = 0.95): AiStep => clef(junk, 'vendor_pitch')

/** A person asking for something. */
export const person = (junk = 0.04): AiStep => clef(junk, 'customer')

/** The call rejects. */
export const aiFails = (message = 'AiError: 3040: Capacity temporarily exceeded'): AiStep => ({ kind: 'fail', message })

/** The call never answers, so only the timeout ends it. */
export const aiHangs: AiStep = { kind: 'hang' }

export class FakeAi implements AiPort {
  readonly calls: { model: string; input: { model: string; state: Record<string, string>; questions: unknown } }[] = []
  private readonly steps: AiStep[] = []
  /** What a call answers when nothing is queued. */
  fallback: AiStep = person()

  /** Queue what the next calls answer, in order. */
  next(...steps: AiStep[]): this {
    this.steps.push(...steps)
    return this
  }

  async run(model: string, input: unknown): Promise<unknown> {
    this.calls.push({ model, input: input as never })
    const step = this.steps.shift() ?? this.fallback
    if (step.kind === 'fail') throw new Error(step.message)
    if (step.kind === 'hang') return new Promise(() => {})
    return step.response
  }

  /** The message the last call was shown, as Clef's `state`. */
  shown(n = -1): Record<string, string> {
    return this.calls.at(n)?.input.state ?? {}
  }
}
