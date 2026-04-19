import { describe, it, expect, vi } from "vitest";
import { feedbackLoop } from "../../src/rlm/feedback-loop.js";

describe("feedbackLoop", () => {
  it("returns ok on first-attempt success", async () => {
    const send = vi.fn(async () => "good-output");
    const result = await feedbackLoop({
      initialPrompt: "make something",
      sendPrompt: send,
      validate: (raw) => (raw.includes("good") ? { ok: true, value: raw } : { ok: false, error: "not good" }),
      buildFixPrompt: () => "fix it",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.result).toBe("good-output");
      expect(result.attempts).toBe(1);
    }
    expect(send).toHaveBeenCalledOnce();
  });

  it("retries on validation failure and succeeds", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls++;
      return calls < 2 ? "bad" : "good";
    });
    const result = await feedbackLoop({
      initialPrompt: "start",
      sendPrompt: send,
      validate: (raw) => (raw === "good" ? { ok: true, value: raw } : { ok: false, error: `was "${raw}"` }),
      buildFixPrompt: (attempt, prev, err) => `attempt=${attempt} prev="${prev}" err="${err}"`,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.attempts).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fails when max-attempts exhausted", async () => {
    const send = vi.fn(async () => "still-bad");
    const result = await feedbackLoop({
      initialPrompt: "go",
      sendPrompt: send,
      validate: () => ({ ok: false, error: "never good enough" }),
      buildFixPrompt: () => "try again",
      maxAttempts: 3,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.attempts).toBe(3);
      expect(result.error).toBe("never good enough");
      expect(result.lastValue).toBe("still-bad");
    }
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("passes the fix prompt back on each retry", async () => {
    const prompts: string[] = [];
    const send = vi.fn(async (p: string) => {
      prompts.push(p);
      return prompts.length < 3 ? "bad" : "good";
    });
    await feedbackLoop({
      initialPrompt: "initial",
      sendPrompt: send,
      validate: (raw) => (raw === "good" ? { ok: true, value: raw } : { ok: false, error: "no" }),
      buildFixPrompt: (attempt) => `fix-attempt-${attempt}`,
      maxAttempts: 5,
    });
    expect(prompts[0]).toBe("initial");
    expect(prompts[1]).toBe("fix-attempt-1");
    expect(prompts[2]).toBe("fix-attempt-2");
  });

  it("applies the extract step before validate", async () => {
    const send = vi.fn(async () => "prefix:123");
    const result = await feedbackLoop({
      initialPrompt: "go",
      sendPrompt: send,
      extract: (raw) => raw.split(":")[1],
      validate: (n) => (n === "123" ? { ok: true, value: Number(n) } : { ok: false, error: "bad" }),
      buildFixPrompt: () => "retry",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.result).toBe(123);
  });

  it("calls onAttempt hook with progress details", async () => {
    const events: Array<{ attempt: number; ok: boolean; error?: string }> = [];
    await feedbackLoop({
      initialPrompt: "go",
      sendPrompt: async () => "ok",
      validate: () => ({ ok: true, value: "done" }),
      buildFixPrompt: () => "retry",
      onAttempt: (info) => events.push(info),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ attempt: 1, ok: true });
  });

  it("defaults maxAttempts to 3", async () => {
    const send = vi.fn(async () => "nope");
    await feedbackLoop({
      initialPrompt: "go",
      sendPrompt: send,
      validate: () => ({ ok: false, error: "bad" }),
      buildFixPrompt: () => "retry",
    });
    expect(send).toHaveBeenCalledTimes(3);
  });
});
