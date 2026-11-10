// Where the signer's page and a signing email reach forms' public API. Pure constants, so the page's bundle and the Worker's code read the same one.
//
// `/s/api` (the space's ADR 0018): `/s/` is the one prefix of the space's host open to signers with no sign-in, so the API they
// call (`/s/api/s/<token>/...`) and a client's logo (`/s/api/logo/<id>`) live under it. The space's Worker answers it; forms has no address of its own.
export const SIGNER_API = '/s/api'
