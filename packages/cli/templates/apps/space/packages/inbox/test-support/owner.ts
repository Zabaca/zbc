import { inboxOwnerOf } from '../src/owner'
import { bundledInstall } from '../src/workspace'

/**
 * Northfield's owner, read from the declaration the tests bundle (the invented install's workspace.json), as the Worker reads it. The suites that pin Northfield's words
 * run on this owner and expect "Tessa" and "Tessa Marlow" in them; test/access.test.ts pins that the declaration says so.
 */
export const NORTHFIELD_OWNER = inboxOwnerOf(bundledInstall)
export const OWNER_EMAIL = NORTHFIELD_OWNER.email
export const OWNER_NAME = NORTHFIELD_OWNER.mailName
