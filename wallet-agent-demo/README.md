# wallet-agent-demo

Next.js + TypeScript: Sign-In With Ethereum, an SSE-streamed chat backed by an LLM tool loop,
and one tool that runs untrusted JavaScript in a real sandbox (QuickJS/WASM), not `eval`. Every
tool call is authorized server side, per call, against a live role store, not just once at the
API boundary.

Setup and run instructions, and the full build narrative/phase plan, live in
[`../README.md`](../README.md). The threat model lives in [`THREATS.md`](THREATS.md). This file
is the technical reference: what each piece does, how they call each other, and why the code
looks the way it does.

## 1. Request flow, start to finish

```
Browser                              Server                                External
-------                              ------                                --------
app/page.tsx
  requestAddresses()  ─────────────► wallet extension (eth_requestAccounts)
  GET /api/auth/nonce ─────────────► issueNonce()                lib/nonce-store.ts
                       ◄───────────  { nonce }
  createSiweMessage()                                                       (viem/siwe, client-side)
  signMessage()       ─────────────► wallet extension (ECDSA sign)
  POST /api/auth/verify ───────────► parseSiweMessage()                     (viem/siwe)
                                      consumeNonce()               lib/nonce-store.ts
                                      domain/uri/chainId checks    app/api/auth/verify/route.ts
                                      verifySiweMessage() ────────────────► RPC (EIP-1271 eth_call,
                                                                              EOAs verify locally)
                                      getSession().save()          lib/session.ts
                       ◄───────────  Set-Cookie (httpOnly)
  router.push('/chat')

app/chat/page.tsx
  GET /api/auth/me    ─────────────► session check, redirect to / on 401
  POST /api/chat (SSE)─────────────► getSession() → address        app/api/chat/route.ts
                                      allowedTools(address)         lib/authz.ts
                                      generateContentStream() ───────────► Gemini
                                        │
                                        ├─ text deltas ──── event: token ───────►
                                        └─ functionCall  ── event: tool_call ───►
                                             executeTool(address, name, input, logger)
                                               isToolName? → canUse()? → zod parse    lib/tools.ts
                                               run_js → runUntrusted(code)            lib/sandbox.ts
                                                 fresh QuickJS runtime+context, no
                                                 host bindings, memory/stack/time
                                                 limits, disposed every call
                                             ── event: tool_result ─────────────►
                                             functionResponse pushed to history,
                                             loop continues (max 5 steps)
                       ◄───────────  event: done
  parseSSE() reassembles frames, renders bubbles
```

Everything server-side that decides who gets to do what happens in three files:
`app/api/auth/verify/route.ts` (are you who you say you are), `lib/authz.ts` (what role does
that address have), `lib/tools.ts` (does this specific call, right now, get to run).

## 2. File structure

```
app/
  page.tsx                    Sign in with Ethereum (viem, no wagmi)
  chat/page.tsx                Chat UI: SSE client + frame parser (parseSSE)
  layout.tsx, globals.css      Root layout, fonts, theme tokens

  api/auth/nonce/route.ts      GET  issue a single-use nonce
  api/auth/verify/route.ts     POST verify SIWE, set the session cookie
  api/auth/me/route.ts         GET  who am I
  api/auth/logout/route.ts     POST destroy the session
  api/chat/route.ts            POST SSE stream + tool loop (Gemini)

lib/
  session.ts       iron-session config + SessionData type
  nonce-store.ts    In-memory single-use nonce store (issue/consume)
  authz.ts          Roles, policy, canUse() — the actual authorization boundary
  tools.ts          Tool definitions (get_time, run_js) + executeTool()
  sandbox.ts        QuickJS sandbox runner: timeout, memory limit, no host bindings
  log.ts            Tiny JSON logger, no dependencies

tests/
  sandbox.test.ts    Vitest attack tests: infinite loop, OOM, host-escape attempts, ...

.claude/commands/    Custom slash commands used during the build (/quiz, /audit,
                     /attack-tests, /grill)

CLAUDE.md       Rules Claude worked under in this repo (file ownership, hard constraints)
THREATS.md      Threat model: trust boundaries, assets, controls, known gaps
```

## 3. Authentication: SIWE, step by step

`app/api/auth/verify/route.ts` is the whole authentication boundary. In order:

1. **Body shape** — zod (`message` ≤4096 chars, `signature` matches `0x[0-9a-fA-F]+`). Malformed
   input never reaches parsing.
2. **`parseSiweMessage(message)`** (viem/siwe) — splits the EIP-4361 text into fields. Doesn't
   verify anything yet.
3. **`consumeNonce(parsed.nonce)`** — checked *before* any other validation, so a rejected
   attempt still burns the nonce (`app/api/auth/verify/route.ts:44-46`). `lib/nonce-store.ts`
   deletes on every call, valid or not, a nonce is single-use regardless of outcome.
