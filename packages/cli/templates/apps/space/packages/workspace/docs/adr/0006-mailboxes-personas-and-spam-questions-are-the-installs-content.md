# Mailboxes, personas and spam questions are the install's content

Status: accepted. Follows ADR 0005 (addresses, senders and names come from the install). Amends ADR 0004's line that the spam check depends on the `assistant` switch.

## What changed, and why

An install's business mailboxes were a list in the Worker's settings, and its assistant personas and spam-check questions were constants in the inbox's code, keyed by address. A second install would have carried the first one's customers' mailboxes, voices and questions with it, and could not have written its own without changing code. They are now the install's.

- **The mailboxes are the declaration's** (`cloudflareMailboxes`: address, name, a short name for sentences, and whether the spam check begins on; `Install.cloudflareMailboxes()`). Each is one of a business's `mailboxes`, on a domain of its own (Email Routing's catch-all makes the domain the mailbox), and is not the owner's own address. The Worker's `INBOX_MAILBOXES` var, which the inbox reads, is written from them by the install kit (ADR 0007), as `INBOX_JMAP_MAILBOXES` is for ADR 0004: there is no copy to keep equal (the infra package's `test/inbox-businesses.test.ts` holds the mapping).
- **Personas and spam questions are content, not settings.** One JSON file beside the declaration (`workspace-content.json`) holds `personas` and `spamQuestions` keyed by mailbox address. It is bundled at build as the declaration is (`@inbox/content`, the space's `vite.config.ts` and `tsconfig.json`; `SPACE_CONTENT` names another; a company whose declaration has none beside it has none, an empty file). The inbox reads them per mailbox (the inbox package's `src/mailbox-content.ts`): a mailbox with no persona gets no assistant and a mailbox with no spam questions gets no spam check, as before. One file and not one per mailbox because a Worker bundles a file it can import by name, and an alias to a folder cannot be imported by bun's tests and vite alike.
- **A file that disagrees with the declaration does not load.** A persona for an address no business has, questions for an address that is not a declared Cloudflare mailbox, a kind of answer the spam check's reason lines have no words for, a question set whose first question does not describe exactly the kinds it lists, and a mailbox declared with its spam check on that has no questions are all refused when the file is read. **When that is:** the space's `vite.config.ts` reads the declaration's content file with `readMailboxContent` when the config loads, for every install, so the build stops with every problem named and nothing is bundled or deployed (the space package's `test/build-checks.test.ts` runs the real build on files that disagree); the Worker reads it again at its start as a second net. A typo is a failed build, not an assistant that quietly never speaks. The words themselves are not checked: they are the install's.
- **An existing install's words moved without changing.** The personas and question sets are the strings the code held, written by running that code, and tests kept beside that install hold them: every chat request each persona makes in three situations, equal to what the code produced before, character for character (a golden file).
- **The kinds the spam check chooses from stay code** (the inbox's category-words list: customer, business correspondence, a worker's question and the rest, each with its words in a reason line). They are a closed list a question set draws from, so a stored category always has words. A second install that needs a kind of its own adds it there.

## The spam check is per mailbox

ADR 0004 made the spam check's model binding depend on the `assistant` switch. The spam check is not the assistant's (the assistant only drafts when asked; the inbox's ADR 0001, decisions 22 to 24), and it is per mailbox. It now runs wherever a mailbox has spam questions, whether or not the install's assistant is on: the Worker's binding is used when any mailbox of the install has questions (`spamCheckAiFor`), the mailbox's own switch (the store's, which starts as the declaration's `spamCheck` and is the owner's from the first time they press it) decides for that mailbox, and a mailbox with no questions is never asked. An install whose assistant is on and whose mailboxes have questions is unchanged.

## Words that named particular mailboxes

The refusal "Files can be sent from a business mailbox only (<short names>), not from the owner's Gmail" names the install's mailboxes by their short names, in declaration order (an install with none names none).

## Details of the signing service's words

- **Claude's principal is the install's own company, not who runs the service.** The certificate's line for a send Claude made ("for Northfield Works LLC, on the recorded instruction of Tessa Marlow") and the privacy notice's section on Claude ("Northfield Works may later let Claude ... only when Tessa Marlow tells it to") name the install's company (`ServiceWords.company`: its name and its legal name, the declaration's `company.legalName`, the name where left out), which is not the runner where another company runs Forms (Claude would still be the install's company's). The notice's section is `claudeNotice` in the forms package's `src/service.ts`.
- **The signing service's contact is required.** It is served publicly (`/s/api/service`, the privacy notice, the signer's page), so it is never defaulted to the owner's own address. A declaration without `formsService.contact` does not parse.
- **A signed-in guest's screens word the company from their bootstrap**, not from the public `GET /w/api/site`, which a screen nobody is signed in to asks and which can lag or fail, leaving "The company runs meet" in the privacy notice.

## What stays

The Worker's settings file, the deploy and the kit are ADR 0007's. The phone's words, the dev stand-ins and the space's screens that name particular mailboxes in their own sentences (the compose box's refusal about files) are not moved here.
