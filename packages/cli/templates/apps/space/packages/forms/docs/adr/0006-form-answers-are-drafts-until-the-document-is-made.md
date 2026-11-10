# A form's answers are drafts until the document is made, and the log holds no answer

Status: accepted.

The form path ends in a prepared document (ADR 0001), and "what the signer saw" is that PDF with its fingerprint. Three choices
follow from that, each with a reason a later reader would otherwise have to rediscover.

**An answer is a draft, not an event.** The filler's answers are saved one at a time, as they are given, so a link resumes where the
person stopped. Each is a row in `answers`, encrypted with the envelope's key and bound to its envelope and question (`ctx.answer`).
Saving one writes no event, as saving a signer's field value writes none (ADR 0005): it commits the person to nothing. What commits
them is making the document. That writes an `answered` event (the form version, its definition's SHA-256, how many questions and
uploads, how many answers were dropped, and the SHA-256 of each agreement's text) and then the core's `prepared` event with the PDF's
fingerprint. Changing an answer makes the document again with new events of both kinds, until the filler has signed (the core refuses
after). The signed document is the record of what the signer saw; the `answers` rows are the data it was made from.

**The log holds no hash of any answer.** An answer's hash would be as guessable as the answer: a nine-digit tax ID number is a
billion candidates, which a laptop tries in seconds. The agreement's text is the operator's own words, public to every signer, so its
hash is safe and is what fixes "the exact agreement text as the signer saw it" in the log. The PDF's fingerprint covers the answers.

**Visibility, not jumps** (as built). A question may carry a condition on EARLIER questions; the next question
is the next visible one; an answer to a question that is no longer shown is dropped when the document is made, together with its
uploaded files. `readDefinition` refuses a condition on a question at or after its own place, so a form cannot loop and the Worker,
the builder's preview and the filler's screens all call the same pure functions (`src/forms/definition.ts`).

**A change after the document is made withdraws it.** While no document exists a change is a draft. Once one exists, the change and the
withdrawal of the document are ONE batch with one `answered` event (`reopenPrepared`, `src/signing/lifecycle.ts`): the document's
file is deleted after the batch lands, the envelope has no document to sign (`prepared_key` is null, so the signer's state is
`preparing` and Finish refuses), and the filler makes it again. This replaces an earlier flag on the Answers screen for "answers saved
after the document": a flag could not stop the filler signing a document that listed a file already deleted, or an answer cleared. The
batch is refused once any signer has signed (`whenTail`, read before the signers) and moves every recipient's `values_version`, so a
Finish that read the old document fails its own guard. Making the document (`attachPrepared`) is guarded the same way and writes the
`answered` event of the form path in the same batch as `prepared`, held to the filler's answers version, so a lost race writes neither
event and drops nothing.

**What the operator sees.** Sensitive answers (a tax ID number always, any question the operator marks) are decrypted only to work out
which questions are shown; their values are never returned by the answers screen. Revealing one is the core's `revealAnswer` and is an
event, and the screen shows a revealed value as a person would say it (a stored yes or no, or a list, is not shown as JSON).

**Stored as text.** A text answer is stored as the text itself and every other type as JSON, so that revealing a sensitive answer
(which hands the operator the stored plaintext) shows what the customer typed, not a quoted copy.
