/**
 * Provider plugin contract.
 *
 * A provider implements LLMClient — that's the entire interface.
 * Each file in this directory exports a `create*Provider(config)`
 * function that returns an LLMClient.
 *
 * Adding a new provider:
 *   1. Create src/rlm/providers/myprovider.ts
 *   2. Export `createMyProvider(config: LLMConfig): LLMClient`
 *   3. Wire into src/rlm/providers/index.ts factory
 */

export type { LLMClient, LLMConfig, LLMResponse, ChatMessage, ChatOptions } from "../types.js";
