import { describe, it, expect } from "vitest";
import { parseVitestFailures } from "../../src/rlm/design-integration-runner.js";

describe("parseVitestFailures", () => {
  it("returns an empty array on non-JSON output", () => {
    expect(parseVitestFailures("not json at all")).toEqual([]);
  });

  it("returns an empty array when all tests passed", () => {
    const json = JSON.stringify({
      testResults: [
        {
          assertionResults: [
            { status: "passed", title: "green" },
            { status: "passed", title: "also green" },
          ],
        },
      ],
      numPassedTests: 2,
      numFailedTests: 0,
    });
    expect(parseVitestFailures(json)).toEqual([]);
  });

  it("extracts failure with message and stack trace split on first newline", () => {
    const json = JSON.stringify({
      testResults: [
        {
          assertionResults: [
            {
              status: "failed",
              fullName: "project integration > POST /sign",
              failureMessages: [
                "AssertionError: expected 500 to equal 200\n    at handleSignPost (/tmp/proj/handleSignPost.ts:12:5)\n    at handleRequest (/tmp/proj/handleRequest.ts:4:3)",
              ],
            },
          ],
        },
      ],
    });
    const failures = parseVitestFailures(json);
    expect(failures).toHaveLength(1);
    expect(failures[0].testName).toBe("project integration > POST /sign");
    expect(failures[0].message).toBe("AssertionError: expected 500 to equal 200");
    expect(failures[0].stackTrace).toContain("handleSignPost");
    expect(failures[0].stackTrace).toContain("handleRequest");
  });

  it("handles multiple failures across files and preserves order", () => {
    const json = JSON.stringify({
      testResults: [
        {
          assertionResults: [
            {
              status: "failed",
              title: "t1",
              failureMessages: ["Err1\n    at a (/a.ts:1:1)"],
            },
          ],
        },
        {
          assertionResults: [
            { status: "passed", title: "ok" },
            {
              status: "failed",
              title: "t2",
              failureMessages: ["Err2\n    at b (/b.ts:2:2)"],
            },
          ],
        },
      ],
    });
    const failures = parseVitestFailures(json);
    expect(failures).toHaveLength(2);
    expect(failures[0].testName).toBe("t1");
    expect(failures[1].testName).toBe("t2");
    expect(failures[0].stackTrace).toContain("a (/a.ts");
    expect(failures[1].stackTrace).toContain("b (/b.ts");
  });

  it("handles a failure with no failureMessages gracefully", () => {
    const json = JSON.stringify({
      testResults: [
        {
          assertionResults: [
            { status: "failed", title: "silent", failureMessages: [] },
          ],
        },
      ],
    });
    const failures = parseVitestFailures(json);
    expect(failures).toHaveLength(1);
    expect(failures[0].testName).toBe("silent");
    expect(failures[0].message).toBe("(no failure message)");
    expect(failures[0].stackTrace).toBe("");
  });

  it("skips stdout preamble before the first JSON brace", () => {
    // Vitest prints progress lines before the JSON payload. Parser
    // must find the first `{` and parse from there.
    const json =
      "RUN  v4.1.3 rlm-sandbox\n stuff...\n" +
      JSON.stringify({
        testResults: [
          {
            assertionResults: [
              {
                status: "failed",
                title: "t",
                failureMessages: ["boom\n    at x (/x.ts:1:1)"],
              },
            ],
          },
        ],
      });
    const failures = parseVitestFailures(json);
    expect(failures).toHaveLength(1);
    expect(failures[0].testName).toBe("t");
  });
});
