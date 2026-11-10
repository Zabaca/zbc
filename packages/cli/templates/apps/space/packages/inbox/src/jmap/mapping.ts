import { LABEL } from '../gmail/types'
import type { JmapEmail, JmapFolder } from './types'

/**
 * A message's state on the mail server becoming the label words the store already derives read and closed from (src/store/store.ts `foldConversation`): the seam between the JMAP side and the
 * store's label-shaped path. Pure, so the whole table is a table test.
 *
 *   in the Inbox                    INBOX       Open
 *   not marked seen                 UNREAD      Unread
 *   in Archive, or in any folder
 *     but the Inbox                 (no INBOX)  Closed
 *   in Sent                         SENT        sent by the mailbox, read and closed
 *   in Trash                        TRASH       kept, not counted (as Gmail's trash)
 *   in Junk                         SPAM        not brought in (as Gmail's spam), and never counted
 *   in Drafts, or marked a draft    DRAFT       not brought in (as Gmail's drafts)
 *   flagged                         STARRED     kept with the message and shown nowhere
 *
 * A message in several folders (JMAP allows it; Stalwart's mail apps put a message in one) is read as the most specific: Trash, then Junk, then Drafts win over the Inbox, so a message a person threw away
 * is never open; Inbox and Sent both count when it is in both.
 */

/** The folders by role: the ids the mapping reads and the module moves between. Null for a role the account has no folder for. */
export interface FolderIds {
  inbox: string | null
  sent: string | null
  drafts: string | null
  trash: string | null
  junk: string | null
  archive: string | null
}

export function foldersByRole(list: readonly JmapFolder[]): FolderIds {
  const id = (role: string): string | null => list.find((f) => f.role === role)?.id ?? null
  return {
    inbox: id('inbox'),
    sent: id('sent'),
    drafts: id('drafts'),
    trash: id('trash'),
    junk: id('junk'),
    archive: id('archive'),
  }
}

/** The label words for a message in these folders with these keywords. Sorted and without repeats, as the store keeps labels. */
export function labelsOf(email: Pick<JmapEmail, 'mailboxIds' | 'keywords'>, folders: FolderIds): string[] {
  const inFolder = (id: string | null): boolean => id !== null && email.mailboxIds[id] === true
  const labels = new Set<string>()
  const trash = inFolder(folders.trash)
  const junk = inFolder(folders.junk)
  const draft = inFolder(folders.drafts) || email.keywords.$draft === true
  const sent = inFolder(folders.sent)
  if (trash) labels.add(LABEL.trash)
  if (junk) labels.add(LABEL.spam)
  if (draft) labels.add(LABEL.draft)
  if (inFolder(folders.inbox) && !trash && !junk) labels.add(LABEL.inbox)
  if (sent) labels.add(LABEL.sent)
  // What a person wrote is read by its writer: a sent copy carries no unread mark whatever the server stored.
  if (email.keywords.$seen !== true && !sent) labels.add(LABEL.unread)
  if (email.keywords.$flagged === true) labels.add('STARRED')
  return [...labels].sort()
}

/** What the store keeps of a message the server has destroyed: it is kept, and counts for nothing, as a message Gmail put in the trash. */
export const DESTROYED_LABELS: readonly string[] = [LABEL.trash]
