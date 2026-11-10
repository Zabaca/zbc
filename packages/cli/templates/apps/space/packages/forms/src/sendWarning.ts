/**
 * What an operator is told before sending anything through the install's signing service: documents a legal research pass found that an electronic
 * signature may not carry, or that need more than one. Research to inform an attorney, not legal advice: the list is a
 * stop-and-ask list, and "the client's lawyer" is whose
 * lawyer it is when the install's company sends for a client. Shown on the Send screen and again beside the button that sends.
 */
export const sendWarningHeading = (service: { name: string }): string => `Do not send these through ${service.name} without written OK from the client's lawyer:`

export const SEND_WARNING_ITEMS: readonly string[] = [
  'wills, trusts, powers of attorney, or anything that needs a notary or witnesses;',
  'divorce, custody, adoption or other family-law papers;',
  'court filings, court orders or legal notices;',
  'notices of eviction, foreclosure, default, repossession, utility shutoff, or insurance cancellation;',
  'promissory notes, checks or security agreements;',
  'credit repair, home-equity sale, foreclosure-consultant, home-solicitation, car-finance or retail-installment contracts;',
  'any form where a law says a specific part must be separately signed or initialed;',
  'IRS Form 8879 or 8878 signed by finger or typed (an uploaded photo of a wet-ink signature is different), and IRS 2848 or 8821 for a new client;',
  'a debt-settlement contract with a California consumer unless the disclosures and unsigned contract went out at least 3 days earlier;',
  'anything a minor signs;',
  'anything negotiated in Spanish, Chinese, Tagalog, Vietnamese or Korean that California requires to be translated.',
]