4. **`domain`/`uri`/`chainId` checked against `process.env`**, never against the request's
   `Host`/`Origin` header (`:53-55`). Comparing a signed field to a header on the *same*
   untrusted request would be comparing attacker-controlled data to itself, an attacker fully
   controls both.
5. **`issuedAt` in the future → reject** (`:60-62`). viem's own `validateSiweMessage` (called
   inside `verifySiweMessage`) checks `expirationTime`/`notBefore`, but not `issuedAt`.
6. **`verifySiweMessage()`** — recovers the signer and checks the ECDSA signature locally for an
   EOA, or does an `eth_call` against the claimed contract for EIP-1271/ERC-6492 (smart wallets).
   Re-checks domain/nonce/expiry internally too.
7. **`getAddress()`** normalizes to checksummed form before it's ever compared or stored.
   Mixed-case address comparison is a classic authz bypass.
8. **Session cookie**: `lib/session.ts` wraps `iron-session`, `httpOnly: true` (unreadable from
   `document.cookie`, closes the main XSS-exfiltration path), `sameSite: 'lax'` (blocks
   cross-site POST, e.g. a forged logout), `secure` only in production (dev runs on plain HTTP).

Every failure path returns the same generic `{ error: "sign-in failed" }` at 401. The *real*
reason (`"domain mismatch"`, `"unknown, expired, or reused nonce"`, ...) only ever goes to
`logger.warn("auth_denied", ...)` server-side (`lib/log.ts`), never to the client. Same split is
used in `app/api/chat/route.ts`'s catch block.

## 4. Authorization: roles and the tool loop

`lib/authz.ts` is policy-as-data:

```ts
const POLICY: Record<ToolName, Role> = { get_time: "user", run_js: "sandbox" };
```

Every signed-in address gets `"user"`. `"sandbox"` is granted only to addresses in
`SANDBOX_ALLOWLIST` (checksummed at load, `authz.ts:12-20`). `canUse(address, tool)` looks up the
required role and checks membership, unknown tool name → `POLICY[tool]` is `undefined` → deny by
default (`:41-44`).

The tool list sent to the model (`app/api/chat/route.ts:90-94`, built from
`allowedTools(address)`) is **hygiene, not the boundary**. An LLM can hallucinate a call to a
tool it was never offered. The real check is `executeTool`'s fixed order in `lib/tools.ts`:

1. Is `name` a known `ToolName`? (`isToolName`, `:60-63`)
2. `canUse(address, name)`? (`:69-72`) — re-checked here on *every single call*, independent of
   what the model was told
3. zod-parse the args against `TOOL_ARGS[name]` (`:75-79`) — `TOOL_DEFS`'s JSON Schema is only
   what the model sees; `TOOL_ARGS` is what's actually enforced
4. Execute
5. Log the decision (`allow`/`deny`, reason on deny, `sandbox` status, `durationMs`)

This is why a wallet that's signed in but not allowlisted can still chat and call `get_time`,
just not `run_js`: "connected" and "authorized" are different, enforced in different places, and
`canUse()` is what actually draws that line.

## 5. The sandbox: how untrusted code actually runs

`lib/sandbox.ts`'s `runUntrusted(code)` is called only from `executeTool` for `run_js`, and only
after authz and zod validation already passed. Per call:

1. **`getQuickJS()`** — the QuickJS WASM module is loaded once and cached (`:14-18`); everything
   after this is per-call.
2. **`QuickJS.newRuntime()` then `runtime.newContext()`** — a brand-new runtime and JS context
   *every call*, not reused or pooled. This is a genuinely separate execution engine (compiled to
   WASM), not a restricted context inside the same V8 isolate the server runs in, so there's no
   shared global object, no shared prototypes, nothing to walk up to reach Node. This is the
   actual reason `node:vm`/`vm2`/`new Function` were never options: those all execute inside the
   same V8 process as the host, isolation there depends on the sandbox correctly blocking every
   escape (a constructor trick, a prototype walk); QuickJS just doesn't *have* `process`,
   `require`, or `fetch` to escape to.
3. **Limits, set before any code runs**: `setMemoryLimit(16MB)`, `setMaxStackSize(1MB)`, and a
   custom interrupt handler (`:58-68`) checked periodically during execution, if the deadline has
   passed it sets `timedOut = true` and returns `true`, which QuickJS treats as "stop now."
4. **`context.evalCode(code)`** runs the code. No host functions are bound to the context, so
   `console`, `fetch`, `require` etc. don't silently no-op, they don't exist, referencing them
   throws `ReferenceError` like any undefined identifier.
5. **Result handling**: `isFail(result)` distinguishes a thrown/interrupted/OOM'd execution from
   a normal return. On failure, the error is dumped to a plain JS object and classified as
   `timeout` (from the interrupt flag, not string-matching), `oom`, or `exception` (the latter two
   still via substring match on the message, see the `TODO` in the file, a script that
   `throw`s an `Error("out of memory")` can currently spoof that classification). On success,
   `context.dump(result.value)` pulls the return value out into a real host JS value.
