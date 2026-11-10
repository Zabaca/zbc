#!/usr/bin/env bun
/**
 * The public check: finds what the space's published code must not hold (a real address or host, an account-shaped id, a phone number that is not a reserved one, a reference to a private record).
 * Reports only; it exits 0 unless `--strict` is given.
 *
 *   bun packages/workspace/scripts/public-check.ts              every hit, grouped by package, with file and line
 *   bun packages/workspace/scripts/public-check.ts --summary    counts per package and per kind
 *   bun packages/workspace/scripts/public-check.ts <folder>     scan a folder whole instead of the space's own
 *   bun packages/workspace/scripts/public-check.ts --strict     exit 1 when there is any hit, or when no file was checked; a folder that does not exist exits 2
 *
 * What it looks for, and the allowlists it keeps, are in `src/public-check.ts`.
 */
import { fileURLToPath } from 'node:url'
import { runCommand } from '../src/check-tree'
import { checkPublic } from '../src/public-check'

// The space's own folder: the one that holds `packages/` and `kit/`, wherever a project keeps it.
const spaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
process.exit(runCommand('public check', checkPublic, process.argv.slice(2), spaceRoot))
