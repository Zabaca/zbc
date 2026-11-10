# One prepared document sits between authoring and signing

Status: accepted.

There are two ways to author what a person signs: a form (questions, conditional logic, an agreement text) and an
uploaded PDF with fields placed on it. Both end in a **prepared document**: a fixed PDF, fingerprinted with its SHA-256,
with each signer's fields on its pages. From there ONE signing core does the rest: links, consent, guided signing, events,
completion and the seal. The signing core takes a prepared document and knows nothing about forms or uploads, with two exceptions: purge deletes an envelope's uploads with it, and the completion email counts them (for a client copy address, which is told how many files its customer uploaded).

**Why.** The promise the service makes is that the record shows exactly what the signer saw. A PDF with a fingerprint
recorded each time it is shown and signed is the simplest thing that can keep it, and it makes the signing experience the
same for both paths. A form path that signed "the answers" directly would need its own notion of what was shown, its own
hash and its own render; the PDF path would need a second one.

**What a field is.** A recipient, a type (signature, initials, date, text, checkbox), a page, a box as fractions of the page
as shown measured from its top-left corner, required or not, a label, and optionally the name of the PDF's own field it
fills. Fractions of the shown page make placement independent of how a file stores rotation and crop; the engine converts
to the file's own coordinates only when it stamps (`src/pdf/geometry.ts`, tested to the pixel on every rotation and crop box).

**Cost.** A form's prepared document is rendered by the service, so a character its font cannot draw must be refused at the
question, not shown as a blank. The form path (the builder) does that. And a prepared document is re-made when the filler changes an
answer, with a new fingerprint and an event.

**Build order.** The schema (`fields`, `field_values`, `answers`, the envelope's prepared columns) and the geometry land first; the
contract is in code before the form path and the upload path are built on it.
