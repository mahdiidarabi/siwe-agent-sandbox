# wallet-agent-demo

Next.js + TypeScript demo: SIWE wallet sign-in with a server-issued nonce and an httpOnly session cookie, a chat page that streams LLM tokens over SSE, and a tool loop with two tools. One tool runs user-supplied JavaScript in a real sandbox with a timeout. Authorization is enforced server side on every tool call.

**Time budget:** 4 hours. **Goal:** build it, understand every line, defend it in the 0G Labs interview.

Setup and run instructions: [section 10](#10-run). Project structure, file-by-file:
[`wallet-agent-demo/README.md`](wallet-agent-demo/README.md).

---

## 0. The ownership rule (read first)

| Area | Who writes it | Why |
|---|---|---|
| `lib/nonce-store.ts`, `app/api/auth/**` | **Me** | Authentication boundary |
| `lib/authz.ts` | **Me** | Authorization boundary |
| `lib/sandbox.ts` | **Me** | Untrusted code boundary |
| `lib/tools.ts`, `app/api/chat/route.ts` | **Me** | Tool loop, where the model (untrusted caller) meets my code |
| UI pages, SSE client parser, styling, config, test scaffolding | Claude | Glue. I read and review it, I don't need to author it |

Rule of thumb: if a bug in the file could let the wrong person do the wrong thing, I write it.

---

## 1. Architecture

```
 Browser                        Next.js server (Node runtime)                 External
 -------                        ------------------------------                --------
 wallet (injected) --sign-->  /api/auth/nonce   issue nonce (Map + TTL)
                              /api/auth/verify  verify SIWE, consume nonce,
                                                set iron-session cookie
 chat page ---POST+fetch--->  /api/chat         require session
     <----- SSE events -----                    tool loop:
                                                  model -> tool_use
                                                  zod validate args
                                                  canUse(address, tool)  <-- live role store
                                                  execute
                                                     get_time
                                                     run_js -> QuickJS (WASM)
                                                  tool_result -> model   ----> LLM API
```

**Trust boundaries:** browser (untrusted), LLM (untrusted caller), sandbox output (untrusted text), server (trusted).

---

## 2. Scope (decisions, not omissions)

**In:** injected wallet (MetaMask / Rabby), one LLM provider (Anthropic), two tools, in-memory stores, run locally.

**Out, on purpose:**
- Embedded wallets (Privy/Dynamic style). Would add a second identity path, same authz layer.
- Multi-instance nonce/role store. The Map is single-instance only. Production: Redis, KV, or a Durable Object.
- Deployment, Playwright, rate limiting.

---

## 3. File map

```
app/
  page.tsx                   # connect + sign in                 (Claude)
  chat/page.tsx              # chat UI + SSE parser              (Claude, I review)
  api/auth/nonce/route.ts    # GET: issue nonce                  (ME)
  api/auth/verify/route.ts   # POST: verify SIWE, set session    (ME)
  api/auth/me/route.ts       # GET: who am I                     (ME)
  api/auth/logout/route.ts   # POST: destroy session             (ME)
  api/chat/route.ts          # POST: SSE + tool loop             (ME)
lib/
  session.ts                 # iron-session options + types      (ME, small)
  nonce-store.ts             # Map + TTL, single use             (ME)
  authz.ts                   # roles + policy + canUse()         (ME)
  tools.ts                   # tool defs, zod schemas, executor  (ME)
  sandbox.ts                 # QuickJS runner                    (ME)
  log.ts                     # JSON logger                       (Claude)
tests/
  authz.test.ts  sandbox.test.ts  nonce.test.ts
.claude/commands/
  quiz.md  audit.md  attack-tests.md  grill.md
CLAUDE.md  README.md  THREATS.md  .env.local
```

---

## 4. How I use Claude Code in this project

### 4.1 The loop for every phase

1. **Understand** (Plan mode): `/quiz <topic>`. No code until I answer the quiz correctly.
2. **Build**: I write the boundary files. I ask Claude only for docs pointers, API signatures, and error explanations. Claude writes the glue.
3. **Attack**: `/audit <files>` then `/attack-tests <files>`. Claude writes failing tests; **I** fix my code until they pass.
4. **Reset**: `/clear` before the next phase so old context doesn't leak assumptions.

### 4.2 Custom commands (create these in setup)

`.claude/commands/quiz.md`
```md
Explain $ARGUMENTS for an engineer who knows Go, net/http, ECDSA and Solidity but is new to
this TypeScript/Next.js stack. Map concepts to Go equivalents where possible. Keep it under
300 words. Then ask me 5 questions, one at a time, and wait for each answer. Correct me bluntly.
Do not write any implementation code.
```

`.claude/commands/audit.md`
```md
Act as a hostile security auditor. Review: $ARGUMENTS
List concrete attacks (name, precondition, exploit steps) and for each say: BLOCKED (cite the
line) or OPEN. Also list logic bugs and missing checks. Do not praise. Do not fix anything.
Do not edit files.
```

`.claude/commands/attack-tests.md`
```md
Write Vitest tests that attempt the attacks and edge cases for: $ARGUMENTS
Put them in tests/. Each test name states the attack. Tests must fail if the defense is
missing. Do not modify any file outside tests/.
```

`.claude/commands/grill.md`
```md
You are a senior engineer at 0G Labs interviewing me for Product Engineer. You have read this
repo. Ask me one hard question at a time about design choices, failure modes, scale, and
"why not X". Do not accept vague answers; push until the answer is precise or I admit I don't
know. After 10 questions, list the topics where my answers were weak.
```

### 4.3 Prompts that are allowed on MY files

- "What is the signature of `verifySiweMessage` in viem and which checks does it do by itself?"
- "Explain this TypeScript error, don't fix it: `<paste>`"
- "Point me to the iron-session v8 docs for App Router usage."

Not allowed on my files: "write", "implement", "fix it". If I'm stuck for more than 10 minutes, I may ask for a **hint in prose**, never code.

---

## 5. Step by step

Checkpoint clock times assume start at 0:00. If I'm more than 15 minutes behind a checkpoint, go to the cut list (section 7).

---

### Phase 0: Setup and mental model (0:00 to 0:20)

**Steps**
- [ ] `pnpm create next-app@latest wallet-agent-demo` (TypeScript, App Router, ESLint, no `src/` dir)
- [ ] `pnpm add viem iron-session @anthropic-ai/sdk quickjs-emscripten zod`
- [ ] `pnpm add -D vitest`
- [ ] Add `"test": "vitest"` to `package.json` scripts
- [ ] Copy `CLAUDE.md` into the repo root
- [ ] Create the four files in `.claude/commands/` (section 4.2)
- [ ] Create `.env.local`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5
SESSION_PASSWORD=<at least 32 random chars: openssl rand -hex 32>
APP_DOMAIN=localhost:3000
APP_URI=http://localhost:3000
CHAIN_ID=1
RPC_URL=<any public mainnet RPC>
SANDBOX_ALLOWLIST=0xYourMainWallet     # comma-separated, checksummed
```

- [ ] `git init && git add -A && git commit -m "scaffold"`

**Claude**
```
/quiz Next.js App Router: route handlers, server vs client components, where each file runs,
how cookies() and request/response work in route handlers
```

**Done when:** `pnpm dev` serves the default page and I can explain where `app/api/x/route.ts` runs versus `app/page.tsx`.

---

### Phase 1: SIWE auth (0:20 to 1:20), I write it

**Claude first**
```
/quiz EIP-4361 (SIWE): message fields, what nonce/domain/uri/chainId/expirationTime each
defend against, and what viem/siwe gives me (createSiweMessage, parseSiweMessage,
verifySiweMessage)
```

**Interfaces to implement (bodies are mine)**
```ts
// lib/session.ts
export type SessionData = { address?: `0x${string}`; chainId?: number; issuedAt?: number };
export const sessionOptions: SessionOptions; // cookieName, password, cookieOptions
export async function getSession(): Promise<IronSession<SessionData>>;

// lib/nonce-store.ts
export function issueNonce(): string;              // random, alphanumeric, >= 16 chars
export function consumeNonce(n: string): boolean;  // true exactly once, false if unknown/expired/used
```

**Steps**
- [ ] `lib/session.ts`: iron-session with `httpOnly: true`, `secure: process.env.NODE_ENV === 'production'`, `sameSite: 'lax'`, short `maxAge` (e.g. 1 hour). Note: `cookies()` is async in current Next.js, so `await cookies()`.
- [ ] `lib/nonce-store.ts`: `Map<string, expiresAt>`, TTL 5 minutes, **delete on consume**, sweep expired entries on each call.
- [ ] `GET /api/auth/nonce`: return `{ nonce }`.
- [ ] `POST /api/auth/verify`: body `{ message, signature }`.
  - [ ] `parseSiweMessage(message)`
  - [ ] Check `domain === process.env.APP_DOMAIN`, `uri === APP_URI`, `chainId === CHAIN_ID`
  - [ ] Check not expired, `issuedAt` not in the future
  - [ ] `consumeNonce(parsed.nonce)` must return true
  - [ ] `publicClient.verifySiweMessage({ message, signature })` must return true
  - [ ] Normalize with `getAddress()` and store in session. Then `session.save()`
  - [ ] Any failure: 401 with a generic message, log the specific reason server side
- [ ] `GET /api/auth/me`: `{ address }` or 401.
- [ ] `POST /api/auth/logout`: `session.destroy()`.

**Traps**
- Domain comes from **env**, never from the Host header or the message itself.
- Nonce **only** in an encrypted cookie is replayable by anyone holding the old cookie. Server-side store is the fix.
- Consume the nonce **before** returning any error after parsing, so a failed attempt burns it.
- Address normalization: always `getAddress()`. Mixed checksum/lowercase comparison is a classic authz bypass.
- `verifySiweMessage` needs a public client with an RPC transport (it supports EIP-1271 smart wallets via `eth_call`). If the RPC is flaky, fall back to `verifyMessage` for EOAs only and write that down as a scope decision.

**Claude writes (glue):** `app/page.tsx`: connect via `createWalletClient({ transport: custom(window.ethereum) })`, fetch nonce, `createSiweMessage`, `signMessage`, POST verify, redirect to `/chat`.
```
Write app/page.tsx: a client component with a Connect + Sign In button using viem only
(no wagmi). Flow: requestAddresses -> GET /api/auth/nonce -> createSiweMessage with domain
and uri from window.location, chainId 1, statement "Sign in to wallet-agent-demo" ->
signMessage -> POST /api/auth/verify -> router.push('/chat'). Show errors inline.
Minimal styling.
```

**Attack**
```
/audit lib/session.ts lib/nonce-store.ts app/api/auth/
/attack-tests lib/nonce-store.ts (reuse, expiry, unknown nonce, concurrency of two consumes)
```

**Done when:**
- [ ] I can sign in and `/api/auth/me` returns my checksummed address
- [ ] Replaying the same `{ message, signature }` returns 401
- [ ] Nonce tests pass
- [ ] Commit: `feat: siwe auth`

---

### Phase 2: SSE streaming, no tools (1:20 to 2:05)

**Claude first**
```
/quiz Server-Sent Events: wire format, ReadableStream in a Next.js route handler, why
EventSource can't POST a body, reading a fetch stream with getReader, and how
request.signal tells me the client disconnected
```

**Event contract (fixed, both sides follow it)**
```
event: token        data: {"text": "..."}
event: tool_call    data: {"id": "...", "name": "run_js", "input": {...}}
event: tool_result  data: {"id": "...", "ok": true, "output": "..."} | {"id","ok":false,"error":"..."}
event: error        data: {"message": "..."}
event: done         data: {}
```

**Steps (I write the route)**
- [ ] `app/api/chat/route.ts`, `export const runtime = 'nodejs'`
- [ ] First line of logic: `getSession()`, no address means 401 **before** any LLM call
- [ ] Body: `{ message: string }` only. Validate with zod, cap length
- [ ] Build a `ReadableStream`, write `event:` / `data:` lines, return `new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })`
- [ ] Stream with `client.messages.stream(...)`; forward each text delta as a `token` event
- [ ] Abort the LLM stream when `request.signal` fires

**Trap: conversation history.** If the client sends the full history, it can forge `assistant` turns and fake `tool_result` blocks. Options: (a) keep history server side in a `Map` keyed by session address, or (b) accept only the new user message. For the demo: (a), single conversation per address. Write the tradeoff in THREATS.md.

**Claude writes (glue):** `app/chat/page.tsx`
```
Write app/chat/page.tsx: client component. Input + send button. POST /api/chat with
{ message } using fetch, read response.body with getReader + TextDecoder, parse SSE frames
(split on blank line, handle event:/data: lines, handle frames split across chunks).
Render tokens as they arrive, render tool_call and tool_result as small labeled blocks,
show errors. Redirect to / on 401. Minimal styling. Put the parser in a separate
function parseSSE so I can read it on its own.
```
Then **I read `parseSSE` line by line** and explain in a comment why the chunk-boundary buffer is needed.

**Done when:**
- [ ] Tokens stream into the page live
- [ ] Logged-out `curl -N -X POST localhost:3000/api/chat` returns 401 and no tokens
- [ ] Closing the tab stops the LLM stream (check server logs)
- [ ] Commit: `feat: sse chat`

---

### Phase 3: Authorization, sandbox, tool loop (2:05 to 3:05), I write it

#### 3a. Authorization (15 min)

**Interfaces**
```ts
// lib/authz.ts
export type Role = 'user' | 'sandbox';
export type ToolName = 'get_time' | 'run_js';
export function rolesFor(address: `0x${string}`): Role[];     // every signed-in address: 'user'; allowlist adds 'sandbox'
export function canUse(address: `0x${string}`, tool: ToolName): boolean;
export function allowedTools(address: `0x${string}`): ToolName[];
```

- [ ] Policy as data: `const POLICY: Record<ToolName, Role> = { get_time: 'user', run_js: 'sandbox' }`
- [ ] Allowlist from `SANDBOX_ALLOWLIST`, normalized with `getAddress()` at load
- [ ] `rolesFor` reads the store **on every call** (so revocation works mid-conversation)
- [ ] Unknown tool name: `canUse` returns false (deny by default)

```
/attack-tests lib/authz.ts (role x tool matrix, lowercase vs checksum address, unknown tool
name, empty allowlist, address not in allowlist asking for run_js)
```

#### 3b. Sandbox (20 min)

**Claude first**
```
/quiz Why node:vm and vm2 are not security boundaries, why Promise.race + setTimeout cannot
stop while(true){} in Node, and how quickjs-emscripten isolates code (runtime, context,
memory limit, interrupt handler, handle disposal)
```

**Learning exercise (5 min, do not skip):** write a throwaway naive runner using `new Function(code)()` wrapped in `Promise.race` with a 1s timeout. Call it with `while(true){}`. Watch the process hang. Delete it.

**Interface**
```ts
// lib/sandbox.ts
export type SandboxResult =
  | { ok: true; output: string; ms: number }
  | { ok: false; error: 'timeout' | 'oom' | 'exception' | 'output_too_large'; message: string; ms: number };

