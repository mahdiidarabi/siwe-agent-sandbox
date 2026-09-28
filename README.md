# wallet-agent-demo

Sign in with an Ethereum wallet, then chat with an LLM that can run real tools, one of which
executes untrusted JavaScript in an actual sandbox (QuickJS compiled to WASM, not `eval`, not
`vm2`). Every tool call is authorized server side, on every call, against a live role store, not
once at the API boundary. A signed-in wallet is not automatically an authorized one, and the demo
proves it.

**Stack:** Next.js (App Router) · TypeScript · viem (Sign-In With Ethereum, EIP-4361) · Gemini
(streamed tool-calling over SSE) · QuickJS/WASM sandbox · iron-session · Zod

## What's interesting here

- **A real sandbox, not a trust exercise.** `run_js` runs in a separate QuickJS engine compiled
  to WASM with no host bindings. `console`, `fetch`, `require` don't exist there, they're not
  blocked, they were simply never given anything to bind to. Memory, stack, and time limits are
  enforced by the engine itself, verified with real attack tests, not just asserted.
- **Authorization checked on every tool call, not once.** The model is only ever offered the
  tools an address is allowed to use, but that's hygiene, not the boundary. The real check runs
  again inside the executor on every single call, because an LLM can hallucinate a tool name it
  was never offered.
- **SIWE done properly.** A server-issued, single-use nonce; domain/URI checked against server
  config, never the request's own headers; an `httpOnly` session cookie.
- **A hand-rolled SSE tool loop** that survives a network read landing mid-frame, not just the
  happy path, and correctly propagates a client disconnect to cancel the upstream LLM call.
- **Shipped with a real audit.** [`THREATS.md`](wallet-agent-demo/THREATS.md) documents actual
  bugs found and fixed while building this, a sandbox crash bug, a spoofable timeout
  classification, a history-corruption path, not a boilerplate checklist.

## Run it

```bash
cd wallet-agent-demo
pnpm install
cp .env.example .env.local   # fill in your Gemini key, an RPC URL, and your wallet address
pnpm dev                     # http://localhost:3000
```

Full setup detail, where to get each env var, and a walkthrough of the actual demo flow: see
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md#10-run).

## More

- **How it works, file by file, with code references:** [`wallet-agent-demo/README.md`](wallet-agent-demo/README.md)
- **Threat model:** [`wallet-agent-demo/THREATS.md`](wallet-agent-demo/THREATS.md)
- **The full build plan this project followed, phase by phase:** [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)
