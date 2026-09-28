import { createHash } from "node:crypto";
import { z } from "zod";
import type { Address } from "viem";
import { canUse, type ToolName } from "@/lib/authz";
import { runUntrusted } from "@/lib/sandbox";
import type { RequestLogger } from "@/lib/log";

// Descriptions the model sees. Provider-agnostic JSON Schema shape;
// app/api/chat/route.ts adapts this into whatever tool-definition format
// the LLM SDK in use expects.
export const TOOL_DEFS: Record<ToolName, { description: string; input_schema: Record<string, unknown> }> = {
  get_time: {
    description: "Get the current server time as an ISO 8601 string.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  run_js: {
    description:
      "Run untrusted JavaScript in an isolated sandbox with a timeout. There is no console, no " +
      "network, no filesystem, and no other host API, referencing any of them throws a " +
      "ReferenceError since they simply don't exist. The only way to produce output is the " +
      "value of the last expression evaluated, do not use console.log; end the code with the " +
      "value or expression you want returned instead.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript source to evaluate." },
      },
      required: ["code"],
    },
  },
};

// The actual authority on tool input shape at runtime. TOOL_DEFS above is
// just what we tell the model; this is what we enforce.
export const TOOL_ARGS = {
  get_time: z.object({}),
  run_js: z.object({ code: z.string().min(1).max(8000) }),
} satisfies Record<ToolName, z.ZodType>;

function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_DEFS, name);
}

// Fingerprint, not content: enough to tell "same code run again" or "how
// big was it" apart in logs without ever writing the untrusted code itself
// to disk.
function fingerprintCode(code: string) {
  return { codeLength: code.length, codeHash: createHash("sha256").update(code).digest("hex").slice(0, 16) };
}

export async function executeTool(
  address: Address,
  name: string,
  rawInput: unknown,
  logger: RequestLogger,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const started = Date.now();

  // 1. name is a known ToolName, else deny.
  if (!isToolName(name)) {
    logger.info("tool_call", { decision: "deny", reason: "unknown tool", tool: name, address });
    return { ok: false, error: "unknown tool" };
  }

  // 2. canUse(address, name), else deny. The model was only offered
  // allowedTools(address), but it can hallucinate a tool name anyway, so
  // this check, not the filtered list, is the actual authorization
  // boundary.
  if (!canUse(address, name)) {
    logger.info("tool_call", { decision: "deny", reason: "not authorized", tool: name, address });
    return { ok: false, error: "not authorized" };
  }

  // 3. zod-parse rawInput, else error.
  const parsed = TOOL_ARGS[name].safeParse(rawInput);
  if (!parsed.success) {
    logger.info("tool_call", { decision: "deny", reason: "invalid input", tool: name, address });
    return { ok: false, error: "invalid input" };
  }

  // 4. execute.
  let result: { ok: true; output: string } | { ok: false; error: string };
  let sandbox: string | undefined;
  let codeMeta: Record<string, unknown> = {};

  if (name === "get_time") {
    result = { ok: true, output: new Date().toISOString() };
  } else {
    const code = (parsed.data as { code: string }).code;
    codeMeta = fingerprintCode(code); // never the code itself, see below
    const sandboxResult = await runUntrusted(code);
    sandbox = sandboxResult.ok ? "ok" : sandboxResult.error;
    result = sandboxResult.ok
      ? { ok: true, output: sandboxResult.output }
      : { ok: false, error: `${sandboxResult.error}: ${sandboxResult.message}` };
  }

  // 5. log decision: allow, duration, outcome. Never the full user code,
  // a signature, or a session cookie, codeMeta is a length + hash
  // fingerprint only.
  logger.info("tool_call", {
    decision: "allow",
    tool: name,
    address,
    durationMs: Date.now() - started,
    outcome: result.ok ? "ok" : "error",
    ...(sandbox ? { sandbox } : {}),
    ...codeMeta,
  });

  return result;
}
