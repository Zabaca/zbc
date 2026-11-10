# forms glossary

A signing service for the clients of the company that runs the install, run inside the space's Worker (signers use the space's host under `/s/`, for example `space.northfield.example/s/`). A client's documents are branded as that
client, sent "via <service name>" (the install's name for the service), and sealed. The company operates it; no client logs in. (An install that declares `formsService.ownCompanyOnly`, as a company running Forms for itself does, says no "via" and names no second party anywhere.) Not legal advice and not a
replacement for an attorney's reading of what a client's document says.

- **Client (business)**: a business the company serves, whose name and logo a document carries. Not a person. It is a **Client of the space** (one list, made and edited in Settings;
  `packages/clients`), and a row of Forms' `clients` table is that Client's **signing settings**: short name, reply address, copies, colour, logo, time zone, years kept. The row keeps its text id for good (every table a client owns
  carries it, every event's hash includes it, every signing email loads the logo by it) and carries the Client's number (`client_number`, migration 0005, unique). Its name and legal name are Forms' **copy** of the Client's: written only by the
  Clients part (`src/client-names.ts`), never by a request body. A row with no number was made before the Clients part and is "not linked to a Client": it signs as it always did and is linked by hand.
  The Clients list is read only by the install's owner (`Operator.owner`): the routes that read it (Clients without signing settings, Set up signing, Link) refuse any other operator, and a row's `client_archived` is null for one.
- **Names an envelope was sent under**: the row's name and legal name as they were when the envelope was sent (`client_display_name`, `client_legal_name`, migration 0006), written by send in the same batch and by nothing else, and in no event.
  The consent a signer is shown, its terms PDF and the certificate of completion (on the web and in the sealed PDF) print these, so a rename of the business afterwards changes nothing already shown or sealed. An envelope sent before the
  migration has none and prints the row as it is now; its certificate's consent note then says the business was renamed since a signer agreed (`printedAs`, `src/signing/support.ts`). Emails, reminders and the admin's lists keep reading
  the row as it is.
- **Operator**: a person of the company's install who signs in through the space's Forms tab (the space's host under `/forms`) to build and send. Declared once for
  all three apps in the company layer (`packages/workspace`; each install's declaration is its `workspace.json`),
  which also gives the Access list. The company is not a Client (business): the company runs forms; a client is a business it
  sends documents for.
- **Form**: questions a client's customer answers, published in versions. A sent form is pinned to one version, and a
  published version never changes (the database refuses it).
- **Source document**: a PDF uploaded to be signed, kept as received beside its working copy, with the fields placed on it for up to
  four signers (numbered in the order Send names them). The admin's screen for them is Documents and Send offers one as "A client's PDF";
  those are the same thing. Sent as many times as wanted, each sending an envelope with its own copy; kept until an operator deletes it.
- **Own field**: a fillable field the uploaded PDF already has (text, checkbox or signature). It can be given to a signer in place: its
  page and box are the file's, and the signer's answer is written into it (into every place the file shows it). A date can fill a text
  field. Radio buttons, dropdowns, read-only, hidden and off-page fields, and text fields with a character limit, are left as the file has
  them. The code and the API call the offered ones `own_fields` and the rest `left_as_is`.
- **Working copy**: the source document with its password and change restrictions removed and any XFA dropped. Every
  later step reads it. Saved whole, so an earlier signature in it reads as changed.
- **Envelope**: one sending of a form or a source document to its recipients, from draft to completed, declined,
  cancelled or expired.
- **Conversation ref (of an envelope)**: the conversation in the space an envelope was sent from, as `{ app: 'inbox' | 'meet', id }` (`ConversationRef`; migration 0004's two columns, both null for one sent from Forms' own Send). Set once when the draft is made and never changed, and written into no event (every event is sealed into the PDF a signer receives). The space
  shows the document as a card in that conversation and nowhere else (`documentsIn` of `createSpaceForms`, which the space's Worker calls in-process); nothing is emailed into the conversation, since forms emails the signed copy to every party itself.
- **Recipient**: a person in an envelope: a signer (has fields), or a copy recipient (receives the finished document).
  Reached by a private link carrying a random 256-bit token, looked up by its hash.
- **Filler**: the first signer of a form envelope, who answers its questions.
- **Form definition**: a form's whole content as data (`src/forms/definition.ts`): its title, signer roles and questions. A published
  version of it is frozen with its SHA-256; an envelope is pinned to one.
- **Question**: one thing a form asks, of one of fourteen types (short and long text, email, phone, number, date, single and multiple
  choice, dropdown, yes or no, file upload, tax ID number, a statement to read, an agreement with an "I agree" box). Has an id that is
  never reused, may be required, may be marked private, and may carry a condition.
- **Condition**: a test on EARLIER answers (is, is not, contains, answered, greater, less; all or any) that decides whether a question is
  shown. Looks back only, so a form cannot loop.
- **Role**: a signer's place in a form (Client, CPA), in order. The first is the filler. Each has a block on the signature page with a
  signature, a date, the person's printed name and any lines of its own (a PTIN).
- **Private question**: a tax ID number, or any question the operator marks. Its answer is hidden in the admin until an operator reveals
  it (an event), and a document that holds one is delivered by private link.
- **Answer**: what the filler gave for a question, stored encrypted as a draft until the document is made (ADR 0006).
- **Withdrawn document**: the prepared document of a form envelope after its filler changed an answer or a file: gone in the same batch as the
  change (`reopenPrepared`), so it cannot be shown or signed, until the form makes it again.
- **Prepared document**: the fixed PDF a signer is asked to sign, with each signer's fields on it. Both ways of
  authoring end in one (ADR 0001). Its SHA-256 is recorded at every step.
- **Field**: a place on a prepared document that one signer fills: signature, initials, date, text, checkbox. Its box is
  stored as fractions of the page AS SHOWN, from the top-left corner, so it does not depend on how a file stores rotation
  or crop.
- **Shown page**: a page as a reader displays it: the crop box clipped to the media box, turned by `/Rotate`. Field boxes
  and stamps are in shown space; `src/pdf/geometry.ts` is the one place that converts to the file's own coordinates.
- **Event**: one entry in an envelope's log, chained to the one before by SHA-256. The database refuses to update one, and
  to delete one until its envelope has a tombstone.
- **Chain's last link**: the hash of an envelope's last event as of sealing (the `sealing` event: the `completed` event records
  the finished document's hash, so it cannot be inside the document). Printed in the sealed PDF every party holds, so a
  rewrite of the log would disagree with every copy. A tombstone keeps the chain's final hash, which is later in the same chain.
- **Seal**: the digital signature (PAdES, `ETSI.CAdES.detached`) the service puts on the finished PDF, which shows any
  later change. Today made with a certificate the install made itself.
- **Seal root**: "<service name> Root", the self-made certificate authority that issues the seal certificate. Its key is kept
  encrypted in the install's secrets file only. Adobe shows the seal's validity as unknown because the root is on no trust list.
- **Seal certificate**: the certificate whose key signs the seals: 3 years, a Worker secret, renewed under the same root
  (`scripts/seal-certs.ts --renew`).
- **Certificate of completion**: the pages added to the finished document listing the recipients, their consent and
  signing, the events and the chain's last link. Not to be confused with the seal certificate.
- **Vault**: the module that gives each envelope its own data key, wrapped by the master key (`FORMS_DATA_KEY`), and
  encrypts values and files with it. Deleting an envelope's wrapped key is what ends access to any copy, backups included.
- **Tombstone**: what stays of a purged envelope: its id, client, title, completion time, the finished document's hash and
  the chain's last hash.
- **Seal check**: the operator-only run of the whole PDF chain on a file, or on a synthetic 19 MB scan, reporting what it
  did. The first deploy's proof that the Worker can seal the largest file it accepts.
- **Engine**: `src/pdf/`, the only code that touches LibPDF. It is the seam where a Cloudflare Container would replace the
  Worker if the Worker ever could not carry a file.
- **Signing core**: `src/signing/`, the only writer of envelopes, recipients, field values and events. It takes a prepared
  document and knows nothing about forms or uploads, with two exceptions: purge deletes the uploads, and the completion email counts them for a client copy address. Every state change is one batch with one event, every statement in it
  conditioned on that event having been written (ADR 0005).
- **Source**: where a draft's document comes from (`src/sources.ts`): the built-in sample, later a form version or an
  uploaded PDF. Not to be confused with a source document, which is an uploaded PDF.
- **Sample**: the built-in document Send can send: a branded page with a block of all five field types per signer, carrying no
  agreement. It is its own source document, owned by the envelope it is made for and deleted with it.
- **Copy recipient**: someone who gets the finished document and signs nothing. The client's copy addresses are added to every
  envelope as copy recipients, so a sensitive document reaches them by their own private link too. On a form envelope that link also lists
  the files the customer uploaded (only for these addresses, 90 days, each download an event; the email gives a count, never the files).
- **Consent**: what a signer agrees to before anything else (`src/consent.ts`): to sign this document electronically, how to get
  paper, how to withdraw after as well as before signing, how to update an email address, what a device needs, how the finished copy
  arrives, and a sample PDF the signer opens to show the device can. Versioned, and an old version's words stay in the code: the event
  records the version and the hash of the exact text shown, and the certificate prints the full text of each version a signer agreed to.
- **Adoption**: a signer's chosen signature or initials (drawn, typed in the script font, or uploaded), stored once as a PNG and
  applied wherever they sign. The typed field starts blank: nothing is filled in for the signer. **Typed name only** (`envelopes.typed_only`,
  set at Send) offers the typed field alone, for a consent the IRS wants signed that way.
- **Intent**: what Finish asks the signer to confirm, in their own name ("I am Alice Example. By selecting Finish and sign, I adopt the
  signature shown as mine ..."); the signed event records its hash.
- **Instruction**: the owner's word for one action Claude takes on one envelope, as Claude recorded it from a session. Append-only,
  used once, and an agent's send, remind, cancel or correction is refused without one (`src/signing/instructions.ts`). Claude's own
  account, not proof.
- **Sending switch**: `settings.agent_sending`, off until an operator turns it on. Off, Claude can still draft.
- **Sweep**: the hourly run (`src/signing/sweep.ts`): expiry, scheduled reminders in each client's hours, sealing again what is
  stuck, mail a request left pending, and the retention purge.