6. **Output**: the dumped value becomes a string (special-cased for `undefined`, since
   `JSON.stringify(undefined)` returns the value `undefined`, not a string, a real bug this hit
   and fixed) and truncated to 4000 chars if longer.
7. **`finally`**: dispose the context, then the runtime, every time, wrapped in their own
   `try`/`catch`. This isn't defensive boilerplate: testing found that after a real OOM
   condition, `runtime.dispose()` can throw a `WebAssembly.RuntimeError` from QuickJS's own
   internal GC assertion, uncaught, that crashes the whole Node process, not just the one
   request. One malicious `run_js` call could take the server down for every user without the
   `try`/`catch` here.

Verified in `tests/sandbox.test.ts`, against the running code, not just asserted: `while(true){}`
is killed by the deadline; unbounded recursion and unbounded array growth are caught, not
crashes; `console`/`fetch`/`process`/`require` are all `"undefined"`; `globalThis.constructor`
escape tricks can't reach real host data; a huge return value truncates instead of returning
whole; 100 sequential calls don't leak unboundedly.

## 6. Streaming: the SSE contract and the client parser

`app/api/chat/route.ts` returns a `ReadableStream` with `Content-Type: text/event-stream`. Every
event is `event: <name>\ndata: <json>\n\n` (`frame()`, `:50-52`). Five event types:
`token` (`{text}`), `tool_call` (`{id, name, input}`), `tool_result` (`{id, ok, output|error}`),
`error` (`{message}`), `done` (`{}`).

On the client, `app/chat/page.tsx`'s `parseSSE(buffer)` is a pure function: given everything read
so far, it returns the complete frames it can find plus whatever incomplete tail to keep
buffering. This matters because a network `read()` is never guaranteed to land on a frame
boundary, it can split one frame across two reads, or deliver several frames in one read. The
caller feeds `remainder` back in on the next chunk (`:93-99`). One real bug this caught: `data:`
lines keep the SSE-spec single leading space after the colon; the fix strips exactly one space,
not all whitespace, since the payload could have meaningful leading spaces of its own.

`request.signal` is threaded into Gemini's call (`config: { abortSignal: request.signal }`) so a
client disconnect stops the server from streaming into a dead connection and from running further
tool steps for nobody. Per `@google/genai`'s own docs this only stops the *client* from reading
further, it does not cancel the request or the billing on Google's side.

## 7. Provider swap history (why the code looks the way it does)

The build was scoped for `@anthropic-ai/sdk`. Two swaps happened live, each changed real
mechanics in `app/api/chat/route.ts`, not just an import line:

- **Anthropic → OpenAI** (no Anthropic key available): OpenAI's tool-call shape uses
  `tool_call_id` and JSON-string `arguments`; the loop had to `JSON.parse` args and match
  results by id.
- **OpenAI → Gemini** (OpenAI required billing): Gemini has no `tool`/`assistant` roles, only
  `user`/`model`, a function result is sent back as a `user`-role turn carrying a
  `functionResponse` part. `FunctionCall.args` is already a parsed object, no `JSON.parse`
  needed. And critically: Gemini's 3.x models attach a `thoughtSignature` to function-call parts
  that must be echoed back verbatim on the next turn or the API 400s, so the loop accumulates the
  raw `Part` objects Gemini returns (`:127, 155-163`) instead of reconstructing
  `{ functionCall: call }` from just the extracted call, which silently drops that field
  (confirmed live, was actively breaking every second tool-call turn before the fix).

`CLAUDE.md`'s hard-constraints section documents both swaps and why, since the rule that
Claude never writes the boundary files exists so a human can defend every line in an interview,
and "why does this call Gemini and not Anthropic" is exactly the kind of question that gets asked.

## 8. Logging

`lib/log.ts` is two functions: `log(level, event, fields)` writes one
`JSON.stringify({ts, level, event, ...fields})` line via `console.log`; `createRequestLogger()`
generates a `crypto.randomUUID()` requestId and returns a logger that stamps it on every line, so
one request's auth check, tool calls, and completion can all be grep'd/joined by that id.

What's logged: every request (`requestId`, `address`, `route`, `status`, `durationMs`), every
tool call (`decision: allow|deny`, `reason` on deny, `sandbox: ok|timeout|oom|exception`,
`durationMs`), auth failures (specific reason, server-side only). What's never logged: the
signature, the session cookie, or the untrusted code itself, `run_js` calls log a
`codeLength` + truncated SHA-256 `codeHash` fingerprint instead (`lib/tools.ts:44-49`), enough to
tell "same code run again" apart from "something new" without ever writing the code to disk.

## 9. Where the edges are

This file explains how the system works. `THREATS.md` is the honest accounting of where it
doesn't: unbounded conversation growth, no rate limiting (hit live during this build, both a
5/min and a 20/day Gemini free-tier cap), history that can be left corrupted if a client
disconnects mid tool-call, and a few others, each with the file and reasoning, not just a list.
