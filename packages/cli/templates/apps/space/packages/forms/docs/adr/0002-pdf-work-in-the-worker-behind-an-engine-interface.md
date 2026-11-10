# The PDF work runs in the Worker, behind an engine interface

Status: accepted, conditional on a spike, which passed (below).

All PDF work (inspecting, preparing, flattening, stamping, appending pages, attaching files, sealing) runs in the Worker
through LibPDF 0.5.3 (`@libpdf/core`, MIT, written by Documenso and used in its production, pinned exactly). It lives
behind `src/pdf/engine.ts`, which takes and returns bytes and holds no state, so replacing the library, or moving only
that module into a Cloudflare Container, changes nothing else. A Container was not adopted: it needs Docker at deploy time
and could spend past what is included.

## The spike

LibPDF's README lists Node, Bun and browsers, not Workers. The spike ran each fixture (`scripts/fixtures.ts`) through the
Worker's seal check in **workerd**, the production bundle served by `vite preview` over a local D1 and R2
(`e2e/spike.test.ts`): inspected, given a working copy, flattened, stamped in all four corners of every page, given an
appended page and an attached file, and sealed with RSA 2048 through Web Crypto, or refused with its intended message.

**Passed.** For every fixture that opens (plain, rotated 90 and 180 and 270, mixed Letter, Legal and A4, crop and media boxes
that do not start at zero, a 19.4 MB image-only scan, change restrictions only, a password file given its password, the
IRS W-9, an XFA and AcroForm hybrid, a damaged cross-reference table, a file already carrying a signature):

- poppler's `pdfsig` reports the seal valid over the whole file ("Total document signed") with an untrusted certificate;
- a render shows each corner stamp within 2 points of where it was placed on every page, every rotation and crop box;
- the scan completes.

Refused with a plain reason: an XFA-only form, a 21 MB file, a file that needs a password and has none (and a wrong one
as wrong). A byte changed after sealing makes `pdfsig` report the signature invalid.

**Numbers** (an Apple silicon Mac, workerd under `vite preview`, one request at a time):

| | |
|---|---|
| Worker bundle | 2,208 KB, 428 KB gzipped (Cloudflare's limit is 10 MB compressed on the paid plan) |
| Seal a 19.4 MB scan (whole chain) | about 85 ms wall, 0.04 s of workerd CPU |
| Worst CPU of any fixture | 0.08 s (the W-9: 138 KB, 6 pages) |
| workerd resident memory, idle | 103 MB (the whole runtime, not one isolate) |
| Growth for completion alone on the 19.4 MB scan (`stage=finish`) | +77 MB |
| Growth for upload alone (`stage=prepare`) | +58 MB |
| Growth for the operator's synthetic check (builds the scan, then seals it) | +96 MB |

Growth is resident memory sampled in a tight loop with `proc_pidinfo`, a measurement and not a proof: local workerd does
not enforce Cloudflare's 128 MB per isolate. The finishing path holds roughly four copies of the file (the request body,
the incremental save, the bytes hashed, the signed result: LibPDF's `sign()` saves, hashes a copy of the signed ranges,
reloads and saves again). At the 20 MB cap that leaves about 25 percent under 128 MB if an isolate's own baseline is near
20 MB, which is not measured. **The first deploy's seal check is the proof** (`POST /admin/api/seal-check`, button on the
Seal screen; `?mb=` runs a smaller scan). If it fails with Cloudflare's error 1102, the first remedy is a lower cap (the
`LIMITS` constant in `src/pdf/engine.ts`: 15 MB costs nothing and is also the size an email attachment tops out at), the
second is a Container for this module alone.

CPU is nowhere near a limit, so `wrangler.jsonc` sets 10 seconds as a guard against a runaway loop, not a budget.

## What the spike found

**LibPDF 0.5.3's `getMediaBox()`, `getCropBox()` and `page.width`/`height` are wrong for any box that does not start at the
origin.** Its `getBox` returns the file's `[llx lly urx ury]` as `{x, y, width, height}`, so a crop box `[36 72 540 700]`
reads as 540 wide and 700 tall. The engine reads the arrays itself (`readBox`, walking up the page tree because the boxes are
inheritable). The first render of the crop-offset fixture was 36 points off before this was found. Drawing is not affected
(content is in absolute user space); nothing else in the engine reads a box from LibPDF.

Also: `pdf.sign()` is not cheap in memory (above); the library's text extraction reads text on a turned page in user
space, so a stamp's text is verified by rendering and not by extraction; and local R2 ignores the customer key, so the
storage check only proves the bucket in production (ADR 0004).
