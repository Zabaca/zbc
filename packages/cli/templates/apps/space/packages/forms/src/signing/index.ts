/**
 * THE SIGNING CORE: an envelope's whole life, and the only writer of envelopes, recipients, field values and events
 * (ADR 0001). It takes a prepared document (src/fields.ts) and knows nothing about forms or uploads, with two exceptions: purge.ts deletes an envelope's uploads, and mail.ts counts them for a client copy address's completion email.
 *
 *   operator side (lifecycle.ts): createEnvelope, updateDraft, send, remind, cancel, correctRecipient, expire, attachPrepared
 *   signer side   (signer.ts):    open, consent, showDocument, adopt, saveField, finish, decline
 *   completion    (completion.ts): maybeSeal, completeEnvelope, gatherCertificate
 *   Claude's rule (instructions.ts): recordInstruction, gateAgent, setAgentSending
 *   retention and time: purgeEnvelope, sweep
 *   what each side is shown (views.ts)
 *
 * Every state change is one batch with exactly one event, guarded by the state it expects (src/events.ts `appendEvents`,
 * `whenStatus`), so two requests racing for a step change things once.
 */
import { watched } from '../live'
import { bindingMailer } from '../mail'
import type { Env } from '../http'
import { loadSealer } from '../seal/sealer'
import { createVault } from '../vault'
import { type Install, bundledInstall, noticeTo, ownerOf, serviceWordsOf } from '../workspace'
import type { CoreDeps } from './support'

export { completeEnvelope, gatherCertificate, maybeSeal } from './completion'
export { agentSendingOn, gateAgent, recordInstruction, setAgentSending } from './instructions'
export type { InstructionInput } from './instructions'
export { attachPrepared, cancel, checkedConversation, correctRecipient, createEnvelope, expire, remind, send, updateDraft } from './lifecycle'
export type { CreateInput, DraftPatch, RecipientInput } from './lifecycle'
export { SAMPLE_SOURCE_OWNER, purgeDue, purgeEnvelope } from './purge'
export { adopt, consent, consentSample, consentTerms, decline, finish, open, resolveToken, saveField, showDocument, stateOf } from './signer'
export { sweep } from './sweep'
export type { SweepResult } from './sweep'
export { certificateView, downloadFinished, envelopeView, listEnvelopes, mailPreview, operatorDownload, pictureOf, revealAnswer, signerCertificate, signerView } from './views'
export { flushMail } from './mail'
export type { Actor, CoreDeps, Origin } from './support'
export { requireOperator } from './support'

/** The core for a Worker request or a cron run: its bindings, with the mail seam and the clock injected. */
export function coreFor(env: Env, now: () => number, install: Install = bundledInstall): CoreDeps {
  return {
    db: watched(env.DB, env.LIVE, install, env.LIVE_WAIT),
    files: env.FILES,
    vault: createVault(env),
    mailer: env.EMAIL ? bindingMailer(env.EMAIL) : null,
    sealer: () => loadSealer(env),
    notice: noticeTo(install),
    owner: ownerOf(install),
    service: serviceWordsOf(install),
    // One origin for every link an email carries: the install's space host, never a setting beside it.
    origin: install.url().replace(/\/+$/, ''),
    now,
  }
}
