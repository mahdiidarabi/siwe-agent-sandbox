import { getQuickJS, isFail, shouldInterruptAfterDeadline } from "quickjs-emscripten";

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

function classifyError(message: string): "timeout" | "oom" | "exception" {
  const lower = message.toLowerCase();
  if (lower.includes("interrupted")) return "timeout";
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

  try {
    runtime.setMemoryLimit(memoryBytes);
    runtime.setMaxStackSize(1024 * 1024);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));

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
      return { ok: false, error: classifyError(message), message, ms };
    }

    const value = context.dump(result.value);
    result.value.dispose();

    let output: string;
    try {
      output = typeof value === "string" ? value : JSON.stringify(value);
    } catch (err) {
      return {
        ok: false,
        error: "output_too_large",
        message: `could not serialize output: ${err instanceof Error ? err.message : String(err)}`,
        ms,
      };
    }

    if (output.length > maxOutputChars) output = output.slice(0, maxOutputChars);
    return { ok: true, output, ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: classifyError(message), message, ms: Date.now() - started };
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
