import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureDepsInstalled,
  buildInstallCommand,
} from "../../src/rlm/install-deps.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "rlm-u4-"));
  dirs.push(d);
  return d;
}

describe("buildInstallCommand (Phase U4)", () => {
  it("defaults to npm when packageManager is unset", () => {
    const cmd = buildInstallCommand();
    expect(cmd.bin).toBe("npm");
    expect(cmd.args[0]).toBe("install");
  });

  it("uses pnpm when decisions.packageManager === 'pnpm'", () => {
    const cmd = buildInstallCommand("pnpm");
    expect(cmd.bin).toBe("pnpm");
    expect(cmd.args).toContain("install");
  });

  it("uses yarn when decisions.packageManager === 'yarn'", () => {
    const cmd = buildInstallCommand("yarn");
    expect(cmd.bin).toBe("yarn");
    expect(cmd.args).toContain("install");
  });

  it("uses bun when decisions.packageManager === 'bun'", () => {
    const cmd = buildInstallCommand("bun");
    expect(cmd.bin).toBe("bun");
    expect(cmd.args).toContain("install");
  });

  it("rejects unknown packageManager with a clear error", () => {
    expect(() => buildInstallCommand("weird-tool")).toThrow(/packageManager/i);
  });

  it("treats explicit '(none)' as no-install", () => {
    const cmd = buildInstallCommand("(none)");
    expect(cmd.bin).toBe("");
    expect(cmd.args).toEqual([]);
  });
});

describe("ensureDepsInstalled dispatches by packageManager", () => {
  it("passes through the caller-provided packageManager to runInstall", async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "t", dependencies: { foo: "^1.0.0" } }),
    );
    let seen: string | undefined = undefined;
    const res = await ensureDepsInstalled(dir, {
      packageManager: "pnpm",
      runInstall: async (_dir, opts) => {
        seen = opts?.bin;
        return { ok: true, stderr: "" };
      },
    });
    expect(res.ok).toBe(true);
    expect(seen).toBe("pnpm");
  });

  it("skips installer entirely for packageManager = '(none)'", async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "t", dependencies: { foo: "^1.0.0" } }),
    );
    let called = false;
    const res = await ensureDepsInstalled(dir, {
      packageManager: "(none)",
      runInstall: async () => {
        called = true;
        return { ok: true, stderr: "" };
      },
    });
    expect(called).toBe(false);
    expect(res.ok).toBe(true);
    expect(res.ran).toBe(false);
  });
});
