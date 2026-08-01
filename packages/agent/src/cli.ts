// bun run src/cli.ts "your prompt"
//
// Exists to make the package runnable while an agent is being developed. Real
// zbc agents import `ask`/`minimalOptions` rather than shelling out to this.
import { ask, minimalOptions } from './index'

const prompt = process.argv.slice(2).join(' ')
if (!prompt) {
  console.error('usage: bun run src/cli.ts "<prompt>"')
  process.exit(1)
}

console.log(await ask(prompt, minimalOptions()))
