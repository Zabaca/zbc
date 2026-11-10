import type { ModelRequest } from './prompt'

/**
 * The network call to the model, as a port: `ModelPort.complete` in the assistant, `modelOverFetch` in production, a fake
 * that answers or fails in tests. What is decided here is only how a reply is read; what to ask and what to do with the
 * answer is src/assistant/prompt.ts and assistant.ts.
 *
 * ── THE CREDENTIAL ───────────────────────────────────────────────────────
 * A pay-per-use Anthropic API key used by the inbox alone (the Worker secret `ANTHROPIC_API_KEY`), sent as `x-api-key`. It is
 * never logged, never put in an error, and nothing else in this Worker can read it out of here. There is no fallback
 * to a subscription token: with no key there is no model call, and the assistant says so.
 */

/** What a call cost, as the API reports it. */
export interface Usage {
  inputTokens: number
  outputTokens: number
}

/** What came back from a call that reached the model: the tool's input (null if it made no tool call) and the cost. */
export interface ModelReply {
  toolInput: unknown
  usage: Usage
}

/** A call that did not give an answer. `status` is the HTTP status, or null for no answer at all (a timeout, a dropped connection). */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
  }
}

export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelReply>
}

export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
export const API_VERSION = '2023-06-01'

/** How long a call may take before it counts as no answer: a reply and a note are a few hundred tokens, so a minute is generous. */
export const MODEL_TIMEOUT_MS = 60_000

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0)

/** An error body cut to a line: what the API said is useful and short, and nothing of the request is in it. */
const brief = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300)

/** The model over `fetch`, with the key. One POST; never retried here (a chat turn is tried once: the owner is looking, and presses again). */
export function modelOverFetch(
  send: (url: string, init: RequestInit) => Promise<Response>,
  apiKey: string,
  timeoutMs = MODEL_TIMEOUT_MS,
): ModelPort {
  return {
    async complete(request) {
      let res: Response
      try {
        res = await send(MESSAGES_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'anthropic-version': API_VERSION, 'x-api-key': apiKey },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        throw new ModelError(
          `The model did not answer: ${error instanceof Error ? error.message : String(error)}`,
          null,
        )
      }
      const text = await res.text().catch(() => '')
      if (!res.ok) throw new ModelError(`The model refused the request (${res.status}): ${brief(text)}`, res.status)
      let body: { content?: { type?: string; input?: unknown }[]; usage?: Record<string, unknown> }
      try {
        body = JSON.parse(text)
      } catch {
        throw new ModelError('The model answered with something that is not JSON.', res.status)
      }
      return {
        toolInput: body.content?.find((c) => c?.type === 'tool_use')?.input ?? null,
        usage: { inputTokens: count(body.usage?.input_tokens), outputTokens: count(body.usage?.output_tokens) },
      }
    },
  }
}