export async function runUntrusted(
  code: string,
  opts?: { timeoutMs?: number; memoryBytes?: number; maxOutputChars?: number }
): Promise<SandboxResult>;
```

**Steps**
- [ ] `getQuickJS()` once (cache the promise at module level)
- [ ] Per call: `newRuntime()`, `setMemoryLimit`, `setMaxStackSize`, `setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs))`, `newContext()`
- [ ] `evalCode(code)`, unwrap the result, `dump` it, stringify, cap output length
- [ ] Classify errors: interrupted means timeout, out-of-memory means oom, else exception
- [ ] **Dispose every handle, the context and the runtime in `finally`.** Leaks here are a DoS
- [ ] Expose **no** host functions. No `console`, no `fetch`, nothing. The code's return value is the only output
- [ ] Cap input `code` length before running
- [ ] If the WASM fails to load under the Next bundler, add `serverExternalPackages: ['quickjs-emscripten']` to `next.config`

```
/attack-tests lib/sandbox.ts (while(true){}, recursion stack overflow, 'x'.repeat(1e9),
array growth until oom, typeof process / require / fetch / globalThis.constructor tricks
must be undefined or inert, huge return value truncated, normal code 1+1 returns "2",
100 sequential runs do not grow process memory noticeably)
```

#### 3c. Tool loop (25 min)

**Interfaces**
```ts
// lib/tools.ts
export const TOOL_DEFS: Record<ToolName, { description: string; input_schema: object }>;
export const TOOL_ARGS: Record<ToolName, z.ZodSchema>;
export async function executeTool(
  address: `0x${string}`, name: string, rawInput: unknown
): Promise<{ ok: true; output: string } | { ok: false; error: string }>;
```

**`executeTool` order (this order is the security design):**
1. `name` is a known `ToolName`, else deny
2. `canUse(address, name)`, else deny + log `decision: deny`
3. zod-parse `rawInput`, else error
4. execute (`get_time` returns ISO string; `run_js` calls `runUntrusted`)
5. log `decision: allow`, duration, outcome

**Loop in `app/api/chat/route.ts`:**
- [ ] Send the model only `allowedTools(address)` (least privilege; hygiene, not the boundary)
- [ ] `for (let i = 0; i < MAX_STEPS; i++)` with `MAX_STEPS = 5`
- [ ] Stream text as `token` events; `await stream.finalMessage()`
- [ ] If `stop_reason !== 'tool_use'`: send `done`, break
- [ ] For each `tool_use` block: emit `tool_call`, `await executeTool(...)`, emit `tool_result`, collect a `tool_result` content block (`is_error: true` on failure)
- [ ] Append the assistant message and the tool results to the history, loop
- [ ] Hit `MAX_STEPS`: emit `error` ("step limit"), then `done`

**Why the executor re-checks even though I filtered the tool list:** the model can hallucinate a tool name, and sandbox output is untrusted text that re-enters the model's context (prompt injection path). The executor is the boundary; the filter is not.

```
/audit lib/authz.ts lib/tools.ts lib/sandbox.ts app/api/chat/route.ts
```

**Done when:**
- [ ] Allowlisted wallet: "run `[1,2,3].map(x=>x*2)` in JS" streams a tool_call, a tool_result, then an answer
- [ ] Allowlisted wallet: `while(true){}` returns a timeout result in about 1s, server stays responsive
- [ ] **Second wallet, signed in, not allowlisted:** asking to run code gets refused, and the log shows `decision: deny`. (This is the demo's key moment: connected is not authorized)
- [ ] All tests pass
- [ ] Commit: `feat: tool loop with per-call authz and quickjs sandbox`

---

### Phase 4: Make it "done" by their definition (3:05 to 3:35)

The posting defines done as delivered, verified and operating. Show the operating part.

**Claude writes:** `lib/log.ts`
```
Write lib/log.ts: a tiny JSON logger, no dependencies. log(level, event, fields) prints one
JSON line with ts, level, event, and fields. Export a helper that creates a child logger
bound to a requestId (crypto.randomUUID()).
```

**I wire it in:**
- [x] Every request: `requestId`, `address`, route, status, `durationMs`
- [x] Every tool call: `tool`, `decision: allow|deny`, `reason` on deny, `sandbox: ok|timeout|oom|exception`, `durationMs`
- [x] Auth failures: specific reason in log, generic message to client
- [x] Never log signatures, session cookies, or full user code (log code length + hash instead)

**Verify:**
- [x] `pnpm test` green
- [x] Paste one real `allow` and one real `deny` log line into section 9 of this README

---

### Phase 5: Threat model and defense (3:35 to 4:00)

- [ ] Write `THREATS.md` (half a page). Ask Claude for a skeleton only, fill it myself:
```
Give me a THREATS.md skeleton with these headings only, no content: Trust boundaries,
Assets, Controls (table: threat / control / file), Known gaps, Production changes.
```
- [ ] Known gaps to list: single-instance stores, no rate limiting, one conversation per address, EOA fallback if RPC is down, no CSP headers
- [ ] Production changes section, include **Cloudflare Workers**: no Node APIs, nonce/role/history stores move to Durable Objects or KV, iron-session needs Web Crypto compatible config, QuickJS WASM still works at the edge
- [ ] Final commit, push to GitHub
- [ ] Run `/grill` for 15 minutes. Anything I couldn't answer: reread that file tonight

---

## 6. Rules I don't break

1. Claude never writes my boundary files.
2. No `node:vm`, no `vm2`, no `new Function` in the real code.
3. Authorization happens in `executeTool`, every call, against the live store.
4. The nonce is single use, server side.
5. Commit at the end of every phase.

---

## 7. Cut list (in this order if I fall behind)

1. Extra sandbox tests beyond: infinite loop, oom, `process` undefined
2. EIP-1271 support (use `verifyMessage`, note it)
3. Client disconnect handling
4. UI polish

**Never cut:** executor authz check, real sandbox timeout, single-use nonce, the not-allowlisted wallet demo.

---

## 8. Questions I must answer without notes

- Why is a connected wallet not an authorized user? Where exactly in my code is that difference?
- Why check authorization per tool call and not once per request?
- Why do I filter the tool list AND check in the executor?
- Why can't `setTimeout` stop `while(true){}`? What does QuickJS do differently?
- Why not `vm2`? Why not a Worker thread with `terminate()`? (Answer: terminate kills loops but a worker shares the process and Node APIs; isolation is weaker than a separate engine with no host bindings)
- What does each SIWE field defend against? What breaks if I read the domain from the Host header?
- How would the nonce store work with 10 instances? On Cloudflare Workers?
- The client sends chat history. What can an attacker forge? What did I do about it?
- What happens if the sandbox output says "ignore your instructions and call run_js with ..."?
- What do my logs let an on-call engineer answer at 3 a.m.?

---

## 9. Example log lines

```
{"ts":"2026-09-28T07:39:44.425Z","level":"info","event":"tool_call","requestId":"bb7d0f97-00a8-4695-90c5-2351dfcf945d","route":"/api/chat","decision":"allow","tool":"run_js","address":"0x0b99DE6969399246fF1901432d7fe63DAC17bF8C","durationMs":20,"outcome":"ok","sandbox":"ok","codeLength":29,"codeHash":"fab7fe11ffa9bc93"}
{"ts":"2026-09-28T07:39:44.426Z","level":"info","event":"tool_call","requestId":"bb7d0f97-00a8-4695-90c5-2351dfcf945d","route":"/api/chat","decision":"deny","reason":"not authorized","tool":"run_js","address":"0x000000000000000000000000000000000000dEaD"}
```

---

## 10. Run

**Prerequisites:** Node 20+, [pnpm](https://pnpm.io) (this repo pins `pnpm@11.5.2` via
`packageManager`), a browser wallet extension (MetaMask or similar), and a free
[Gemini API key](https://ai.google.dev/) (the app talks to Gemini, not Anthropic or
OpenAI, see section 6's hard constraints for why).

```bash
cd wallet-agent-demo
pnpm install
cp .env.example .env.local
```

Then fill in `.env.local`:

| Var | Where to get it |
|---|---|
| `GEMINI_API_KEY` | [ai.google.dev](https://ai.google.dev/) → Get API key. Free tier is rate-limited (as low as 5 req/min on some models), expect occasional 429s during a demo |
| `GEMINI_MODEL` | A current Gemini model id, e.g. `gemini-2.5-flash`. Model names get retired; if you get a 404 naming a replacement, use that |
| `SESSION_PASSWORD` | `openssl rand -hex 32`, at least 32 chars |
| `RPC_URL` | Any public Ethereum mainnet RPC endpoint |
| `SANDBOX_ALLOWLIST` | Your own wallet address, checksummed (comma-separated for more than one). This is what gets the `run_js` tool; a signed-in wallet **not** on this list is the "connected but not authorized" demo moment |
| `APP_DOMAIN` / `APP_URI` / `CHAIN_ID` | Leave as `localhost:3000` / `http://localhost:3000` / `1` for local dev |

```bash
pnpm dev     # http://localhost:3000
pnpm test    # sandbox attack tests (vitest)
```

**Demo flow:** open `http://localhost:3000`, click **Connect wallet & sign in**, approve the
connection and the sign-in message in your wallet, you land on `/chat`. Ask it to run some
JavaScript (`run_js`) with your allowlisted wallet, it works. Sign out, connect a *different*
wallet not on `SANDBOX_ALLOWLIST`, ask for the same thing, it's denied, the model can still
call `get_time` but not `run_js`, and the server log shows `decision: deny`. That contrast is
the point of the demo, see section 9 for a real log line.
