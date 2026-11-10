// The person the space's one sign-in check names, for a test that calls a screen's function directly (with no Worker and so no check): Tessa, as Northfield's declaration has him.
import { signedIn } from '@space/workspace'

export const OWNER_SIGNED_IN = signedIn({ address: 'tessa@northfield.example', name: 'Tessa', signIn: 'tessa@northfield.example', role: 'owner', sharedAddresses: [] }, 4_000_000_000)
