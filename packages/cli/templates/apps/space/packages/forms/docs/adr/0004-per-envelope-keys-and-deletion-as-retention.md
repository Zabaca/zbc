# Each envelope has a key of its own, and deleting it is how retention works

Status: accepted, with this retention: 7 years by default, a per-client override, and unfinished envelopes deleted after 90 days.

Every envelope gets a random 256-bit **data key**, wrapped by a **master key** held as a Worker secret and in the install's secrets file
(`FORMS_DATA_KEY`, with a version so it can be rotated: `FORMS_DATA_KEY_V2` and on; `src/vault.ts`). With that key:

- **R2 objects** (the prepared and finished PDFs, uploads, signature images) are stored with R2's customer-provided-key
  encryption (SSE-C), so R2 does not keep the key and a copy of the bucket reads nothing. A client's logo is the exception:
  it is public (an email loads it) and stored plain.
- **Answers, field values and the recipient's token** in D1 are AES-256-GCM, with the value's context (its envelope and
  what it is) as associated data, so a ciphertext cannot be moved to another row and still open.
- **Names and email addresses stay readable**, because lists and mail need them.

Cloudflare already encrypts D1 and R2 at rest. This layer means a stolen database or bucket copy, or a restored backup,
reads nothing without the Worker's secret, and an operator browsing the dashboard sees no answer or file.

**Deletion is the retention mechanism.** The daily purge deletes an envelope's R2 objects, its rows and its
wrapped key, and writes a tombstone (id, client, title, completion time, the finished document's hash, the chain's last
hash). D1's Time Travel can restore the database for 30 days; a restore of a purged envelope brings back ciphertext whose key
is gone. The database permits deleting an envelope's events only once its tombstone exists (`events_deleted_only_when_purged`).

**An uploaded document (the PDF path) is the exception to "each envelope has its key".** A client's PDF is uploaded once and
sent as many times as wanted, so it has a data key of its own (`source:<id>`, wrapped like any other), which encrypts the file as
received and its working copy in R2. It is **not** deleted by retention: nothing deletes it by time, and an operator deletes it on the
Documents screen, which removes the row (and with it the wrapped key) and the two objects. Purging an envelope made from it deletes the
envelope's own copy of the prepared document and leaves the uploaded original in place, and a document cannot be deleted while an
envelope made from it exists, because the certificate names the original by its hash. So a client's file can outlive every envelope
sent from it, until someone deletes it. A retention rule for uploads is not decided; the Documents screen says what is kept.
The built-in sample's source document is the other kind: it belongs to its envelope and goes with it.

**Losing the master key loses every record**, which is why it also lives in the install's encrypted secrets file, which the repository and its keys back up.

**Unverified until the first deploy.** Local workerd stores an object put with a customer key and returns it with no key or
with another, so the bun and workerd tests cannot show that R2 refuses. `POST /admin/api/storage-check` (button on the Seal
screen) stores an object under a fresh key, reads it back, and tries it without the key and with another; do not send
anything until it passes in production.

**Cost.** Sealing and downloading decrypt on every request; the keys are never cached across requests. Search over answers
is impossible in SQL, which no screen needs.
