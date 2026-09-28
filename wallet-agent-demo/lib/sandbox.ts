import { getQuickJS, isFail } from "quickjs-emscripten";

export type SandboxResult =
  | { ok: true; output: string; ms: number }
  | { ok: false; error: "timeout" | "oom" | "exception" | "output_too_large"; message: string; ms: number };

const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_MEMORY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_CHARS = 4000;
const MAX_CODE_CHARS = 8000;

// Cache the module promise, not the module itself: getQuickJS() is safe to
// call multiple times, but there's no reason to hit it more than once.
let quickJSPromise: ReturnType<typeof getQuickJS> | undefined;
function loadQuickJS() {
  quickJSPromise ??= getQuickJS();
  return quickJSPromise;
}

// TODO(audit): the sandboxed code itself is what throws the message being
// classified here, so `throw new Error("out of memory")` from ordinary user
// code is misclassified as a real OOM event (spoofable, pollutes the
// decision/outcome audit log). Timeout used to have the same hole
// ("interrupted") until the interrupt handler below started reporting it
// authoritatively; oom/exception classification is still substring
// matching and still spoofable. No verified fix for that half yet, would
// need a QuickJS-internal signal (e.g. distinguishing by dumped error
// `name`) rather than the free-form `message`.
function classifyError(message: string, timedOut: boolean): "timeout" | "oom" | "exception" {
  if (timedOut) return "timeout";
  const lower = message.toLowerCase();
  if (lower.includes("memory") || lower.includes("stack")) return "oom";
  return "exception";
}

export async function runUntrusted(
  code: string,
  opts?: { timeoutMs?: number; memoryBytes?: number; maxOutputChars?: number },
): Promise<SandboxResult> {
  const started = Date.now();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryBytes = opts?.memoryBytes ?? DEFAULT_MEMORY_BYTES;
  const maxOutputChars = opts?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  if (code.length > MAX_CODE_CHARS) {
    return { ok: false, error: "exception", message: "code exceeds max length", ms: Date.now() - started };
  }

  const QuickJS = await loadQuickJS();
  const runtime = QuickJS.newRuntime();
  let context: ReturnType<typeof runtime.newContext> | undefined;

  // Our own interrupt handler instead of quickjs-emscripten's
  // shouldInterruptAfterDeadline helper, so we have an authoritative,
  // unspoofable signal that a timeout is what actually happened, instead
  // of trusting a substring match on an error message the sandboxed code
  // itself controls.
  let timedOut = false;
  const deadline = Date.now() + timeoutMs;

  try {
    runtime.setMemoryLimit(memoryBytes);
    runtime.setMaxStackSize(1024 * 1024);
    runtime.setInterruptHandler(() => {
      if (Date.now() < deadline) return false;
      timedOut = true;
      return true;
    });

    // No host functions exposed on the context: no console, no fetch,
    // nothing. The evaluated code's own return value is the only way
    // data leaves the sandbox.
    context = runtime.newContext();

    const result = context.evalCode(code);
    const ms = Date.now() - started;

    if (isFail(result)) {
      const dumped = context.dump(result.error);
      result.error.dispose();
      const message = typeof dumped?.message === "string" ? dumped.message : String(dumped);
      return { ok: false, error: classifyError(message, timedOut), message, ms };
    }

    const value = context.dump(result.value);
    result.value.dispose();

    // TODO(audit): dump()/JSON.stringify() below run entirely on the host,
    // after the guest VM's own memoryBytes limit no longer applies. A
    // value that's cheap inside QuickJS's 16MB but expensive once
    // materialized as V8 objects (e.g. very many small objects) has no
    // bound here before the maxOutputChars truncation further down, that
    // truncation only trims the final string, it doesn't cap the cost of
    // producing it.
    let output: string;
    if (value === undefined) {
      // JSON.stringify(undefined) returns the value `undefined`, not a
      // string (confirmed: typeof JSON.stringify(undefined) === "undefined").
      // Any ordinary code with no trailing expression value (a bare
      // `undefined`, a `let x = 1;` with nothing after it) hit `.length` on
      // that undefined below and got misreported as the sandboxed code's
      // own exception, when nothing had actually thrown.
      output = "undefined";
    } else if (typeof value === "string") {
      output = value;
    } else {
      try {
        output = JSON.stringify(value);
      } catch (err) {
        return {
          ok: false,
          error: "output_too_large",
          message: `could not serialize output: ${err instanceof Error ? err.message : String(err)}`,
          ms,
        };
      }
    }

    if (output.length > maxOutputChars) output = output.slice(0, maxOutputChars);
    return { ok: true, output, ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: classifyError(message, timedOut), message, ms: Date.now() - started };
  } finally {
    // Dispose the context, then the runtime, on every path including
    // timeout/oom. A leaked handle here is itself a DoS, but disposal
    // itself can throw (confirmed empirically: an OOM condition can leave
    // QuickJS's internal GC list non-empty, and freeing the runtime hits
    // an internal assertion that crashes the whole process, not just this
    // request, unless caught). Swallow disposal errors rather than let
    // one malicious script take down every in-flight request.
    try {
      context?.dispose();
    } catch {
      // best effort
    }
    try {
      runtime.dispose();
    } catch {
      // best effort
    }
  }
}
