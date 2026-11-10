/**
 * Cloudflare's `send_email` binding, in memory, that can accept, refuse or leave the outcome unknown: what the Mailroom's
 * Ridgeway sends are driven against (through the real `bindingSender`, so the way a thrown code is read is under test too).
 * It keeps every message it was handed, exactly as handed, and a log of every call.
 *
 * Like the fake Google, it was written by the same hand as the code under test and is NOT evidence about Cloudflare: that the
 * real binding takes this shape from this Worker, which codes it throws, and what its `messageId` is are the hand test
 * (packages/inbox/docs/runbooks/inbox-cloudflare-mailbox.md).
 */

export type EmailBehavior =
  /** Resolves with an id (null: with no id at all). */
  | { kind: 'accept'; messageId?: string | null }
  /** Throws an error with this code, as the binding documents its refusals. */
  | { kind: 'throw'; code?: string; message?: string }
  /** Throws something that is not an error at all. */
  | { kind: 'throw-plain' }

/** What the structured form is handed: the part of the binding's builder this inbox uses. */
export interface HandedOver {
  from: string
  to: string
  cc?: string[]
  subject: string
  text: string
  headers?: Record<string, string>
  /** The files, as the binding's `attachments` takes them (Cloudflare's Workers API for Email Service). */
  attachments?: {
    filename: string
    type: string
    content: Uint8Array | ArrayBuffer | string
    disposition: 'attachment' | 'inline'
    contentId?: string
  }[]
}

export class FakeEmailBinding {
  /** Every message handed over, in order, as handed. */
  readonly handed: HandedOver[] = []
  /** What each call does, in order; the last one repeats. The default accepts with a fresh id. */
  private script: EmailBehavior[] = []
  private n = 0

  /** Every following send does this, replacing what was set before. */
  always(behavior: EmailBehavior): void {
    this.script = [behavior]
  }

  /** The next sends do these, in order, and the last repeats. */
  sequence(...behaviors: EmailBehavior[]): void {
    this.script = behaviors
  }

  async send(message: HandedOver): Promise<{ messageId: string }> {
    this.handed.push(structuredClone(message))
    const step = this.script[Math.min(this.handed.length - 1, this.script.length - 1)] ?? { kind: 'accept' as const }
    if (step.kind === 'throw-plain') throw 'the connection dropped'
    if (step.kind === 'throw') {
      throw Object.assign(
        new Error(step.message ?? 'The binding failed.'),
        step.code === undefined ? {} : { code: step.code },
      )
    }
    this.n += 1
    const id = step.messageId === undefined ? `cf-${this.n}@ridgewaycycles.example` : step.messageId
    return { messageId: id } as { messageId: string }
  }
}
