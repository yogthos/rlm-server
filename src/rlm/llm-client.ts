/**
 * LLM client — thin re-export of the providers module.
 *
 * Kept for backward compatibility with the original API surface.
 * New code should import from "./providers/index.js" directly.
 */

export {
  createLLMClient,
  createLocalProvider,
  createOpenAIProvider,
  createDeepSeekProvider,
  createOllamaProvider,
  disposeLocalProvider,
  pickProvider,
} from "./providers/index.js";
