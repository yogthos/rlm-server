/**
 * Generic extract → validate → fix feedback loop.
 * Ported from sporulator/src/sporulator/feedback.clj (lines 7–41).
 *
 * Invariant: the LLM session is shared across attempts (the caller
 * passes a `sendPrompt` closure that can carry conversational state),
 * so the model keeps memory of prior attempts. Tier escalation lives
 * OUTSIDE this loop — the caller builds each fix prompt via
 * `buildFixPrompt(attempt, prev, error)` and decides whether to
 * narrow / go fresh / keep standard.
 */

export interface FeedbackLoopOptions<Extracted, Validated> {
  /** First prompt sent to the LLM. */
  initialPrompt: string;
  /** Sends a prompt; returns the model's raw response. */
  sendPrompt: (prompt: string) => Promise<string>;
  /** Optional raw-response extractor (e.g. pull a code block out). Default: identity. */
  extract?: (raw: string) => Extracted | Promise<Extracted>;
  /**
   * Validates the extracted value. Sync and async implementations both work —
   * the loop always awaits the result.
   */
  validate: (
    extracted: Extracted,
  ) =>
    | { ok: true; value: Validated }
    | { ok: false; error: string }
    | Promise<{ ok: true; value: Validated } | { ok: false; error: string }>;
  /** Build the next prompt after a validation failure. */
  buildFixPrompt: (attempt: number, previous: Extracted, error: string) => string;
  /** Default 3. */
  maxAttempts?: number;
  /** Called once per attempt with progress info. */
  onAttempt?: (info: { attempt: number; ok: boolean; error?: string; extracted: Extracted }) => void;
}

export type FeedbackLoopResult<Extracted, Validated> =
  | { status: "ok"; result: Validated; attempts: number }
  | { status: "failed"; error: string; lastValue: Extracted; attempts: number };

export async function feedbackLoop<Extracted = string, Validated = Extracted>(
  opts: FeedbackLoopOptions<Extracted, Validated>,
): Promise<FeedbackLoopResult<Extracted, Validated>> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const extract = opts.extract ?? ((raw: string) => raw as unknown as Extracted);

  let prompt = opts.initialPrompt;
  let lastExtracted: Extracted = undefined as unknown as Extracted;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await opts.sendPrompt(prompt);
    const extracted = await Promise.resolve(extract(raw));
    const result = await Promise.resolve(opts.validate(extracted));

    opts.onAttempt?.({
      attempt,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      extracted,
    });

    if (result.ok) {
      return { status: "ok", result: result.value, attempts: attempt };
    }

    lastExtracted = extracted;
    lastError = result.error;

    if (attempt < maxAttempts) {
      prompt = opts.buildFixPrompt(attempt, extracted, result.error);
    }
  }

  return {
    status: "failed",
    error: lastError,
    lastValue: lastExtracted,
    attempts: maxAttempts,
  };
}
