// The email meet sends, and how. Three kinds, and none of them ever carries the text of a message: a guest's
// sign-in code, an invitation to a channel, and a nudge that a direct message is waiting.
//
// Sending is Cloudflare Email Service's `send_email` binding on the install's domain, the way another app's reminders are sent
// (the Mailer shape and the binding adapter are copied from it), as a site's own sign-in mail is. The binding allows meet@northfield.example as its only sender
// (the Worker's settings). No secret, no vendor and no DNS record belong to this app.

import type { Install } from '@space/workspace'
import { CODE_TTL_MS, MINUTE, NUDGE_AFTER_MS } from './workspace-model'
import type { NudgeDue } from './workspace'
import type { Notice911 } from './phone'

/** What the Worker's `send_email` binding takes in its structured form. */
export interface Outgoing {
  from: { email: string; name: string }
  to: string
  subject: string
  text: string
}

export interface Mailer {
  send(message: Outgoing): Promise<{ messageId: string | null }>
}

/** The address and name meet's mail goes out as: the install's meet sender (the declaration's `senders.meet`), which the Worker's send binding allows. */
export const senderOf = (install: Install): { email: string; name: string } => ({ email: install.sender('meet'), name: 'meet' })

/** Cloudflare's `send_email` binding as a Mailer. A refusal throws; an answer without an id is still an acceptance. */
export function bindingMailer(binding: { send(message: Outgoing): Promise<unknown> }): Mailer {
  return {
    async send(message) {
      const answer = (await binding.send(message)) as { messageId?: unknown } | undefined
      return { messageId: typeof answer?.messageId === 'string' ? answer.messageId : null }
    },
  }
}

/**
 * For a localhost run (`vite dev`): nothing leaves the machine. Each email is logged and kept in `outbox`, which
 * the live check reads through the dev-only route in app.ts to find the code a guest was sent.
 */
export function devMailer(outbox: Outgoing[]): Mailer {
  return {
    async send(message) {
      outbox.push(message)
      if (outbox.length > 50) outbox.shift()
      console.log(`[mail] to ${message.to}: ${message.subject}\n${message.text}`)
      return { messageId: null }
    },
  }
}

const origin = (o: string) => o.replace(/\/+$/, '')

/**
 * Where the company's people read and listen: the space's Meet tab (meet's own /start is gone; Inbox
 * and Meet are separate tabs, and chat and the Phone are Meet's). The address is the install's, so an email never names a host the declaration does not.
 */
export const meetUrl = (install: Install): string => install.tabs().find((t) => t.id === 'meet')?.url ?? install.url()

/**
 * A name someone chose, as it may sit in the body of an email: no address-like or markup-like characters, and no dot
 * (or look-alike dot, such as the ideographic and fullwidth ones a browser reads as a dot in an address) between two
 * non-space characters, so it cannot be written to look like a link or a sender (mail clients turn `example-login.example`
 * into a link without a scheme). A dot at the end of a word ("Jr.") stays. Names never go in a subject, which is what a
 * person reads first and what a stranger's chosen words could otherwise shape.
 */
