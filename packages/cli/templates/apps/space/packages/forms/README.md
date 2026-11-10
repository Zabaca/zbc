# forms

A signing service for the clients of the company that runs the install. A client's forms and agreements go to its customers branded as the
client ("Brightwater Builders via <service name>", where the service name is the install's own), are signed on a phone, and come back as a PDF sealed so that any later change shows.
The company operates it: its operators work in the Forms tab of the space (the space's host under `/forms`), set up signing for a Client (the one list of Clients, made in Settings; [the space's ADR 0021](../space/docs/adr/0021-clients-are-a-part-of-the-space-with-a-store-of-their-own-and-sources-push-them-in.md), section 6), and send. Signers open their links under the space's host at `/s/`. No client logs in. Forms has no Worker or address of its own: it runs inside the space's Worker. Terms are
in [`CONTEXT.md`](CONTEXT.md) and the design decisions are
[ADR 0001](docs/adr/0001-one-prepared-document-between-authoring-and-signing.md),
[0002](docs/adr/0002-pdf-work-in-the-worker-behind-an-engine-interface.md),
[0003](docs/adr/0003-the-seal-behind-an-interface-built-for-a-hardware-held-key.md) and
[0004](docs/adr/0004-per-envelope-keys-and-deletion-as-retention.md),
[0005](docs/adr/0005-every-state-change-is-one-batch-anchored-on-its-event.md) and
[0006](docs/adr/0006-form-answers-are-drafts-until-the-document-is-made.md).

