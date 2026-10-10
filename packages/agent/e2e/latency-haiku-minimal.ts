// Measure agent response latency with minimalOptions + haiku model.
// Run via: bun run e2e/latency-haiku-minimal.ts

import { ask, minimalOptions } from '../dist/index.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROMPT = 'Reply with exactly: OK'
const REPORT_PATH = join(import.meta.dir, '../latency-haiku-minimal-report.md')

async function main() {
  console.log('Starting latency measurement...')
  console.log(`Configuration: minimalOptions + haiku model`)
  console.log(`Prompt: "${PROMPT}"`)
  console.log('')

  const startMs = performance.now()
  let success = false
  let errorMsg = ''
  let response = ''

  try {
    response = await ask(PROMPT, minimalOptions())
    success = true
  } catch (error) {
    errorMsg = String(error)
  }

  const endMs = performance.now()
  const latencyMs = endMs - startMs

  // Generate report
  const reportContent = `# Latency Measurement Report
**Configuration:** minimalOptions + haiku model
**Date:** ${new Date().toISOString()}

## Setup
- **Model:** haiku (claude-haiku-4-5)
- **Options:** minimalOptions (no tools, no settings files, disabled thinking/extended features)
- **Prompt:** "${PROMPT}"

## Result
- **Status:** ${success ? 'Success' : 'Error'}
- **Total Latency:** ${latencyMs.toFixed(2)}ms
- **Start Time:** ${new Date(Date.now() - latencyMs).toISOString()}
- **End Time:** ${new Date().toISOString()}

${
  success
    ? `## Response
\`\`\`
${response}
\`\`\`
`
    : `## Error Details
\`\`\`
${errorMsg}
\`\`\`
`
}

## Notes
- This measurement was taken in a single run with no statistical repetition
- Network latency varies based on load and location
- The haiku model response time may vary based on API load
- minimalOptions reduces request overhead by ~97% compared to SDK defaults
`

  writeFileSync(REPORT_PATH, reportContent)
  console.log('=== LATENCY MEASUREMENT ===')
  console.log(`Latency: ${latencyMs.toFixed(2)}ms`)
  console.log(`Status: ${success ? 'SUCCESS' : 'ERROR'}`)
  console.log('========================')
  console.log(`Report saved to: ${REPORT_PATH}`)
  console.log('')
  console.log(reportContent)

  if (!success) {
    console.error(`\nError: ${errorMsg}`)
    process.exitCode = 1
  }
}

main()
