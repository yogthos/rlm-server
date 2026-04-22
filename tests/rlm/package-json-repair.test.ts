import { describe, it, expect } from "vitest";
import { createDesignGraph } from "../../src/rlm/design-graph.js";
import { repairPackageJson } from "../../src/rlm/design-package-json-repair.js";

describe("repairPackageJson (Phase H3)", () => {
  const currentPkg = JSON.stringify(
    { name: "x", dependencies: { "nonexistent-pkg": "^99.99.99" } },
    null,
    2,
  );
  const installStderr = "npm ERR! 404 Not Found - nonexistent-pkg";

  it("prompts the architect with the current file + install error, stores the revised file", async () => {
    const g = createDesignGraph();
    g.setAsset("package.json", currentPkg);
    let prompt = "";
    const chat = async (p: string) => {
      prompt = p;
      return (
        '```file:package.json\n' +
        JSON.stringify({ name: "x", dependencies: { express: "^4.0.0" } }, null, 2) +
        "\n```"
      );
    };
    const r = await repairPackageJson(g, installStderr, { chat });
    expect(r.ok).toBe(true);
    expect(prompt).toContain("404 Not Found");
    expect(prompt).toContain("nonexistent-pkg");
    const revised = g.getAsset("package.json");
    expect(revised).toContain("express");
    expect(revised).not.toContain("nonexistent-pkg");
  });

  it("returns ok=false when the architect doesn't emit a file:package.json fence", async () => {
    const g = createDesignGraph();
    g.setAsset("package.json", currentPkg);
    const chat = async () => "Sorry, can't help.";
    const r = await repairPackageJson(g, installStderr, { chat });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no file:package\.json fence/i);
    // Original asset untouched.
    expect(g.getAsset("package.json")).toBe(currentPkg);
  });

  it("rejects a revised package.json that isn't valid JSON", async () => {
    const g = createDesignGraph();
    g.setAsset("package.json", currentPkg);
    const chat = async () =>
      "```file:package.json\n{ this is not json\n```";
    const r = await repairPackageJson(g, installStderr, { chat });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not valid JSON|parse/i);
    expect(g.getAsset("package.json")).toBe(currentPkg);
  });

  it("retries once on the first unparseable response before giving up", async () => {
    const g = createDesignGraph();
    g.setAsset("package.json", currentPkg);
    let calls = 0;
    const chat = async () => {
      calls++;
      if (calls === 1) return "hand-waves instead of JSON";
      return (
        '```file:package.json\n' +
        JSON.stringify({ name: "x", dependencies: { express: "^4.0.0" } }) +
        "\n```"
      );
    };
    const r = await repairPackageJson(g, installStderr, {
      chat,
      maxRetries: 1,
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(g.getAsset("package.json")).toContain("express");
  });

  it("also updates projectConfig.packageJson when it was set", async () => {
    const g = createDesignGraph();
    g.setAsset("package.json", currentPkg);
    g.setProjectConfig({
      packageJson: currentPkg,
      runtime: "node",
      moduleSystem: "esm",
      testFramework: "vitest",
      testCommand: "npx vitest run",
      testImports: "import { it } from 'vitest';",
    });
    const chat = async () =>
      '```file:package.json\n{ "name": "x" }\n```';
    const r = await repairPackageJson(g, installStderr, { chat });
    expect(r.ok).toBe(true);
    const cfg = g.getProjectConfig();
    expect(cfg?.packageJson).toBe('{ "name": "x" }');
  });
});
