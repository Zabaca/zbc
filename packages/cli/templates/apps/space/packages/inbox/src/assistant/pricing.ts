/**
 * What a token costs, for the first week's report to the owner and for nothing else. List rates in US dollars per million
 * tokens, from Anthropic's published model table: Sonnet 5 at $2 read and $10 written. An ESTIMATE:
 * the report says so, and the number to trust is the key's own usage in Anthropic's console, which the report is checked
 * against. No caching is used, so there is no cache rate here.
 */
export const PRICES: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'claude-sonnet-5': { inputPerMillion: 2, outputPerMillion: 10 },
}

/** The cost of some tokens on a model, or null when this file has no rate for it. */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES[model]
  return price ? (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000 : null
}
