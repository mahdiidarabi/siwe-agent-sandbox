import { describe, expect, it } from "vitest";
import { runUntrusted } from "../lib/sandbox";

describe("sandbox: normal code", () => {
  it("1+1 returns the value of the last expression as a string", async () => {
    const result = await runUntrusted("1+1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe("2");
  });
});

describe("sandbox: attack - infinite loop", () => {
  it(
    "while(true){} is killed by the deadline, not left to hang forever",
    async () => {
      const result = await runUntrusted("while(true){}", { timeoutMs: 300 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("timeout");
      // Killed close to the deadline, not stuck running past it.
      expect(result.ms).toBeLessThan(2000);
    },
    10_000,
  );
});

describe("sandbox: attack - unbounded recursion", () => {
  it(
    "recursive stack overflow is reported as a controlled failure, not an uncaught crash",
    async () => {
      const result = await runUntrusted("function f(){ return 1 + f(); } f()");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Bounded by setMaxStackSize, this must not take down the process.
        expect(["oom", "exception"]).toContain(result.error);
      }
    },
    10_000,
  );
});

describe("sandbox: attack - single huge allocation", () => {
  it(
    "'x'.repeat(1e9) does not OOM the host process",
    async () => {
      const result = await runUntrusted("'x'.repeat(1e9)");
      // Whatever the outcome, this call must resolve (not hang, not crash
      // this test process) and must not hand back a ~1GB string.
      if (result.ok) {
        expect(result.output.length).toBeLessThan(1_000_000);
      } else {
        expect(["oom", "exception", "timeout"]).toContain(result.error);
      }
    },
    10_000,
  );
});

describe("sandbox: attack - unbounded array growth (OOM)", () => {
  it(
    "array growth until OOM is caught and reported, disposal does not crash the process",
    async () => {
      // This is the exact case that once crashed the whole Node process: after
      // hitting the memory limit, QuickJS could be left with a non-empty
      // internal GC list, and freeing the runtime hit an internal assertion
      // that aborted the process, not just this call. runUntrusted wraps
      // context/runtime disposal in try/catch specifically for this. If that
      // regresses, this test does not just fail red, it can take the whole
      // test process down with it, which is itself the signal.
      const result = await runUntrusted(
        "let a=[]; while(true){ a.push(new Array(1e6).fill('x')); }",
        { timeoutMs: 5000 },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("oom");
    },
    15_000,
  );
});

describe("sandbox: attack - host escape attempts", () => {
  it("console, fetch, process, and require do not exist in the sandbox", async () => {
    const result = await runUntrusted(
      "typeof console + ',' + typeof fetch + ',' + typeof process + ',' + typeof require",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe("undefined,undefined,undefined,undefined");
  });

  it("globalThis.constructor tricks cannot reach the host process object", async () => {
    const result = await runUntrusted(
      "try { String(globalThis.constructor.constructor('return process')()) } " +
        "catch (e) { 'blocked: ' + e.message }",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // There is no host `process` inside a fresh QuickJS global scope, so
      // this can only ever resolve to the blocked branch, never real data.
      expect(result.output).toMatch(/^blocked:/);
      expect(result.output).not.toContain("env");
      expect(result.output).not.toContain("version");
    }
  });

  it("Function constructor tricks cannot reach the host globalThis", async () => {
    const result = await runUntrusted(
      "try { String((function(){}).constructor('return this.process')()) } " +
        "catch (e) { 'blocked: ' + e.message }",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toMatch(/^blocked:|^undefined$/);
  });
});

describe("sandbox: output handling", () => {
  it("truncates a huge return value instead of returning it whole", async () => {
    const result = await runUntrusted("'x'.repeat(1e7)", { maxOutputChars: 4000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.length).toBe(4000);
  });
});

describe("sandbox: resource hygiene", () => {
  it(
    "100 sequential runs all succeed and do not grow process memory unboundedly",
    async () => {
      const before = process.memoryUsage().rss;

      for (let i = 0; i < 100; i++) {
        const result = await runUntrusted("1+1");
        expect(result.ok).toBe(true);
      }

      const after = process.memoryUsage().rss;
      const growthMb = (after - before) / 1024 / 1024;
      // Generous ceiling: each call creates and disposes its own WASM
      // runtime, so some growth is expected, this catches a real leak
      // (unbounded growth), not normal allocator noise.
      expect(growthMb).toBeLessThan(200);
    },
    30_000,
  );
});
