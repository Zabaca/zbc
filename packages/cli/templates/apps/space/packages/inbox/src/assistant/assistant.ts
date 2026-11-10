import type { KnowledgeText } from '@space/workspace'
import { ask, type KnowledgePort } from '../knowledge'
import type { MailboxContent } from '../mailbox-content'
import { onlyOwnerChats, onlyOwnerSwitchesSpamCheck } from '../owner-words'
import type { AssistStore, ChatContext, ChatInput } from '../store/assist'
import { EM_DASH, fail, isoOrNull, ok, type Result } from '../store/store'
import { type AssistantUsage, type ChatAnswer, MAX_CHAT_INSTRUCTION, type SpamCall } from '../types'
import type { Install } from '../workspace'
import type { ModelPort } from './model'
import { AnswerError, buildChatRequest, type ChatAnswerRead, type Persona, readChatAnswer } from './prompt'

/**
 * The assistant: writes a reply draft when the owner asks for one, and revises it when they chat with it (ADR 0001
 * decisions 19 to 23). Nothing runs on arrival: mail is
 * judged for spam by the spam classifier when it is filed (src/cloudflare/spam-check.ts), and no draft exists until the owner asks. It never
 * sends, and has no tool but one that returns a note and a draft. The store
 * (src/store/assist.ts) holds every rule about what is written; this is the waiting: the model.
 *
 * It runs on every email conversation, the owner's Gmail included (ADR 0001 decision 23: it is not limited to the business mailboxes).
 * A Gmail conversation gets a normal Gmail-path draft in the owner's name, signed as them at the company. What the mailbox decides is the
 * persona, the transport (unchanged: the draft's own send) and the business whose knowledge it reads.
 *
 * ── THE KNOWLEDGE BASE IS THE KNOWLEDGE APP'S ────────────────────────────
 * Before the model is called, and before anything of the owner's is saved, the assistant asks the knowledge app (a service binding to its
 * `InboxKnowledgeAccess`, packages/knowledge) for the ACTIVE entries marked for the business the conversation's mailbox belongs to
 * (the company declaration says which: the owner's own Gmail is the company's). It waits at most `ANSWER_WITHIN_MS` (four seconds). If the app
 * does not answer, or refuses, the turn is refused with a sentence and NOTHING is saved but the audit of the failed call: a draft
 * written as if the business had no entries could leave out a price the owner has on record and still look complete. A mailbox in no
 * business is given no knowledge base at all, in the prompt's existing words.
 *
 * ── THE DRAFT CHAT ───────────────────────────────────────────────────────
 * `chat` is its one operation: the owner tells it something about a draft ("shorter", "mention the $40 tune-up"), or asks for a reply
 * on a conversation that has none, and it answers and, if they asked for a change, writes or revises the draft. It is asked by
 * the owner through a request, so it waits on the model inside that request (one try, no owed work: they are looking, and press
 * again), and it applies the answer in one transaction that refuses to write over a draft that moved on while the model was
 * working. It never sends, has no command, and is the owner's alone: the route refuses the agent and so does this, and Claude's
 * script has no chat command. It does not depend on the spam check's switch, which belongs to the mailbox: it needs the key and a mailbox with a persona.
 *
 * ── NO KEY, NO CALL ──────────────────────────────────────────────────────
 * Without `ANTHROPIC_API_KEY` there is no model port, and a chat turn is refused (503) before anything is saved. Mail keeps
 * arriving either way: the key is used by nothing that runs on arrival.
 */

/** What the usage report covers when it is not told: the last seven days, the first week's comparison. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** What the assistant says when the knowledge app did not answer: the owner's words stay in the box and nothing was drafted or saved. */
export const KNOWLEDGE_UNREAD = 'The knowledge base could not be read, so nothing was drafted. Ask again in a moment.'

/** What a chat turn says where the install's `assistant` switch is off. */
export const ASSISTANT_OFF = 'The assistant is not turned on in this space, so it does not chat.'

