import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../scripts/release-gate/windows-smoke.mjs", import.meta.url), "utf8");
const start = source.indexOf("function leftoverProcesses()");
const end = source.indexOf("\n}\n", start) + 2;
const createQuery = new Function("spawnSync", "root", `const isWindows = true; ${source.slice(start, end)}; return leftoverProcesses;`);

describe("Windows release-gate process cleanup evidence", () => {
  it("does not treat denied or failed PowerShell inspection as zero remaining processes", () => {
    for (const result of [{ status: 1, stderr: "Access denied", stdout: "" }, { status: null, error: new Error("spawn failed") }]) {
      expect(() => createQuery(() => result, "C:\\synthetic gate")()).toThrow("leftover process query failed");
    }
  });

  it("checks executable paths as well as command lines and parses the observed owners", () => {
    const spawn = vi.fn((_command: string, _args: string[]) => ({ status: 0, stdout: " 42 state.exe\r\n84 port:3911\r\n" }));
    expect(createQuery(spawn, "C:\\synthetic'gate")()).toEqual(["42 state.exe", "84 port:3911"]);
    const script = spawn.mock.calls[0][1][2];
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain("$_.ExecutablePath");
    expect(script).toContain("synthetic''gate");
  });
});
