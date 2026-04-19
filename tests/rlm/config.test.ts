import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/rlm/config.js";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  // Clear RLM_* keys so tests are hermetic.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("RLM_") || key.startsWith("OPENAI_") || key.startsWith("OLLAMA_")) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ORIG_ENV);
});

describe("loadConfig — preserveThinking", () => {
  it("defaults to true", () => {
    const cfg = loadConfig();
    expect(cfg.llm.preserveThinking).toBe(true);
  });

  it("RLM_PRESERVE_THINKING=false turns it off", () => {
    process.env.RLM_PRESERVE_THINKING = "false";
    expect(loadConfig().llm.preserveThinking).toBe(false);
  });

  it("RLM_PRESERVE_THINKING=0 turns it off", () => {
    process.env.RLM_PRESERVE_THINKING = "0";
    expect(loadConfig().llm.preserveThinking).toBe(false);
  });

  it("RLM_PRESERVE_THINKING=true keeps it on", () => {
    process.env.RLM_PRESERVE_THINKING = "true";
    expect(loadConfig().llm.preserveThinking).toBe(true);
  });

  it("override takes precedence when env var absent", () => {
    expect(loadConfig({ llm: { preserveThinking: false, model: "x" } }).llm.preserveThinking).toBe(false);
    expect(loadConfig({ llm: { preserveThinking: true, model: "x" } }).llm.preserveThinking).toBe(true);
  });

  it("env var takes precedence over override", () => {
    process.env.RLM_PRESERVE_THINKING = "false";
    expect(loadConfig({ llm: { preserveThinking: true, model: "x" } }).llm.preserveThinking).toBe(false);
  });

  it("accepts case-insensitive yes/no/on/off", () => {
    process.env.RLM_PRESERVE_THINKING = "NO";
    expect(loadConfig().llm.preserveThinking).toBe(false);
    process.env.RLM_PRESERVE_THINKING = "on";
    expect(loadConfig().llm.preserveThinking).toBe(true);
  });
});