const DOTS = '.。．｡․﹒'
const BETWEEN_DOTS = new RegExp(`(?<=[^\\s${DOTS}])[${DOTS}]+(?=[^\\s${DOTS}])`, 'g')
export const plain = (s: string): string =>
  s
    .replace(/[:/@<>\\]+/g, ' ')
    .replace(BETWEEN_DOTS, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export function codeEmail(to: string, code: string, install: Install): Outgoing {
  const minutes = Math.round(CODE_TTL_MS / MINUTE)
  return {
    from: senderOf(install),
    to,
    subject: `Your meet sign-in code: ${code}`,
    text: [
      `Your meet sign-in code is ${code}.`,
      '',
      `It works once and stops working in ${minutes} minutes. Type it into the page you asked for it on.`,
      '',
      'If you did not ask for it, you can ignore this email: nobody can sign in without the code.',
    ].join('\n'),
  }
}

export function inviteEmail(to: string, inviter: string, channel: string, appOrigin: string, install: Install): Outgoing {
  return {
    from: senderOf(install),
    to,
    subject: 'You were added to a channel on meet',
    text: [
      `${plain(inviter)} added you to the channel "${plain(channel)}" on meet, ${install.company.name}'s chat.`,
      '',
      `To open it, go to ${origin(appOrigin)}/w/ and enter this email address. meet will email you a 6-digit code to sign in; there is no password.`,
      '',
      'You will see only the channels you are added to and the people in them. Messages are kept until they are deleted; the page tells you more when you sign in.',
    ].join('\n'),
  }
}

/** Who wrote and how many, never what. The link is to the person's own door: the space's Meet for the company's people, meet's /w for guests. */
export function nudgeEmail(due: NudgeDue, appOrigin: string, install: Install): Outgoing {
  const link = due.kind === 'teammate' ? meetUrl(install) : `${origin(appOrigin)}/w/`
  const who = due.senders.map((s) => `${plain(s.name)} (${s.count})`).join(', ')
  return {
    from: senderOf(install),
    to: due.email,
    subject: 'You have a direct message waiting on meet',
    text: [
      `You have ${due.total} new direct ${due.total === 1 ? 'message' : 'messages'} on meet, the oldest unread for ${Math.round(NUDGE_AFTER_MS / MINUTE)} minutes or more.`,
      '',
      `From: ${who}`,
      '',
      `Read them at ${link}`,
      '',
      'meet sends at most one of these an hour and never includes what a message says. You can turn them off in the page under your name.',
    ].join('\n'),
  }
}

/**
 * 911 was dialed from meet: to the company's owner (`to`), at once, who and from which address. The subject is fixed text; the name and the
 * address a person typed appear only in the body, with the characters that could make a link taken out. It never delays
 * the call (the router sends it after the call has been handed to Telnyx).
 */
export function emergencyEmail(n: Notice911, install: Install, to: string): Outgoing {
  return {
    from: senderOf(install),
    to,
    subject: '911 was dialed from meet',
    text: [
      `${n.email ? plain(n.name) : 'Someone'} dialed 911 from meet at ${new Date(n.at).toISOString().replace('T', ' ').slice(0, 16)} UTC.`,
      '',
      n.email
        ? n.address
          ? `The address meet holds for ${plain(n.name)}, and gave the emergency service: ${plain(n.address)}`
          : `meet holds no address for ${plain(n.name)}: the emergency service has only what the ${install.company.name} number has on file.`
        : `meet could not tell who it was, so the call left from the ${install.company.name} number and carried its address.`,
      '',
      `Check on them first. Calls from meet are listed at ${meetUrl(install)}/phone, in the Phone conversation.`,
    ].join('\n'),
  }
}

/** The month's phone minutes have reached 80% or 100% of the cap meet keeps; to the company's owner (`to`). */
export function capEmail(level: number, used: number, cap: number, to: string, install: Install): Outgoing {
  return {
    from: senderOf(install),
    to,
    subject: level >= 100 ? 'meet has used all its phone minutes for the month' : `meet has used ${level}% of its phone minutes for the month`,
    text: [
      `${used} of ${cap} minutes used this month.`,
      '',
      level >= 100
        ? 'New calls from meet are refused until the 1st. 911 still works.'
        : 'At 100% new calls from meet are refused until the 1st. 911 always works.',
    ].join('\n'),
  }
}

/** Telnyx's prepaid balance has fallen under the line the owner set; to the owner (`to`), once a day at most. */
export function balanceEmail(availableUsd: number, to: string, install: Install): Outgoing {
  return {
    from: senderOf(install),
    to,
    subject: 'meet is running low on phone credit',
    text: [`The Telnyx balance is $${availableUsd.toFixed(2)}.`, '', 'When it runs out, calls from meet stop. Add credit in Telnyx.'].join('\n'),
  }
}

/**
 * A voicemail was left: to each of the company's people, naming the number and the length and never the audio (and never any words of it:
 * nothing here is transcribed). The number is shown as a phone number, or as words when it was withheld; the link is to the space's
 * Phone conversation, where the voicemail plays for a signed-in person of the company only.
 */
export function voicemailEmail(to: string, number: string, seconds: number, install: Install): Outgoing {
  const length = seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} sec` : `${seconds} sec`
  return {
    from: senderOf(install),
    to,
    subject: 'You have a voicemail on meet',
    text: [
      `A voicemail from ${plain(number)}, ${length}, was left on the ${install.company.name} number.`,
      '',
      `Listen to it at ${meetUrl(install)}/phone, in the Phone conversation. The sound is not in this email and has no link: it plays only there, for ${install.company.name} people who are signed in.`,
      '',
      'You can turn these emails off in the page under your name (the same switch as the one for direct messages).',
    ].join('\n'),
  }
}
