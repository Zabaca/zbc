# The seal sits behind an interface built for a hardware-held key

Status: accepted: a self-made seal now, and a clean path to a trusted one later.

**Today.** A root, "<service name> Root" (RSA 4096, 10 years), issued a seal certificate (RSA 2048, 3 years). The root's key is
in the install's secrets file (encrypted) and is never a Worker secret; the seal certificate's key (`FORMS_SEAL_KEY`) and its chain
(`FORMS_SEAL_CERT_CHAIN`, seal certificate then root) are. The seal is PAdES B-B, `ETSI.CAdES.detached`, reason "Sealed by
<service name>". A reader shows the signature's validity as unknown, because the root is on no trust list, and shows whether
the document changed after sealing; poppler's `pdfsig` says "Signature is Valid" and "Certificate issuer isn't Trusted".
A client that wants a green check can trust the root by hand: its SHA-256 is printed on every certificate of completion and on
the Seal screen.

**Later, on the owner's word, an Adobe-trusted (AATL) certificate.** Its rules require the key in certified hardware (FIPS 140-2
Level 2 or equivalent) or a remotely managed signing device with two-factor activation (AATL Technical Requirements v2.0,
EE4). So the swap is not a new file: it is a different `Signer` in `src/seal/sealer.ts` that calls a hardware-held key (a
cloud key service, or the certificate authority's remote signing; LibPDF ships a Google Cloud KMS signer and its `Signer`
interface is async for this), and a `TimestampAuthority`, which makes the seal PAdES B-T. The engine takes both
(`SealSpec`). No stored data changes. Documents sealed before the swap keep their seal and carry their certificate inside
them. Buying a certificate or a timestamp service is a spend and the owner's call.

**Renewal.** `bun packages/forms/scripts/seal-certs.ts --renew` reads the root key from the install's secrets file, issues a new seal certificate,
replaces the two Worker secrets' values in that file and leaves the root, the master key and every sealed document alone; apply the
instance to push it. The Seal screen warns 90 days ahead. `--status` shows dates and fingerprints from the secrets file without printing a secret.
The command refuses `--production` a second time, because a second master key would orphan every stored record.

**Why self-made at all.** It costs nothing, proves what the service needs to prove (any later change shows, and the event
log's last link is printed inside), and does not pretend to be what it is not. The weaker claim is stated plainly to signers
and clients; the certificate page says <service name> is the service, never a party.
