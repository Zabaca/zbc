import { FIXTURES, ensureFixtures } from './fixtures'

const dir = await ensureFixtures(process.argv.includes('--force'))
console.log(`fixtures in ${dir}`)
for (const [name, f] of Object.entries(FIXTURES)) console.log(`  ${name.padEnd(16)} ${f.file.padEnd(16)} ${f.what}`)
