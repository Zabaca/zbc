/**
 * The store's half of the assistant and of the owner's call on spam: the draft chat (the assistant's only work, asked by the owner),
 * what each call to the model cost, a conversation moved to Bulk or back by a person, and the spam check's switch. Synchronous
 * SQL over the same ports as the rest, so every rule here runs under plain `bun` against a real SQLite; the waiting (the
 * model) is src/assistant/assistant.ts, which calls these in short transactions between its awaits.
 *
 * Nothing here runs on arrival. Mail is judged for spam by the spam classifier when it is filed (src/cloudflare/arrivals.ts and
 * ./arrival.ts), and no draft is written until the owner asks for one in the draft chat.
 *
 * ── A SUBCLASS ONLY TO SHARE HELPERS ─────────────────────────────────────
 * `AssistStore extends MailStore`, as `ArrivalStore` sits under it: it uses the base's `audit`,
 * `message`, `conversationState` and drafts (`createDraft`, `updateDraft`) without making them public. The Durable Object builds one of these in place of a
 * `MailStore`. Nothing in the Gmail half knows it exists. The draft chat runs on any email conversation, a Gmail one included;
 * a person's call on Bulk is on either kind of mailbox's conversation, and the spam check's switch is a Cloudflare mailbox's alone.
 */

import { costUsd } from '../assistant/pricing'
import type { ChatHistoryLine, ThreadMessage } from '../assistant/prompt'
import { inPlay } from '../gmail/types'
import { assistantWhy, onlyOwnerChats, onlyOwnerOrClaudeCallsSpam, onlyOwnerSwitchesSpamCheck } from '../owner-words'
import { splitQuoted } from '../quote'
import {
  ASSISTANT_ACTOR,
  type AssistantUsage,
  type ChatAnswer,
  type ChatTurn,
  isAgent,
  isWhole,
  type MessageRow,
  SPAM_NEEDS_MAILBOX,
  type SpamCall,
} from '../types'
import { JmapStore } from './jmap'
import { isEmailKind } from './kinds'
import { EM_DASH, fail, ok, PENDING, type Result, text, textOrNull } from './store'

/** The first line of a note, as a draft's why. */
const oneLine = (note: string, max: number): string => note.replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * The subject a reply takes: the customer's, with one Re: and no more, and no em dash. An em dash in a customer's subject would
 * otherwise make every draft fail the em dash rule (nothing sent from a business mailbox may read as machine-written), so it is a hyphen here.
 */
