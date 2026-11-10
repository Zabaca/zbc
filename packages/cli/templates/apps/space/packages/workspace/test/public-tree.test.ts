// The space's own tree holds nothing the public check finds: no address or host that is not a reserved example or a listed third party's, no account-shaped id, no phone number a person could hold, no
// reference to a private record. This is the check as a test, so a change that brings one back fails here, naming the file and the line.
import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { readTree, runCheck, SPACE_TARGETS } from '../src/check-tree'
import { checkPublic } from '../src/public-check'

/** The space's own folder: the one that holds `packages/` and `kit/`. */
const spaceRoot = fileURLToPath(new URL('../../../', import.meta.url))

describe('the space’s tree is fit to publish', () => {
  test('the public check finds nothing in the folder: the packages, the deploy kit and what sits beside them', () => {
    const { files } = readTree(spaceRoot, SPACE_TARGETS)
    // A tree with nothing in it would pass by reading nothing.
    expect(files.length).toBeGreaterThan(500)
    const found = runCheck(checkPublic, files).map((hit) => `${hit.path}:${hit.line}  ${hit.kind}  ${hit.detail}`)
    expect(found).toEqual([])
  })
})
