#!/usr/bin/env bun
// The repository says MIT once, at the root, and every package has to agree.
//
// Four packages already declared `"license": "MIT"` and shipped to npm while
// the repository itself declared nothing — GitHub's license API answered 404
// for Zabaca/zbc, and three awesome-list submissions each had to leave the
// field blank. The root LICENSE fixes what GitHub reads; this script fixes the
// half that drifts silently, because a new package.json defaults to no license
// and nothing notices until someone publishes it.
//
// Two claims, both fatal:
//   1. every packages/*/package.json and every app template declares MIT
//   2. packages/cli/LICENSE is byte-identical to the root LICENSE
//
// The second is why the copy can exist at all. `bun publish` only carries a
// LICENSE that sits inside the package directory, and @zabaca/zbc lives under
// packages/cli — so the text is committed twice on purpose, and this is what
// keeps the second copy from becoming a different licence than the first.

import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

const manifests = [
  ...new Glob('packages/*/package.json').scanSync({ cwd: root, followSymlinks: false }),
  ...new Glob('packages/cli/templates/apps/*/package.json').scanSync({ cwd: root }),
]

const failures: string[] = []

for (const rel of [...new Set(manifests)].sort()) {
  const pkg = JSON.parse(readFileSync(join(root, rel), 'utf8')) as { license?: string }
  if (pkg.license !== 'MIT') {
    failures.push(`${rel}: license is ${pkg.license ? `"${pkg.license}"` : 'missing'}, expected "MIT"`)
  }
}

const rootLicense = readFileSync(join(root, 'LICENSE'), 'utf8')
const cliLicense = readFileSync(join(root, 'packages/cli/LICENSE'), 'utf8')
if (rootLicense !== cliLicense) {
  failures.push('packages/cli/LICENSE differs from the root LICENSE — copy the root file over it')
}

if (failures.length > 0) {
  console.error('License check failed:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log(`License check passed: ${new Set(manifests).size} packages declare MIT, LICENSE copies match.`)
