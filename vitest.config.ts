import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Exclude materialized scenario projects from the harness's own
    // test discovery. These dirs contain `*.test.ts` files the LLM
    // authored during a scenario run; they're not meant to be run
    // by the harness's vitest suite.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      "benchmark/projects/**",
    ],
  },
});
