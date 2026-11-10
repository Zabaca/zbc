/**
 * What a Gmail account is called on the conversations that came through it: the short label that is its pill, the way a business
 * mailbox's name is. An owner can have several (northfield.example, brightwater.example, gmail.com), so a pill that read "Gmail" would say nothing.
 *
 * The label is the part of the address that tells accounts apart: before the @ for a gmail.com address ("tessa.marlow"), the domain's first
 * label for any other ("northfield" for tessa@northfield.example). When another account already has that label, the address itself is the label, so
 * two accounts never wear the same pill. Migration 14 (src/store/schema.ts) gives the account that already exists its label with the same rule in SQL.
 */
export function accountLabel(address: string, taken: readonly string[] = []): string {
  const clean = address.trim().toLowerCase()
  const at = clean.indexOf('@')
  if (at <= 0) return clean
  const domain = clean.slice(at + 1)
  const label = domain === 'gmail.com' ? clean.slice(0, at) : (domain.split('.')[0] ?? '')
  if (label === '' || taken.some((t) => t.toLowerCase() === label)) return clean
  return label
}
