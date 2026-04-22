import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureDepsInstalled } from "../../src/rlm/install-deps.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "rlm-install-test-"));
  dirs.push(d);
  return d;
}

describe("ensureDepsInstalled (Phase H2)", () => {
  it("no-ops when package.json is absent", async () => {
    const dir = await tmp();
    let called = false;
    const res = await ensureDepsInstalled(dir, {
      runInstall: async () => {
        called = true;
        return { ok: true, stderr: "" };
      },
    });
    expect(res.ran).toBe(false);
    expect(res.ok).toBe(true);
    expect(called).toBe(false);
  });

  it("runs the installer on first call, records a hash, returns ok:true", async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "t", dependencies: { foo: "^1.0.0" } }),
    );
    let calls = 0;
    const res = await ensureDepsInstalled(dir, {
      runInstall: async () => {
        calls++;
        return { ok: true, stderr: "" };
      },
    });
    expect(res.ok).toBe(true);
    expect(res.ran).toBe(true);
    expect(calls).toBe(1);
    expect(existsSync(path.join(dir, ".rlm-install-hash"))).toBe(true);
  });

  it("skips the installer when package.json hash is unchanged", async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "t", dependencies: { foo: "^1.0.0" } }),
    );
    let calls = 0;
    const runInstall = async () => {
      calls++;
      return { ok: true, stderr: "" };
    };
    await ensureDepsInstalled(dir, { runInstall });
    const second = await ensureDepsInstalled(dir, { runInstall });
    expect(calls).toBe(1);
    expect(second.ran).toBe(false);
    expect(second.ok).toBe(true);
  });

  it("re-runs when package.json content changes", async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "t", dependencies: { foo: "^1.0.0" } }),
    );
    let calls = 0;
    const runInstall = async () => {
      calls++;
      return { ok: true, stderr: "" };
    };
    await ensureDepsInstalled(dir, { runInstall });
    // Update package.json — should trigger a second install.
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "t", dependencies: { bar: "^2.0.0" } }),
    );
    await ensureDepsInstalled(dir, { runInstall });
    expect(calls).toBe(2);
  });

  it("surfaces install-runner failure and does NOT write the hash", async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "t", dependencies: { foo: "^1.0.0" } }),
    );
    const res = await ensureDepsInstalled(dir, {
      runInstall: async () => ({ ok: false, stderr: "npm ERR! 404 no-such-pkg" }),
    });
    expect(res.ok).toBe(false);
    expect(res.stderr).toContain("404");
    expect(existsSync(path.join(dir, ".rlm-install-hash"))).toBe(false);
  });

  it("retries the install on the next call after a failure (hash wasn't written)", async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "t", dependencies: { foo: "^1.0.0" } }),
    );
    let calls = 0;
    const runInstall = async () => {
      calls++;
      return calls === 1
        ? { ok: false, stderr: "boom" }
        : { ok: true, stderr: "" };
    };
    const a = await ensureDepsInstalled(dir, { runInstall });
    expect(a.ok).toBe(false);
    const b = await ensureDepsInstalled(dir, { runInstall });
    expect(calls).toBe(2);
    expect(b.ok).toBe(true);
  });

  it("skips the installer when package.json has zero declared dependencies", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t" }));
    let calls = 0;
    const res = await ensureDepsInstalled(dir, {
      runInstall: async () => {
        calls++;
        return { ok: true, stderr: "" };
      },
    });
    expect(res.ok).toBe(true);
    expect(res.ran).toBe(false);
    expect(calls).toBe(0);
  });

  it("treats malformed package.json as an install error", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "package.json"), "{ not valid json");
    const res = await ensureDepsInstalled(dir, {
      runInstall: async () => ({ ok: true, stderr: "" }),
    });
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/parse|invalid|json/i);
  });

  it("tolerates malformed deps fields (string / array / null) without crashing", async () => {
    // A hallucinated or hand-rolled package.json can put weird shapes
    // in `dependencies`. Each of these should count as "no real deps"
    // and skip the installer — NOT crash countDeps.
    const shapes: Array<Record<string, unknown>> = [
      { name: "a", dependencies: "oops" },
      { name: "b", devDependencies: ["arr", "ay"] },
      { name: "c", dependencies: null },
    ];
    for (const pkg of shapes) {
      const dir = await tmp();
      await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
      const res = await ensureDepsInstalled(dir, {
        runInstall: async () => ({ ok: true, stderr: "" }),
      });
      expect(res.ok).toBe(true);
      expect(res.ran).toBe(false);
    }
  });
});