export interface AssistantPorts {
  store: AssistStore
  /** The company: which business a mailbox drafts for. */
  install: Install
  /** The install's mailbox content: the persona each mailbox's assistant speaks with. A mailbox with none gets no assistant. */
  content: MailboxContent
  /** The knowledge app's entrypoint for the inbox. Absent when the Worker has no binding to it: a chat turn is then refused like an unanswered one. */
  knowledge: KnowledgePort
  /** How long the knowledge app is waited for; tests shorten it. Production is `ANSWER_WITHIN_MS`. */
  knowledgeWithinMs?: number
  /** Null when the Worker has no key: nothing is asked of any model then. */
  model: ModelPort | null
  now: () => Date
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class Assistant {
  constructor(private readonly ports: AssistantPorts) {}

  // ─── the draft chat ──────────────────────────────────────────────────

  /**
   * One chat turn: the owner's words about a draft (the one they name, or, on a conversation with none, a new one is made for the
   * answer), the model's answer, and the turn kept beside the draft. The owner's alone. What the model is shown is the store's
   * `prepareChat`: that person's exchange and the business's knowledge (read above), and no other conversation.
   */
  async chat(conversationId: string, input: ChatInput, actor: string): Promise<Result<ChatAnswer>> {
    if (actor !== this.ports.store.owner.email) return fail(403, onlyOwnerChats(this.ports.store.owner.name))
    // The assistant is a switch: an install without it has no chat, whatever key the Worker holds.
    if (!this.ports.install.has('assistant')) return fail(403, ASSISTANT_OFF)
    const { store, model } = this.ports
    if (!model) return fail(503, 'The assistant has no key to call the model with, so it cannot chat.')
    const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : ''
    if (instruction === '') return fail(422, 'Say what you want the assistant to do.')
    if (instruction.length > MAX_CHAT_INSTRUCTION) {
      return fail(422, `A chat turn is at most ${MAX_CHAT_INSTRUCTION} characters.`)
    }
    const where = store.chatMailbox(conversationId)
    if (!where.ok) return where
    const business = this.ports.install.businessOf(where.value.address)
    let knowledge: KnowledgeText[] | null = null
    if (business) {
      const read = await ask(this.ports.knowledge, (k) => k.activeFor(business.id), this.ports.knowledgeWithinMs)
      if (!read.ok) {
        store.auditChatFailure(
          conversationId,
          `the knowledge app: ${read.kind === 'unreached' ? read.why : read.message}`,
        )
        return fail(503, KNOWLEDGE_UNREAD)
      }
      knowledge = read.value
    }
    const prepared = store.prepareChat(conversationId, { ...input, instruction }, actor, knowledge)
    if (!prepared.ok) return prepared
    const ctx = prepared.value
    const persona = this.ports.content.persona(ctx.mailbox.address)
    if (!persona) return fail(422, `The assistant has nothing written for ${ctx.mailbox.address}, so it does not chat.`)
    let answer: ChatAnswerRead & { dashed?: boolean }
    try {
      answer = await this.askChat(model, ctx, persona, instruction)
    } catch (error) {
      store.auditChatFailure(conversationId, describe(error))
      return fail(
        502,
        `The assistant could not answer (${describe(error)}). Your words are kept and nothing was changed.`,
      )
    }
    return store.applyChat(ctx, instruction, answer, actor)
  }

  /** One or two calls: and, when the draft has an em dash, once more with the rule restated; a second dash is never stored. */
  private async askChat(
    model: ModelPort,
    ctx: ChatContext,
    persona: Persona,
    instruction: string,
  ): Promise<ChatAnswerRead & { dashed?: boolean }> {
    const first = await this.chatCall(model, ctx, persona, instruction)
    if (!first.draft?.includes(EM_DASH)) return first
    const second = await this.chatCall(model, ctx, persona, instruction, first.draft)
    return second.draft?.includes(EM_DASH) ? { draft: null, note: second.note, dashed: true } : second
  }

  /** One call to the model for a chat turn, its cost recorded whatever it came to (a failed call costs nothing; an unreadable answer is billed). */
  private async chatCall(
    model: ModelPort,
    ctx: ChatContext,
    persona: Persona,
    instruction: string,
    rejectedDraft?: string,
  ): Promise<ChatAnswerRead> {
    const { store } = this.ports
    const request = buildChatRequest({
      mailboxAddress: ctx.mailbox.address,
      persona,
      subject: ctx.subject,
      participant: ctx.participant,
      thread: ctx.thread,
      knowledge: ctx.knowledge,
      draft: ctx.draft,
      history: ctx.history,
      instruction,
      ownerName: store.owner.name,
      ...(rejectedDraft !== undefined && { rejectedDraft }),
    })
    const record = (
      inputTokens: number,
      outputTokens: number,
      outcome: 'ok' | 'error' | 'unreadable',
      error?: string,
    ) =>
      store.recordUsage({
        mailboxId: ctx.mailbox.id,
        conversationId: ctx.conversationId,
        messageId: ctx.usageMessageId,
        operation: 'chat',
        model: request.model,
        inputTokens,
        outputTokens,
        outcome,
        ...(error !== undefined && { error }),
      })
    let reply: Awaited<ReturnType<ModelPort['complete']>>
    try {
      reply = await model.complete(request)
    } catch (error) {
      record(0, 0, 'error', describe(error))
      throw error
    }
    try {
      const answer = readChatAnswer(reply.toolInput)
      record(reply.usage.inputTokens, reply.usage.outputTokens, 'ok')
      return answer
    } catch (error) {
      record(reply.usage.inputTokens, reply.usage.outputTokens, 'unreadable', describe(error))
      throw error instanceof AnswerError ? error : new AnswerError(describe(error))
    }
  }

  // ─── what the Worker may ask (ASSISTANT_METHODS in app.ts) ───────────────

  /** The owner or Claude moves a Cloudflare conversation to Bulk or back to the Inbox. It sticks (store.setSpam). */
  async setSpam(conversationId: string, spam: boolean, actor: string): Promise<Result<{ spamCall: SpamCall }>> {
    return this.ports.store.setSpam(conversationId, spam, actor)
  }

  /** The owner switches the spam check on a mailbox. Theirs alone. */
  async setAssistant(
    mailboxId: string,
    enabled: boolean,
    actor: string,
  ): Promise<Result<{ id: string; enabled: boolean; changedAt: string; changedBy: string }>> {
    if (actor !== this.ports.store.owner.email)
      return fail(403, onlyOwnerSwitchesSpamCheck(this.ports.store.owner.name))
    return this.ports.store.setAssistant(mailboxId, enabled, actor)
  }

  /**
   * What the assistant's calls to the model came to over a period (the last seven days when not told), summed, and whether the Worker has a
   * key at all. Open to Claude: it carries no mail text. `since` and `until` are full ISO timestamps.
   */
  async assistantUsage(since: string | null, until: string | null): Promise<Result<AssistantUsage>> {
    const refused = fail(422, 'since and until are full ISO timestamps, like 2026-10-27T00:00:00Z.')
    const end = until === null ? this.ports.now().toISOString() : isoOrNull(until)
    if (end === null) return refused
    const start = since === null ? new Date(Date.parse(end) - WEEK_MS).toISOString() : isoOrNull(since)
    if (start === null) return refused
    return ok({ ...this.ports.store.usageBetween(start, end), keyConfigured: this.ports.model !== null })
  }
}
