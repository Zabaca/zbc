import { ModelError, type ModelPort, type ModelReply } from '../src/assistant/model'
import type { ModelRequest } from '../src/assistant/prompt'

/**
 * The model, in memory, that answers or fails as a test says: what the assistant is driven against. It records every request
 * (so a test reads what the model was SHOWN: the prompt, the thread, the knowledge base) and answers from a queue of steps, one
 * per call, then from `fallback` when the queue is empty. NOT evidence about Anthropic's API: how the real model
 * words a draft and what its usage numbers are is the live check (packages/inbox/docs/runbooks/inbox-cloudflare-mailbox.md).
 */

export type Step =
  | { kind: 'reply'; toolInput: unknown; usage: { inputTokens: number; outputTokens: number } }
  | { kind: 'fail'; status: number | null; message: string }

/** The tokens a fake answer reports unless a test says otherwise. */
export const USAGE = { inputTokens: 1200, outputTokens: 180 }

/** The model answers with this as its tool's input. */
export const says = (toolInput: unknown, usage = USAGE): Step => ({ kind: 'reply', toolInput, usage })

/** The model's answer to a chat turn: a note, and the whole revised draft when it was asked for one. */
export const reply = (note: string, draft?: string) => says(draft === undefined ? { note } : { note, draft })

/** The call fails: an HTTP status from the API (529 is "overloaded"), or `null` for no answer at all. */
export const fails = (status: number | null = 529, message = 'Overloaded'): Step => ({ kind: 'fail', status, message })

export class FakeModel implements ModelPort {
  readonly requests: ModelRequest[] = []
  private readonly steps: Step[] = []
  /** What a call answers when nothing is queued. */
  fallback: Step = reply('Done.')
  /** Resolves a call only when released, so a test can change things while the model is working. */
  gate: Promise<void> | null = null

  /** Queue what the next calls answer, in order. */
  next(...steps: Step[]): this {
    this.steps.push(...steps)
    return this
  }

  async complete(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request)
    const step = this.steps.shift() ?? this.fallback
    if (this.gate) await this.gate
    if (step.kind === 'fail') throw new ModelError(step.message, step.status)
    return { toolInput: step.toolInput, usage: step.usage }
  }

  /** The text of the user message a call carried: the thread as the model read it. */
  userText(n = -1): string {
    return (this.requests.at(n)?.messages[0]?.content as string) ?? ''
  }
}