export function replySubject(subject: string): string {
  const base = subject
    .split(EM_DASH)
    .join('-')
    .replace(/^\s*((re|fwd?|aw):\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `Re: ${base === '' ? 'your message' : base}`.slice(0, 300)
}

/** What a chat turn asks of the store: the owner's words, the draft they name with the revision and text they see, and nothing else. */
export interface ChatInput {
  instruction: string
  draftId?: string | null
  /** The revision of the draft the owner was shown (required with a draft). */
  rev?: unknown
  /** What is in the owner's composer, and its subject; saved as their own edit first when it differs from the stored draft. */
  body?: unknown
  subject?: unknown
}

/** Everything one chat turn's call to the model needs, read at one moment (see AssistStore.prepareChat). */
export interface ChatContext {
  mailbox: { id: string; name: string; address: string }
  conversationId: string
  /** The draft the turn is about, or null when the conversation has none: an empty one is made when the turn is applied. */
  draftId: string | null
  /** The revision the turn revises. */
  baseRev: number
  /** The draft's words as the owner sees them ('' when there is none). */
  draft: string
  participant: { address: string; name: string }
  subject: string
  thread: ThreadMessage[]
  /** The active entries of the mailbox's business, as the knowledge app gave them just before; null for a mailbox in no business: never another business's. */
  knowledge: { title: string; body: string }[] | null
  history: ChatHistoryLine[]
  /** The message a usage row for this turn hangs on: the draft, or the message being answered. */
  usageMessageId: string
}

/** The most earlier turns of the chat the model is shown. */
export const MAX_CHAT_TURNS_SHOWN = 20

export const CHAT_NEEDS_MAILBOX =
  'The assistant drafts only on an email conversation (a text or a DM has no mailbox to reply from).'
export const CHAT_NO_ONE_TO_ANSWER = 'There is nobody on this conversation for the assistant to write to.'
export const CHAT_NEEDS_REV = 'Say which version of the draft you were shown (rev). Nothing was changed.'
export const CHAT_DRAFT_MOVED =
  'This draft was changed after it was shown, so nothing was changed. It is shown as it is now.'
export const CHAT_NAME_THE_DRAFT = 'A draft is waiting on this conversation: chat about that one (draftId).'

export class AssistStore extends JmapStore {
  // ─── a call on spam somebody makes ───────────────────────────────────

  /**
   * The owner or Claude moves a conversation, in Gmail or in a Cloudflare mailbox, to Bulk (`spam: true`) or back to the Inbox
   * (`spam: false`). It is a call on the conversation, stored in the sort columns (migration 11 says why they), and it decides
   * over every rule but a Client's people (src/queue.ts `bulkReason`): the spam classifier is not asked again and a later message in the same
   * conversation does not undo it (a new Gmail thread from the same sender is judged afresh, as a new conversation in a Cloudflare mailbox is). A
   * move back to the Inbox is how a false positive is recovered; nothing was deleted, and for Gmail nothing is changed in Gmail:
   * it is the inbox's view, not Gmail's labels. Audited with its actor. Moving a conversation changes no notification: whoever
   * moved it is looking at it. 422 for a conversation in no mailbox (a text, a DM).
   */
  setSpam(conversationId: string, spam: boolean, actor: string): Result<{ spamCall: SpamCall }> {
    if (actor !== this.owner.email && !isAgent(actor)) return fail(403, onlyOwnerOrClaudeCallsSpam(this.owner.name))
    return this.ports.transaction(() => {
      const r = this.sql
        .exec(
          `SELECT c.sort, c.sort_by, mb.kind FROM conversation c LEFT JOIN mailbox mb ON mb.id = c.mailbox_id WHERE c.id = ?1`,
          conversationId,
        )
        .toArray()[0]
      if (!r) return fail(404, 'No such conversation.')
      if (!isEmailKind(textOrNull(r.kind))) return fail(422, SPAM_NEEDS_MAILBOX)
      const at = this.now()
      this.sql.exec(
        `UPDATE conversation SET sort = ?2, sort_by = ?3, sort_at = ?4 WHERE id = ?1`,
        conversationId,
        spam ? 'spam' : null,
        actor,
        at,
      )
      this.audit(
        actor,
        'conversation.spam',
        `conversation:${conversationId}`,
        { sort: textOrNull(r.sort), by: textOrNull(r.sort_by) },
        { spam },
      )
      return ok({ spamCall: { spam, by: isAgent(actor) ? ('claude' as const) : ('owner' as const) } })
    })
  }

  // ─── the switch ──────────────────────────────────────────────────────

  /**
   * The owner switches the spam check on a Cloudflare mailbox, on or off (named `setAssistant` since the switch began as the
   * assistant's; the assistant now only drafts when asked and has no switch). The owner's alone: an agent is refused here and at the
   * route. From then on the switch decides and the deploy config's declaration no longer does. Mail keeps arriving whichever it
   * is: switched off, nothing is asked of the spam classifier and every message is in the Inbox and notifies; what it said before stays.
   */
  setAssistant(
    mailboxId: string,
    enabled: boolean,
    actor: string,
  ): Result<{ id: string; enabled: boolean; changedAt: string; changedBy: string }> {
    if (actor !== this.owner.email) return fail(403, onlyOwnerSwitchesSpamCheck(this.owner.name))
    return this.ports.transaction(() => {
      const r = this.sql.exec(`SELECT kind, assistant, address FROM mailbox WHERE id = ?1`, mailboxId).toArray()[0]
      if (!r) return fail(404, 'No such mailbox.')
      if (r.kind !== 'cloudflare') return fail(422, 'The assistant runs only on a Cloudflare mailbox.')
      if (enabled && !this.ports.content.hasSpamQuestions(text(r.address))) {
        return fail(
          422,
          `No spam questions are written for ${text(r.address)}, so the spam check cannot be turned on for it.`,
        )
      }
      const at = this.now()
      this.sql.exec(
        `UPDATE mailbox SET assistant = ?2, assistant_set_by = ?3, assistant_set_at = ?4 WHERE id = ?1`,
        mailboxId,
        enabled ? 1 : 0,
        actor,
        at,
      )
      this.audit(
        actor,
        'mailbox.assistant',
        `mailbox:${mailboxId}`,
        { enabled: Number(r.assistant) === 1 },
        { enabled },
      )
      return ok({ id: mailboxId, enabled, changedAt: at, changedBy: actor })
    })
  }

  // ─── the draft chat ──────────────────────────────────────────────────

  /**
   * One turn kept beside a draft. Appended and never edited; deleted only with the draft (store.deleteDraft). Not audited here: the
   * turn is the record, and the audit entry of the act that made it (a chat turn, a pass that left the draft) names the draft.
   */
  protected addChatTurn(
    draftId: string,
    turn: {
      by: string
      instruction: string | null
      note: string
      revised: boolean
      revBefore: number
      revAfter: number | null
    },
  ): ChatTurn {
    const at = this.now()
    this.sql.exec(
      `INSERT INTO draft_chat (draft_id, at, by, instruction, note, revised, rev_before, rev_after)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      draftId,
      at,
      turn.by,
      turn.instruction,
      turn.note,
      turn.revised ? 1 : 0,
      turn.revBefore,
      turn.revAfter,
    )
    const seq = Number(this.sql.exec(`SELECT max(seq) AS n FROM draft_chat WHERE draft_id = ?1`, draftId).one().n)
    return {
      seq,
      at,
      instruction: turn.instruction,
      note: turn.note,
      revised: turn.revised,
      revBefore: turn.revBefore,
      revAfter: turn.revAfter,
    }
  }

  /**
   * The address of the mailbox a conversation sits in: what names the business whose knowledge the assistant is given. A read, and it
   * changes nothing, so the assistant can ask the knowledge app before `prepareChat` saves anything of the owner's. The same refusals as
   * `prepareChat` for a conversation that is not there or sits in no mailbox (a text, a DM).
   */
  chatMailbox(conversationId: string): Result<{ address: string }> {
    const conv = this.sql
      .exec(
        `SELECT mb.kind, mb.address FROM conversation c LEFT JOIN mailbox mb ON mb.id = c.mailbox_id WHERE c.id = ?1`,
        conversationId,
      )
      .toArray()[0]
    if (!conv) return fail(404, 'No such conversation.')
    if (!isEmailKind(textOrNull(conv.kind))) return fail(422, CHAT_NEEDS_MAILBOX)
    return ok({ address: text(conv.address) })
  }

  /**
   * Everything one chat turn needs, read at one moment, and the owner's unsaved edits saved as their own first so the assistant revises
   * what they see. Refuses (with the store's words) anyone but the owner, a conversation with no mailbox (a text, a DM), a
   * draft that is not the conversation's, one that moved on since the owner was shown it, and a conversation that has a draft when
   * none is named. A draft's `rev` is REQUIRED for the same reason a send's is. It reads nothing from the spam check and does not
   * care where the conversation sits (Inbox, Bulk, Closed). The knowledge base is not read here: the knowledge app is asked first, by the
   * assistant, for the conversation's mailbox's business (`chatMailbox` names the mailbox), and what it answered is passed in as `knowledge`.
   *
   * WHO THE REPLY IS TO AND WHAT THE MODEL SEES (one rule for every mailbox, and for a thread of several
   * people). The reply is to whoever the reply plan addresses (the newest inbound message's Reply-To, else its From,
   * never us; with nothing inbound, the newest message's first To), which is where the Reply button in the box would send it; a draft
   * already waiting is to its own recipient. The model is shown only what was exchanged with that one person: the messages they
   * wrote and our messages addressed to them, plus, when there is no draft yet, the message being answered (which a Reply-To can
   * make someone else's); with a draft named, only that recipient's own messages. Never the rest of the thread. Quoted history
   * inside those messages is cut where it can be proved to be a quote. A person copied on a thread is answered from their own side of it, as a stranger is: the cost of the
   * simple rule, and the safe one.
   */
  prepareChat(
    conversationId: string,
    input: ChatInput,
    actor: string,
    knowledge: { title: string; body: string }[] | null,
  ): Result<ChatContext> {
    if (actor !== this.owner.email) return fail(403, onlyOwnerChats(this.owner.name))
    return this.ports.transaction(() => {
      const conv = this.sql
        .exec(
          `SELECT mb.id AS mailbox_id, mb.kind, mb.address, mb.display_name
             FROM conversation c LEFT JOIN mailbox mb ON mb.id = c.mailbox_id WHERE c.id = ?1`,
          conversationId,
        )
        .toArray()[0]
      if (!conv) return fail(404, 'No such conversation.')
      if (!isEmailKind(textOrNull(conv.kind))) return fail(422, CHAT_NEEDS_MAILBOX)
      const detail = this.getConversation(conversationId)
      if (!detail.ok) return detail

      const named = this.draftToChatAbout(detail.value.drafts, input, actor)
      if (!named.ok) return named
      const draft = named.value

      const settled = detail.value.messages.filter((m) => m.status !== 'failed' && inPlay(m.labels))
      const newest = settled.at(-1)
      if (!newest) return fail(422, 'There is no message on this conversation for the assistant to answer.')
      // The message being answered is the newest one that came in, but only when there is no draft yet: a draft is to its own
      // recipient, and the newest message on the thread may be somebody else's (a private reply, or one that tries to steer the
      // model), so with a draft the model is shown that recipient's own messages and nothing else.
      const answered = draft ? null : ([...settled].reverse().find((m) => m.direction === 'in') ?? null)
      const to = draft
        ? { address: draft.address, name: draft.contactName }
        : (this.replyPlan(conversationId)?.to ?? null)
      if (!to) return fail(422, CHAT_NO_ONE_TO_ANSWER)
      const participant = { address: to.address, name: to.name }
      const exchange = settled.filter((m) => m.address === participant.address || m.id === answered?.id)
      const lastFromThem = [...exchange].reverse().find((m) => m.direction === 'in')
      const kept = detail.value.drafts.find((d) => d.id === draft?.id)?.chat ?? []

      return ok({
        mailbox: { id: text(conv.mailbox_id), name: text(conv.display_name), address: text(conv.address) },
        conversationId,
        draftId: draft?.id ?? null,
        baseRev: draft?.rev ?? 0,
        draft: draft?.body ?? '',
        participant,
        subject: lastFromThem?.subject ?? draft?.subject ?? newest.subject,
        // What each message says itself: a reply-all or a forward carries other people's words under its own (an earlier message of
        // the thread, quoted), and those are cut where the quote can be proved to be one (src/quote.ts); what cannot be proved is
        // sent as written, marked data like the rest.
        thread: exchange.map((m) => ({
          direction: m.direction,
          from: m.from,
          at: m.sentAt ?? m.createdAt,
          body: splitQuoted(m.body, {
            earlier: settled.slice(0, settled.indexOf(m)).map((e) => e.body),
            subject: m.subject,
          }).visible,
        })),
        knowledge,
        history: kept
          .slice(-MAX_CHAT_TURNS_SHOWN)
          .flatMap((t): ChatHistoryLine[] => [
            ...(t.instruction === null ? [] : [{ role: 'owner' as const, text: t.instruction }]),
            { role: 'assistant' as const, text: t.note },
          ]),
        usageMessageId: draft?.id ?? newest.id,
      })
    })
  }

  /**
   * The draft a chat turn is about, with what the owner typed and had not saved written to it as their own edit; null when they name none
   * and the conversation has none (the turn then makes one). A conversation that has a draft must have it named.
   */
  private draftToChatAbout(waiting: MessageRow[], input: ChatInput, actor: string): Result<MessageRow | null> {
    if (!input.draftId) return waiting.length > 0 ? fail(409, CHAT_NAME_THE_DRAFT) : ok(null)
    const draft = waiting.find((d) => d.id === input.draftId)
    if (!draft) return fail(404, 'No such draft on this conversation.')
    if (draft.status !== 'draft') return fail(409, 'This draft is being sent, so it cannot be changed now.')
    if (!isWhole(input.rev)) return fail(422, CHAT_NEEDS_REV)
    if (input.rev !== draft.rev) return fail(409, CHAT_DRAFT_MOVED)
    // What was typed and not saved is saved as the owner's edit first, so the revision the assistant starts from is one they made.
    const body = typeof input.body === 'string' ? input.body.trim() : ''
    const subject = typeof input.subject === 'string' ? input.subject.trim() : ''
    const patch: { rev: number; body?: string; subject?: string } = { rev: draft.rev }
    if (body !== '' && body !== draft.body.trim()) patch.body = body
    if (subject !== '' && subject !== draft.subject.trim()) patch.subject = subject
    if (patch.body === undefined && patch.subject === undefined) return ok(draft)
    return this.updateDraft(draft.id, patch, actor)
  }

  /**
   * Apply the assistant's answer to a chat turn, in ONE transaction: the revised draft (made at the next revision, so a send that
   * names the old one is refused), or, for a conversation that had none, an empty draft in the owner's name that the assistant then
   * fills, and the turn kept beside it. The draft is revised only if it is still the one the turn was asked about (the same
   * revision, still a draft): a model call takes seconds and the owner, the alarm or Claude can change it meanwhile. Then it is left as
   * it is, the turn says so, and nothing is written over anyone's words. An answer with an em dash in its draft is never stored.
   */
  applyChat(
    ctx: ChatContext,
    instruction: string,
    answer: { draft: string | null; note: string; dashed?: boolean },
    actor: string,
  ): Result<ChatAnswer> {
    return this.ports.transaction(() => {
      const target = this.draftForTurn(ctx, actor)
      if (!target.ok) return target
      let draft = target.value.draft
      let note = answer.note
      let revise = answer.draft !== null && answer.draft.trim() !== ''
      if (answer.dashed) {
        revise = false
        note += '\n\nThe draft I wrote kept an em dash after I was asked again, so I did not change the draft.'
      }
      if (target.value.moved) {
        revise = false
        note +=
          '\n\nThe draft changed while I was working on it, so I left it as it is. Ask again if you still want this.'
      }

      const revBefore = draft.rev
      let revAfter: number | null = null
      if (revise) {
        const revised = this.updateDraft(
          draft.id,
          {
            rev: revBefore,
            body: answer.draft as string,
            // A draft the assistant fills for the owner names why in its own first line; a revision leaves the why it had.
            ...(ctx.draftId === null && { why: oneLine(note, 300) || assistantWhy(this.owner.name) }),
          },
          ASSISTANT_ACTOR,
        )
        if (!revised.ok) return revised
        revAfter = revised.value.rev
        draft = revised.value
      }
      const turn = this.addChatTurn(draft.id, {
        by: actor,
        instruction,
        note,
        revised: revAfter !== null,
        revBefore,
        revAfter,
      })
      this.audit(actor, 'assistant.chat', `message:${draft.id}`, null, {
        instruction,
        revised: revAfter !== null,
        revBefore,
        revAfter,
      })
      return ok({ draft: this.message(draft.id) as MessageRow, turn })
    })
  }

  /**
   * The draft a turn's answer is applied to, as it is now: the one named when the turn was asked (`moved` when it changed since,
   * or refused when it was sent or deleted), or, for a conversation that had none, a new empty one in the owner's name. Never replaces
   * a draft that appeared meanwhile.
   */
  private draftForTurn(ctx: ChatContext, actor: string): Result<{ draft: MessageRow; moved: boolean }> {
    if (ctx.draftId !== null) {
      const draft = this.message(ctx.draftId)
      if (draft?.status !== 'draft') {
        return fail(409, 'The draft was sent or deleted while the assistant was working. Nothing was changed.')
      }
      return ok({ draft, moved: draft.rev !== ctx.baseRev })
    }
    const meanwhile = this.sql
      .exec(`SELECT 1 FROM message WHERE conversation_id = ?1 AND status IN ${PENDING} LIMIT 1`, ctx.conversationId)
      .toArray()[0]
    if (meanwhile) return fail(409, 'A draft appeared while the assistant was working. Chat about that one.')
    const made = this.createDraft(
      {
        conversationId: ctx.conversationId,
        address: ctx.participant.address,
        name: ctx.participant.name,
        subject: replySubject(ctx.subject),
        body: '',
      },
      actor,
      { empty: true },
    )
    return made.ok ? ok({ draft: made.value, moved: false }) : made
  }

  /** A chat turn that got no answer: the owner's words are kept where they typed them, and the audit says what failed. */
  auditChatFailure(conversationId: string, reason: string): void {
    this.audit(ASSISTANT_ACTOR, 'assistant.chat-failed', `conversation:${conversationId}`, null, {
      reason: oneLine(reason, 300),
    })
  }

  // ─── what each call cost ─────────────────────────────────────────────

  /** One call to the model, whatever it came to. */
  recordUsage(u: {
    mailboxId: string
    conversationId: string
    messageId: string
    operation: 'chat'
    model: string
    inputTokens: number
    outputTokens: number
    outcome: 'ok' | 'error' | 'unreadable'
    error?: string
  }): void {
    this.sql.exec(
      `INSERT INTO assistant_usage (at, mailbox_id, conversation_id, message_id, operation, model, input_tokens, output_tokens, outcome, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      this.now(),
      u.mailboxId,
      u.conversationId,
      u.messageId,
      u.operation,
      u.model,
      u.inputTokens,
      u.outputTokens,
      u.outcome,
      u.error === undefined ? null : oneLine(u.error, 300),
    )
  }

  /** The calls from `since` to `until` (both inclusive), summed, with an estimate of what they cost. */
  usageBetween(since: string, until: string): Omit<AssistantUsage, 'keyConfigured'> {
    const rows = this.sql
      .exec(
        `SELECT model, count(*) AS calls, count(*) FILTER (WHERE outcome = 'ok') AS ok,
                coalesce(sum(input_tokens), 0) AS input, coalesce(sum(output_tokens), 0) AS output
           FROM assistant_usage WHERE at >= ?1 AND at <= ?2 GROUP BY model ORDER BY model`,
        since,
        until,
      )
      .toArray()
    const byModel = rows.map((r) => ({
      model: text(r.model),
      calls: Number(r.calls),
      inputTokens: Number(r.input),
      outputTokens: Number(r.output),
      priced: costUsd(text(r.model), 0, 0) !== null,
    }))
    const costs = byModel.map((m) => costUsd(m.model, m.inputTokens, m.outputTokens))
    const calls = rows.reduce((n, r) => n + Number(r.calls), 0)
    const succeeded = rows.reduce((n, r) => n + Number(r.ok), 0)
    return {
      since,
      until,
      calls,
      succeeded,
      failed: calls - succeeded,
      inputTokens: byModel.reduce((n, m) => n + m.inputTokens, 0),
      outputTokens: byModel.reduce((n, m) => n + m.outputTokens, 0),
      estimatedCostUsd: costs.some((c) => c === null) ? null : costs.reduce<number>((n, c) => n + (c ?? 0), 0),
      byModel,
    }
  }
}