**What is built.** The foundation and the seal: clients, encryption, the event log, the PDF engine, the self-made seal. The signing core: envelopes,
recipients and order, links, every email, consent, signature adoption, the guided signer for all five field types, decline, cancel, expiry, reminders,
completion, delivery, the envelope screens, retention, and the rule that Claude acts only on the owner's word. The form path: the builder, versions,
conditional logic, uploads, agreements, more than one signer, the filler's one-question screens, the document made from the answers, and the screen
that reveals a private answer ([below](#the-form-path)). The PDF path: upload a client's own PDF, place fields on its pages for each signer, offer the
PDF's own fillable fields, send it (below). Not built: the items under "Not built, on purpose or for later". The built-in sample can be sent to an
operator's address and a second address, signed on a phone, and both get the sealed PDF.

**The gate before a client uses it.** The install's owner signs off on the consent text, the email texts, the privacy notice below and the terms:
no client uses the service before that. Its wording is built in for what the company's own use needs: the consent text and its versions, the typed
signature that starts blank and the typed-name-only mode, the email warnings and footer, the decline dialog, the privacy notice, the certificate's
agent line and printed consent, and the list of what not to send on the Send screen. A client agreement, and the wording that waits for a first
client, are the company's to settle, and an attorney's questions stand.

## The contracts the form path and the PDF path build on

They are in the signing core and neither path changes them without the other. Each path adds ONE line to each table, in a file of its own
for everything else.

| Contract | Where |
|---|---|
| **The prepared document** (a PDF, its pages as shown, its fields) and its checks | [`src/fields.ts`](src/fields.ts): `PreparedDocument`, `checkPrepared`; ADR 0001 |
| **The field catalog** (the five types, their default size, how each is filled) | [`src/fields.ts`](src/fields.ts): `FIELD_CATALOG`, `defaultBox`, `checkFieldValue` |
| **Where a draft's document comes from**, so Send does not know which | [`src/sources.ts`](src/sources.ts): one line per source in `SOURCES` (`sample`, `form` and `document`) |
| **The signing core** (the only writer of envelopes, recipients, values and events) | [`src/signing/index.ts`](src/signing/index.ts): `createEnvelope` takes a prepared document; `attachPrepared` is the form path's entry |
| **The API's route tables** | [`src/routes/index.ts`](src/routes/index.ts): `ADMIN_API` and `PUBLIC_API`, one line each |
| **The admin's navigation and screens** | in the space, not here (ADR [0007](../space/docs/adr/0007-forms-screens-are-the-space-s-own-page-and-forms-keeps-the-api.md)): [`packages/space/src/client/forms/routes.tsx`](../space/src/client/forms/routes.tsx), `NAV` and `ROUTES`; what Send offers is one entry per line in [`sendSources.tsx`](../space/src/client/forms/sendSources.tsx), each with an optional `Picker` that returns the rest of `source` and can set `sensitive`. This package keeps the API they call and the rules they share, which the space imports by path (the list is in that ADR, "What is imported from forms": a change to one of those files needs the space applied too) |
| **Page boxes and stamps** | [`src/pdf/geometry.ts`](src/pdf/geometry.ts) (fractions of the shown page) and the engine's `Stamp`; pages laid out from blocks: [`src/pdf/blocks.ts`](src/pdf/blocks.ts), which the form path uses for a form's pages |
| **Migrations** | `0001` to `0006` exist (`0003` is the typed-name-only column on `envelopes`; `0004` the conversation ref; `0005` the Client's number on `clients`; `0006` the two names an envelope was sent under). The next takes `0007` |

A prepared document's field names its recipient by POSITION (1 is the first), its page (zero-based) and a box as fractions of
the page as shown from its top-left corner. The signer's page draws pages with pdf.js and puts the fields over them in the
same fractions; the engine stamps them with the same fractions through the page's rotation and crop box.

## The form path

An operator builds a form, publishes a version, and sends it to a filler (the first signer) and the people who sign after them. The
filler answers one question per screen on their link, sees the document made from their answers and the agreement text, may change an
answer (which makes it again) until they sign, and signs; the others sign the same document. From `attachPrepared` on it is the signing
core as for any envelope. Its pieces, each its own module: [`src/forms/definition.ts`](src/forms/definition.ts) (the definition,
visibility, validation: pure, run by the Worker and both browsers), [`store.ts`](src/forms/store.ts) (forms and versions, audited),
[`filler.ts`](src/forms/filler.ts) (answers, uploads, "make the document", the operator's read of answers), [`source.ts`](src/forms/source.ts)
(`SOURCES.form`), [`src/pdf/formpages.ts`](src/pdf/formpages.ts) (the layout), [`src/routes/forms.ts`](src/routes/forms.ts), and the
screens (in the space: [`FormBuilder.tsx`](../space/src/client/forms/FormBuilder.tsx), [`FormPicker.tsx`](../space/src/client/forms/FormPicker.tsx),
[`Answers.tsx`](../space/src/client/forms/Answers.tsx); here, for the filler [`FormRunner.tsx`](src/public/FormRunner.tsx) and
[`Filler.tsx`](src/public/Filler.tsx)). ADR [0006](docs/adr/0006-form-answers-are-drafts-until-the-document-is-made.md) says why answers are
drafts and the log holds none.

| Route | |
|---|---|
| `GET/POST /admin/api/forms`, `GET /admin/api/forms/:id` | a client's forms (`?client=`), a new one with its blank draft, one with its versions and the definition to work on |
| `PUT /admin/api/forms/:id/draft` | the builder's save: the whole definition; starts the next version when the newest is published. What is wrong with it is said all at once (the same rules the builder shows) |
| `POST /admin/api/forms/:id/publish` | freezes the draft: its SHA-256, `published_at`, never changed again (the database refuses) |
| `GET /admin/api/form-versions/:id` | one published version's definition |
| `GET /admin/api/envelopes/:id/answers` | what the filler answered; a private answer's value is never returned here (it is decrypted only to work out which questions are shown; reveal is the core's `POST .../answers/:question/reveal`, an event) |
| `GET /admin/api/envelopes/:id/uploads/:upload` | an uploaded file, as a recorded download (`copy-downloaded` with the file's id and SHA-256, never its name: a timeline can be read with Claude's token) |
| `GET /api/s/:token/uploads`, `GET /api/s/:token/uploads/:upload` | the customer's files for the **client's copy addresses** only, on their own private link (the completion email gives it with a count, never the files or their names; a form that goes attached still gets the link in that one address's email). 90 days from completion like the finished document, this envelope's files only, each download a `copy-downloaded` event (recipient, upload id, SHA-256). Any other recipient's list is empty and their download refused |
| `GET /api/s/:token/form` | the filler's form: the pinned definition, their saved answers, whether they may still change them |
| `PUT /api/s/:token/answers/:question` | one answer, encrypted; empty clears it. A draft: no event |
| `POST /api/s/:token/uploads/:question`, `DELETE /api/s/:token/uploads/:upload` | a file as the request body (name in `x-file-name`), 10 MB, 10 per envelope, kind read from its bytes |
| `POST /api/s/:token/prepare` | the document is made: an `answered` event, then the core's `prepared` |

**Rules worth knowing before changing it**

- A form's roles are its signers in order; Send must name exactly those, in that order, as each signer's Role (Send refuses otherwise and says
  which). The role names print on the signature page; the recipient's own name is the printed name under it. A role's own lines (a PTIN) are
  text fields on its block.
- Every question belongs to the filler. A question is shown when its condition holds of earlier answers; hidden answers and their files are
  dropped when the document is made. A question's id is never reused (the definition carries `nextId`).
- **Once the document is made, any change to an answer or a file withdraws it** (`reopenPrepared` in the core: one batch, one `answered` event
  with `document_withdrawn`), so the filler cannot Finish a document their answers no longer say and no document lists a file that is gone. They
  make it again (`prepare`) after the change. A stored file is deleted only after the batch that removes its row has landed. Making the document
  is one batch with its `answered` and `prepared` events, held to the answers' version and to the log not having moved, so a lost race writes
  neither and drops nothing; it also moves every recipient's `values_version`, so a Finish that read the old document fails instead of signing it.
  Every change is refused once any signer has signed (in an all-at-once envelope another signer may be signing).
- A tax ID number (`tin`) is always private; any other question can be marked. A form with a private question makes the envelope sensitive, so
  the finished document goes to everyone by a private 90-day link.
- A published version is never edited: saving after a publish starts the next draft. A sent envelope keeps the version it was sent with.
- Text the document cannot print is refused at the question with a plain message (Chinese, Japanese and Korean by name, anything else by the
  character). The same check holds for everything an operator writes into a form. A tab is a space; an uploaded file's name has such
  characters replaced by underscores, so the document and the admin say one name.

- Saving an answer that is what is already saved, clearing one that is not there, an upload refused for want of a place and a removal of a file
  that is already gone change nothing and do not withdraw the document (the withdrawal carries the condition that the change takes effect,
  `whenSql` in `appendEvents`). Everything typed is normalised to NFC before it is checked and stored, so a letter typed as a base and a mark is
  one letter the font positions.
- A PATCH of a form draft's people meets the same checks as a send (`checkDraftSigners`). The hourly sweep does not remind a countersigner
  while the document is withdrawn; the filler, who has the work, is still reminded.
- A value for a PDF's own text field (PDF path) that the file's own font cannot show (Vietnamese, Greek or Cyrillic on the W-9's WinAnsi fonts)
  is written in the document font (`engine.ts`, `isWinAnsi`); any other keeps the field's own font, so the client's form looks as it always did.

**The document's font** is Noto Sans 2.015 (regular and bold; SIL Open Font License 1.1, [`OFL.txt`](src/pdf/fonts/OFL.txt)), subset to Latin
with its extended and Vietnamese letters, Greek, Cyrillic and common punctuation, embedded in the form's pages, the certificate and typed
stamps, and subset again per document so a PDF carries a few KB of it ([`font.ts`](src/pdf/font.ts)). The files, how they were subset and how the
two generated modules (the font as base64, and what it can draw as ranges, which the browser reads to refuse a character where it is typed)
are made are in [`src/pdf/fonts/README.md`](src/pdf/fonts/README.md); `test/font.test.ts` pins the file's hash, version and licence. The
Worker bundle grew from 2,373 KB (470 KB gzip) to 2,648 KB (616 KB gzip). The built-in sample still uses the standard font, which
is fine for its fixed English text.

**Not built, on purpose or for later**

- **Chinese text in answers is out of v1.** Before any client whose customers type Chinese uses it: a
  Chinese font loaded from R2 (subset per document), a Chinese signer page, and a check that LibPDF subsets a CJK font inside the Worker's
  limits (untested). A second font is a change in [`font.ts`](src/pdf/font.ts) and the coverage it generates.
- **No zip of the customer's files** on the copy link: they download one by one (a store-only zip needs a CRC and a writer of our own, and is
  not worth it for at most 10 files). Which recipients count as "the client's copy address" is read when the link is used: an address
  taken off the client's list later loses the link.
- **Public form links** a client puts on its own site wait on the owner's word and the email code.

**Hand test of the form path** (after a deploy that carries it)

1. Forms, a client, Build it: add a few questions, a condition, a private number, a file upload, an agreement and a second signer with a line
   of their own; the preview shows what a customer sees; Publish.
2. Send, A form, to the operator's own address and a second address in order. The email arrives; the link opens on a phone; consent; each question in turn; the
   upload takes a photo from the camera roll (a HEIC from an iPhone too).
3. The operator sees the document (the agreement word for word), taps Change an answer and sees it made again, signs. The second address signs the
   same document, fills the line, and both get a private link, not an attachment (the form has a private number).
4. On the envelope, Answers and uploaded files: the number is hidden until Reveal, which then shows on the timeline; the file downloads.
5. With one of the client's copy addresses set to an inbox he reads: its completion email names a count of files and has a link, no file or
   name in it; the page behind the link lists the file and downloads it, and the download shows on the envelope's timeline.

## Who gets in

The admin lives in the space and signs in there: a month for the space and a day for Forms. The Access application for it is
the space's host at `/forms` (declared by the install kit and imported by this package's instance); this
package makes none of its own. Why it is built that way: [the space's ADR 0002](../space/docs/adr/0002-forms-is-a-frame-on-its-own-admin-with-a-day-long-sign-in-of-its-own.md).
What this package does about it, and neither door is enough alone:

1. The space checks the Forms application's assertion (against the Forms audience, on `/forms`) and hands this app the admin's API calls and logos in-process, as the person it named.
2. **When this app is asked without that person** (a local run, a test) it verifies every `/admin/api` request's assertion with the company layer's `identify`
   ([`packages/workspace`](../workspace/CONTEXT.md): signature, issuer, the Forms application's audience `CF_ACCESS_AUD`, expiry, from the header alone) and looks the sign-in
   address up as a person of the install it was built with ([`src/workspace.ts`](src/workspace.ts)), refusing anyone else,
   including a person of another company whose assertion Cloudflare signed. A service token is not an operator. No audience
   configured: everyone refused. The same install gives the notice address (its first owner). The build bundles the package's default declaration (the invented Northfield Works install); `FORMS_DECLARATION=<file> bun run build` bundles another
   company's (the end-to-end suite runs both ways). A deploy's build must name its declaration itself, so a stray export cannot reach production.

**Forms runs in the space's Worker (the space's ADR 0015), and nowhere else.** The space bundles this package's whole app (`packages/space/src/parts.ts`): its operator API is answered there
for the person the space's one sign-in check named (`Deps.named` in `src/http.ts`, and the app asks nothing else when it is given), over this package's database and bucket bound by name; the signers' side (`/s/api/...`, the logo) is answered on the space's open `/s/` path, the signer's page is the space's guest bundle
built from this package's `index.html` and `src/public/` (`packages/space/vite.guest-forms.config.ts`), and the hourly sweep and the database's migrations are the space's (`packages/space/wrangler.jsonc`, the `space` instance). There is no forms Worker, instance or address,
so a change here reaches a live site only when the space is applied (`bunx @zabaca/zbc apply <env> space`, by hand); CI says so (`space-apply-warning`) and deploys nothing for forms.

**The local Worker (`dev/`).** `dev/worker.ts`, `dev/wrangler.jsonc` and `dev/vite.config.ts` are forms by itself in workerd, over a local D1 and R2, for `bun run dev` and the end-to-end suites (`e2e/server.ts`; the space's e2e starts this Worker beside the space's). They are NOT deployed, have no route or address and no cron, and
`test/dev-worker.test.ts` pins that. `bun run dev` makes `.dev.vars` the way `bun run seal-certs --dev` shows.

**A migration must leave the code that is live working.** The space bundles all of this package's code and is applied by hand, and its apply migrates the database before it deploys. So between a merge and the space's next apply the live copy runs against a database a newer migration may already have changed (the migration is applied by
the apply that deploys the new code, but a failed deploy leaves the migration in and the old code live): **a migration must leave the previous code working** (add a column or a table, never rename, drop or tighten one in the same change that stops using it; do the contraction in a later push, after the space has been applied).

**The space's reads.** `createSpaceForms` (`src/space-reads.ts`) is what the space calls, in-process, for Today, People and a conversation:
`documents`, `documentsOn` and `documentsIn`, title and state and the names of the signers who have not signed, never an answer, an address, a link or
a file. Each takes the person the space's check named (`SignedIn`) as its first argument and applies this package's rule (an operator, a person of THIS install). The shapes are the company layer's
(`packages/workspace/src/forms-for-space.ts`).

**There is no admin page and no `/admin` redirect.** The admin's screens are the space's Forms tab, so this app has none: `/admin/api/*` is the operator API (refused without the Forms assertion), and a read of any other `/admin` path is the router's plain 404.

**What outsiders use** is the signer's page and API under the space's open `/s/` path: the landing page and the privacy notice (the guest bundle's `/s/...` pages), a client's logo (`/s/api/logo/<id>`, which emails load) and the signer's API (`/s/api/s/<token>/...`), which authenticate every request with the
recipient's token. The public API sits behind a rate limit (the `PUBLIC_LIMIT` binding).

**The admin's files.** There are none here: the screens are bundled into the space (the space's build copies pdf.js's WASM with the plugin in
[`pdfjs-wasm.ts`](pdfjs-wasm.ts), which both builds use, and imports `PdfPages` and `FormRunner` from here). What forms builds is the signer's
page alone: `index.html` and `src/public/`.

## What it does

| Route | |
|---|---|
| `/admin/` | no page: the screens are the space's Forms tab (Clients, a client, Envelopes, an envelope, Send, Forms, Documents, Seal, History) |
| `GET/POST /admin/api/clients`, `GET/PATCH /admin/api/clients/:id` | clients; every write has its audit row in the same batch |
| `PUT /admin/api/clients/:id/logo` | PNG or JPEG body up to 256 KB, checked by its first bytes |
| `GET /admin/api/clients/:id/sample.pdf` | the sealed sample, made on the spot |
| `GET /admin/api/seal` | which certificate, until when, the root's fingerprint |
| `POST /admin/api/seal-check` | the whole PDF chain on a file (the body) or a synthetic scan; `?report=1`, `?stage=prepare\|finish`, `?mb=` |
| `POST /admin/api/storage-check` | a throwaway object under a fresh key, read back, refused without it |
| `POST /admin/api/inspect` | what a PDF is, without sealing it. A password for the file goes in an `x-pdf-password` header (a query string would be logged); the Worker reads at most 30 MB of body, chunked or not |
| `GET /admin/api/audit` | operator changes, newest first |
| `GET /admin/api/envelopes?client=&status=` | every sending, newest first, with how many signers have signed |
| `POST /admin/api/envelopes` | a draft from `source.type` (a builder in [`src/sources.ts`](src/sources.ts)) and the people, order, note, expiry and reminders; nothing is sent |
| `GET /admin/api/envelopes/:id` | recipients, the timeline with its chain checked, mail, Claude's instructions |
| `PATCH /admin/api/envelopes/:id` | edit a draft (title, order, note, expiry, reminders, recipients) |
| `GET /admin/api/envelopes/:id/preview-email` | the request email as its first signer will get it |
| `POST /admin/api/envelopes/:id/send`, `/remind`, `/cancel`, `/recipients/:rid/correct` | each one guarded batch and one event; an agent needs an instruction (below) |
| `GET /admin/api/envelopes/:id/finished.pdf`, `/certificate` | the sealed document (a recorded download) and the certificate as data |
| `POST /admin/api/envelopes/:id/purge`, `/answers/:question/reveal` | delete early (audited), reveal a sensitive answer (an event); operators only |
| `POST /admin/api/documents?client=` | the PDF path: an upload (the PDF is the body; `x-file-name`, `x-pdf-password` and `x-confirm` are headers). Refused with a code the screen acts on: `password-needed`, `wrong-password`, `confirm` (a restricted file, or one with an earlier signature), and the engine's own refusals |
| `GET /admin/api/documents?client=` | `{ documents, limits }`: a client's uploads and the engine's limits |
| `GET /admin/api/documents/:id`, `/pdf` | one with its inspection, placed fields and what the PDF's own fields offer; its working copy for the page viewer |
| `PUT /admin/api/documents/:id/fields`, `PATCH`, `DELETE /admin/api/documents/:id` | place the fields (the whole set), rename, delete (refused while an envelope points at it); each is one batch with its audit row |
| `GET /api/logo/:id` | a client's logo (public) |
| `GET /api/s/:token` | what a recipient's link shows now; changes nothing |
| `POST /api/s/:token/open`, `/consent`, `/adopt`, `/finish`, `/decline`, `PUT /api/s/:token/fields/:field` | the signer's steps; every request carries the token and nothing else |
| `GET /api/s/:token/sample.pdf`, `/terms.pdf` | the consent step's two PDFs: the sample the signer opens (an opening at that step is a `consent-sample-opened` event), and the consent text of the current version to save |
| `GET /api/s/:token/document`, `/download`, `/certificate`, `/me/:kind`, `/picture/:recipient/:kind` | the document to sign (each showing is an event), the finished one (each download is an event, 90 days), the certificate, pictures |

The pieces, each one module: [`src/signing/`](src/signing) (the signing core; start at its `index.ts`),
[`src/pdf/`](src/pdf) (the engine, [geometry](src/pdf/geometry.ts), [blocks](src/pdf/blocks.ts), the
[certificate](src/pdf/certificate.ts), the [sample](src/pdf/sample.ts)), [`src/seal/`](src/seal) (the sealer),
[`src/vault.ts`](src/vault.ts) (per-envelope keys), [`src/events.ts`](src/events.ts) (the hash-chained log),
[`src/mail.ts`](src/mail.ts) (the templates and the mail binding), [`src/records.ts`](src/records.ts) and
[`src/store.ts`](src/store.ts) (D1; audited writes), [`src/scheduled.ts`](src/scheduled.ts) (the hourly sweep),
[`migrations/`](migrations) (every table). The signer's page is [`src/public/Signer.tsx`](src/public/Signer.tsx).

## Data rules

- **An event is never changed, and is deleted only after its envelope's tombstone exists.** The database enforces it
  (triggers); `src/events.ts` appends events in the same batch as the change they record, in a SHA-256 chain, retrying a
  sequence collision. An event can only be appended at the end of its chain (the next sequence number, the last event's hash
  as its previous hash, its envelope's client); `INSERT OR REPLACE` cannot swap one, and a tombstone, once written, cannot be
  changed, replaced or removed. The hash covers every field, the client's id included. A finishing write names the status it
  expects (`whenStatus`, and `whenRecipient` for one signer's own state), so two finishers racing for one envelope write one
  `completed` event, and every other statement of the change is conditioned on that event having been written (ADR 0005). A
  published form version is frozen the same way.
- **Answers, field values and tokens are stored encrypted** with the envelope's own key; R2 objects with SSE-C. Names and
  email addresses stay readable. A logo is public and plain.
- **A client's name is checked as a mail display name** ([`src/clients.ts`](src/clients.ts)): no control characters and none of
  `< > " \ , ; : @ ( )`. An apostrophe is allowed (this app passes Cloudflare a name and an
  address separately, never a composed header).
- **D1 refuses a LIKE or GLOB pattern over 50 bytes**, which bun:sqlite does not; a test pins every migration pattern.
- **Retention:** finished records 7 years unless the client says otherwise; unfinished envelopes (declined, cancelled,
  expired, an idle draft) 90 days after they stop; a finished document holding a sensitive answer is delivered by a private
  90-day link, every download logged, and any other is attached (up to 15 MB). The hourly sweep purges only what is due (re-checked before anything is deleted, and again inside the batch, so a draft sent at
  the top of the hour is left alone): R2 objects first, then the rows and the wrapped key in one batch, leaving a tombstone. A purge writes no `purged` event, because the events go in the
  same batch; the tombstone is the record. The numbers are in [`src/settings.ts`](src/settings.ts).
- **An uploaded document is kept until an operator deletes it** (the Documents screen): the original as received and its working copy,
  encrypted under a key of the document's own, which goes with the row. Nothing deletes it by time, and it cannot be deleted while an
  envelope made from it exists (the certificate names the original by hash). The envelope keeps its own copy of the prepared document,
  so the retention above covers what was sent; the upload is the client's file waiting to be sent again, so **purging an envelope leaves
  the uploaded original in place** (ADR 0004). A retention rule for uploads is not decided.
- **Claude may send, remind, cancel and correct a recipient only on the owner's explicit word.** The rule is in the core
  ([`src/signing/instructions.ts`](src/signing/instructions.ts)): an agent's action is refused unless it names a recorded
  instruction for that envelope and that action, unused, whose draft fingerprint still matches (a send), and Claude's sending
  switch is on (`settings.agent_sending`, off by default, changed only by an operator). A refusal changes nothing and emails
  nobody. The event records the agent, the instruction's id and its SHA-256, and `on_word_of`; the owner's words stay in the
  instruction row, which is Claude's own account and not proof. An agent can never reveal an answer, download a document,
  purge, or turn its own switch on (`requireOperator`). The door Claude comes through (a service token) is not built; today
  every admin request is an operator's.
- **No mail leaves without its row.** A message is recorded `pending` in the same batch as the change that causes it, then sent
  and marked `sent` or `failed` with the reason; a request that stops in between leaves a pending row the sweep sends after five
  minutes (three tries). A sent message is a `mailed` event.
- **Links.** The token is 256 bits in the path, stored as its hash (and encrypted, so a reminder resends the same link). A link
  that leads nowhere answers one message. "Opened" is recorded when the page's script calls the API. Expiry holds the moment its
  time passes, whether or not the sweep has run. Pages under a link send no referrer and may load nothing from another site
  ([`public/_headers`](public/_headers); unverified in production until the first deploy, see below).

## Develop

```sh
bun install
bun run seal-certs --dev   # a throwaway master key and seal into .dev.vars (also: ALLOW_UNAUTHENTICATED=1)
bun run dev                # applies the migration to local D1, then vite on :4836
bun run test               # routes, vault, events, engine over the fixtures, certificates, the seal-certs command
bun run test:e2e           # the real Worker in workerd (production bundle, vite preview): the spike, the app, the event log in real D1, a browser signing, the signer's side of the PDF path and the form path to a sealed PDF (each file starts its own server on a free port). The operator's screens are tested in the space: packages/space/e2e
bun run typecheck
```

`bun run test` needs poppler (`pdfsig`, `pdftoppm`) for the tests that look at a PDF, and `sops` and `age-keygen` for the
seal-certs command's test. Where a tool is missing those tests skip; in CI (`CI` set) a missing tool is a failing test, and
the workflow's steps fail first, so nothing is skipped silently. `.fixtures/` is built on demand by
`bun run fixtures` (only the public-domain IRS W-9 is committed). `bun run test:e2e` clears the local D1 and R2 state
(`.wrangler/state`) so the migration under test is the one on disk. The browser tests need Playwright's Chromium or an installed Chrome.

No test or local run sends a real email, spends money or reaches Cloudflare. The bun tests fake the mail binding; workerd's local
`send_email` binding writes each message to `.wrangler/tmp/email`, which is how the browser test reads a signer's link. The
browser test (`e2e/signer.test.ts`) needs Playwright's Chromium or an installed Chrome; `FORMS_SHOTS=<dir>` also saves the
screens it passes through.

**How the e2e suite stays reliable** (so a failure in it is a finding, not noise). Each test file starts its own server, on a free
port checked on both address families (`FORMS_E2E_PORT_<APP|SPIKE|EVENTS|SIGNER|DOCS|FORMS>` pins one for debugging), and
waits for that server to be gone before the next file starts, because every server shares `.wrangler/state` and `.dev.vars`. The
browser is Playwright's out-of-process mode with its driver run by Node (`e2e/browser.ts`, so Node must be on the PATH). Driven from
inside Bun, Playwright's pipe to Chrome (`--remote-debugging-pipe`, Chrome's fds 3 and 4) died now and then for good: Chrome idle,
Bun idle, and Bun no longer holding the peer of Chrome's fd 4 (`lsof` during a hang, bun 1.3.14, Playwright 1.61). Playwright got no
reply and no close event, so a step waited out its 30 s on an element that was on the page, every later call hung, and bun's timeout
then killed the server too (about one full run in three). Playwright's WebSocket route is not an option from Bun: its `http.request`
never fires `upgrade`. Each test's browser contexts are closed after it, and a call into the browser that does not answer fails in
20 s with that as its message instead of waiting. Do not add retries: a test that needs one is showing a race in the product or in
the test.

## Secrets (in the install's encrypted secrets file, made by [`scripts/seal-certs.ts`](scripts/seal-certs.ts), never printed)

| Key | What | Goes to the Worker |
|---|---|---|
| `FORMS_DATA_KEY` | the vault's master key, base64, 32 bytes | yes |
| `FORMS_SEAL_KEY` | the seal certificate's private key | yes |
| `FORMS_SEAL_CERT_CHAIN` | the seal certificate, then the root's (public) | yes |
| `FORMS_SEAL_ROOT_KEY` | the root's private key | **no**, the secrets file only |

`--status` shows dates and presence without a value; `--renew` issues a new seal certificate before the current one ends (3
years); `--production` refuses to run twice.

An install's own seal (for example a client company's space in its own account) is made with `SPACE_DECLARATION=<its workspace.json> bun scripts/seal-certs.ts --production` (its secrets file is `SPACE_SECRETS`, else the `secrets.yaml` beside the declaration; `FORMS_DECLARATION` and `FORMS_SOPS_FILE` name the two directly): the certificates are
named for that install's signing service ("<service name> Root" and "<service name> Seal") and carry who runs it as their organisation, and the keys go into that environment's file. With neither variable the script uses the default production secrets file and names the certificates for
the bundled install; it refuses one of the two without the other. `--renew` needs only `FORMS_SOPS_FILE`: it takes the seal's names from the root certificate in that file, so a renewal cannot rename a seal.

## Deploy

Forms is deployed with the space: `bunx @zabaca/zbc apply <env> space`, by hand (CI deploys nothing of forms). The `space` instance creates `forms-records` and `forms-files` if missing (never deletes either), applies `migrations/`
before it deploys, applies the imported Forms Access application (`space-forms-access`, on the space's host at `/forms`, for the install's people), deploys with `CF_ACCESS_AUD_FORMS` set to its audience, and pushes the three Worker secrets. A deploy proves none of the checks below: a person runs those.

### After the first deploy (a person with a browser and a terminal)

1. **Access** (the Forms application on the space): the checks that the admin loads and signs in are in the space package's README. If the admin loads but every call is 401, the audience tag the Worker was
   deployed with is not the Forms application's.
2. With no sign-in (curl), from outside: `https://<space-host>/forms/api/me` answers Access's redirect, not data; `https://<space-host>/s/api/logo/x` is a plain 404; `https://<space-host>/s/api/nothing` is a JSON 404; the `workers.dev` name does not answer (there is none).
3. **Seal screen**: the certificate's subject and 1,095 days; the root fingerprint matches `bun packages/forms/scripts/seal-certs.ts --status`.
4. **Storage check** must say the bucket keeps files only under their key (local R2 cannot show this). Do not send anything until it does.
5. **Seal check**, then read its CPU time in Workers Logs. It builds and seals a 19 MB scan in one request and is the proof
   the 128 MB memory limit holds; if it ends with error 1102, lower `LIMITS.maxBytes` (15 MB) or run `?mb=12`, and say so.
6. Set up signing for a Client with a logo, download its sealed sample and open it in **Adobe Reader**: "Signed by <service name> Seal, validity
   unknown", "document has not been modified since this signature was applied". Change one byte of a copy and Acrobat reports
   the change. Check it also opens in Preview and on an iPhone.
7. DNS: nothing of forms' own; the space's host is the space's Custom Domain (the install kit's Worker settings).
8. A request to `/admin/api/me` carrying only the `CF_Authorization` cookie, with no `Cf-Access-Jwt-Assertion` header, is refused (401): the company layer reads the header alone.

## Where it breaks

- **Access on a path of the space**: the Forms application and the space's own are two applications on one host. If a request to
  `<space-host>/forms/...` is answered without a sign-in, or the API is 401 after signing in, check both applications in Zero Trust
  and which audience each Worker was deployed with (the space package's README, on the two sign-ins disagreeing). The admin's page is
  public only to someone who can already read `/assets/`; the Worker's own check still refuses the API.
- **Memory on a large scan**: the finishing path holds about four copies of the file (ADR 0002). Error 1102 in Workers Logs
  means lower the cap, or give the engine a Container.
- **LibPDF is at 0.5 and its `getMediaBox()`/`getCropBox()`/`page.width` are wrong off the origin** (ADR 0002); the engine reads
  boxes itself. Anything new that needs a page size must use `readBox` and `src/pdf/geometry.ts`.
- **Sealing changes the file**: a working copy is saved whole, so an earlier signature in an uploaded PDF reads as changed in
  a reader; the inspection counts them so the operator is told.
- **A new seal certificate** that is not pushed (`zbc apply` after `--renew`) leaves the old one signing until it expires, and
  then every seal fails. The Seal screen warns 90 days ahead.
- **A lost `FORMS_DATA_KEY`** loses every stored record. It is in the secrets file; do not regenerate it (`--production` refuses).
- **R2 customer keys** are untested until production (ADR 0004).
- **Email**: the first live sends are unwatched. Look at: Gmail Inbox vs Promotions; the account's unpublished daily quota;
  whether `allowed_sender_addresses` applies to structured sends (the local binding accepts them; production is the test);
  whether the sender address receives mail (replies go to the client, not here); and the sending domain's DMARC policy (`p=none` only
  reports). A
  refusal is recorded on the envelope's Mail card with its reason and retried by the sweep.
- **A stuck envelope**: one that has been `sealing` for 10 minutes is sealed again by the sweep, up to 5 tries, then the operator
  is told once and the sweep stops; it is deleted after 90 days like any unfinished envelope. Read Workers Logs for `sealing <id> failed`.
- **The finishing path's memory** is the same as ever (above): completion holds the prepared document, every stamp's picture, the
  certificate and the sealed result, so the 20 MB cap and the 128 MB isolate are the limit to watch. `LIMITS.maxBytes` in
  [`src/pdf/engine.ts`](src/pdf/engine.ts) is the one place the cap lives.
- **Browsers**: the signer's page and the space's page viewer use pdf.js's legacy build for older phones. pdf.js decodes JPEG 2000,
  JBIG2 and CCITT fax images (what copiers and legacy systems write) and reads ICC colour profiles with WASM files, so
  [`pdfjs-wasm.ts`](pdfjs-wasm.ts) (used by this package's build and the space's) copies them from the pinned pdfjs-dist into `/assets/pdfjs-wasm/` at build time (with their
  licences, and the JavaScript twin of each decoder for a phone that will not run WASM, such as one in iOS Lockdown Mode) and both pages
  pass that as `wasmUrl`. They run in pdf.js's own worker, which carries no page CSP, so the signer's CSP is unchanged; nothing is loaded
  from another site. `e2e/documents.test.ts` draws each kind in a browser, and the JavaScript twin with the WASM blocked. An upload is
  never refused for its images. The decoders are large (OpenJPEG's JavaScript twin is 446 KB) but load only when a page holds such an
  image.
- **A PDF's own text field with a character limit** (`/MaxLen`, the W-9's Social Security boxes) is not offered to fill in place: LibPDF
  cuts a value to the limit without a word, so the PDF would hold less than the signer typed and the signed event hashed. The
  operator is told, and places a text field over it instead. The engine's field description carries the limit (`maxLength`).
- **A PDF's own fields are written into, so their look is the file's, with three corrections.** A text answer is sized to fit its field
  whatever font size the file fixes (LibPDF would clip it at the edge); a checkbox the signer leaves alone is written unticked, so a box
  already ticked in the file does not stay ticked in the seal; a field the file hides (Hidden or NoView) or puts wholly or partly off the
  page is not offered. A field the file shows in several places gets the answer in each, and the screen says so. `test/document-fields.test.ts`
  checks all of these as pixels, because clipped text still extracts whole.
- **Fields placed for a document are numbered signers**, 1 to 4, in the order Send names them. The picker says how many; naming a
  different number is refused with the numbers in the message. The Send screen offers four signers.
- **Dates are written "Oct 31, 2026"** in every finished document. A client has no date-format setting yet, so one that wants
  another cannot have it; the date itself is the client's own calendar day (its time zone).
- **Reminders and expiry** are decided in code from the hourly cron, in each client's own time zone and hours (9:00 up to 17:00).
  A client whose time zone is wrong gets reminders at the wrong hour.

## Hand test of the signing core

1. The sample, sent to the operator's address and a second address, in order (a client's page, Send the sample).
2. Sign on a phone: consent, signature, initials, a line, a checkbox, Finish.
3. The email is in Gmail's Inbox, not Promotions or Spam, reads "<client name> via <service name>", and replying reaches the client.
4. The finished PDF opens in Acrobat Reader with "document has not been modified" and the signer's validity unknown; one byte
   changed in a copy shows the change.
5. `/s/<token>` answers with the Referrer-Policy and Content-Security-Policy headers from `public/_headers`, and the signer's
   page loads nothing from another site (browser developer tools, Network).
6. The first hourly run in Workers Logs reads `[cron] sweep: ...`.

## Hand test of the PDF path

1. Documents: pick a client, upload a real PDF of theirs (the IRS W-9 is a good one), see its pages and the dashed boxes where the
   file has its own fields.
2. Place a signature and a date for one signer, tap a dashed field to use it, drag a box, resize it with its corner; Save.
3. Send, choosing "A client's PDF", to the operator's address; on a phone the page shows the same boxes where they were put; sign; open the finished
   PDF: the signature is inside the box, the file's own fields hold what was typed once each, and Acrobat says "document has not been
   modified".
4. A scan from a copier (CCITT or JBIG2) and a PDF with JPEG 2000 images, if there are any: upload, place a signature, send, and on the iPhone
   the scan's pages show, not blanks.
5. The largest real file there is (a scan near 20 MB): the upload must finish, and Workers Logs must show no error 1102 (out of memory). In
   local workerd the 19 MB scan grew the process by 65 MB on upload against 52 MB for the prepare stage, which is not a proof
   of 128 MB; if it fails, lower `LIMITS.maxBytes` (ADR 0002).
6. A turned or oddly cropped PDF if there is one: the box lands where it was put (tested on rotations and crop boxes that do not start
   at zero, so this is a spot check).

## Conversation refs (migration 0004)

Migration `0004_conversation.sql` adds two nullable columns to `envelopes`, `conversation_app` (`inbox` or `meet`) and `conversation_id`, held both-or-none by the schema, and an index. They are the conversation ref of the space conversation an envelope was sent from (`ConversationRef`, `packages/workspace/src/forms-for-space.ts`); both are null for every envelope made before it and for every one sent from Forms' own Send. Set once when the draft is made (`POST /admin/api/envelopes` takes `conversation: { app, id }`, refused with a 400 when it is not an app and an id) and never changed (a draft edit does not take it). **It is written into no event**: every event is sealed into the PDF each signer receives, so the finished document and its certificate never carry it (tested). The operator's envelope list and view carry the two columns; `documentsIn` (in `createSpaceForms`, called in-process by the space's Worker) finds envelopes by the refs it is given, and every summary names its `conversation` (`src/space-reads.ts`; still title, state, counts and names, never what a document holds).

The migration is additive (no row is touched; nothing reads the columns until the new code is deployed), so it applies before the code that reads it deploys (see "A migration must leave the code that is live working" above).

## The privacy notice

[`src/public/service-pages.tsx`](src/public/service-pages.tsx) holds the notice and the landing page (`src/public/main.tsx` mounts them), public at `/privacy`. Where the install's declaration sets `formsService.ownCompanyOnly` (Forms sends only for the company itself) the notice and the landing page read as the company using its own service and name no second party; every other install gets the sentences below as they are. It states only what the service does today and is
part of the gate (the owner's word). Its contact is the install's (`formsService.contact` of the declaration; its names are in `src/service.ts`);
the sender address sends mail but receives none.

**The notice's Claude section must change when an agent door is built.** Today no agent door exists (the sign-in check refuses a service token and
every admin request is an operator's), so the notice says Claude has no access, describes what it would see if the company later lets it
send, remind, cancel or correct an address on the owner's recorded instruction, and states as the company's own policy, not a technical claim,
that Claude is not let read answers, uploads, private numbers or finished documents. The `FORMS_DATA_KEY` kept in the encrypted secrets file is why that last
part is a policy: a Claude session that can decrypt that file could read anything the service stores. When the door is built, it must see
only what the notice lists (the envelope, client, form and document reads carry no refusal for an agent today, so the door adds it), and the
notice is rewritten in the same change.
