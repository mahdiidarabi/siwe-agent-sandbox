# THREATS.md

## Trust boundaries

- **Browser / wallet** (untrusted): every cookie, header, and SIWE field is attacker-controlled until verified server side.
- **LLM (Gemini)** (untrusted caller): can hallucinate tool names/args; never itself an authorization decision.
- **Sandbox output** (untrusted text): `run_js` output re-enters the model's context, a prompt-injection path back into the loop.
- **RPC provider** (external dependency): only trusted for EIP-1271/ERC-6492 contract-wallet checks; EOA signatures verify locally.
- **Server** (trusted): the only place authz decisions may be made.

## Assets

- Session cookie seal (`SESSION_PASSWORD`) — controls authentication.
- `SANDBOX_ALLOWLIST` — controls who gets code-execution.
- Nonce store — SIWE replay prevention.
- `GEMINI_API_KEY` — cost/quota; also an info-disclosure risk if raw provider errors reach the client.
- Server-side conversation history — integrity (client must not be able to forge assistant/tool turns).
- The host process itself — availability (a sandbox bug can crash it for every user, not just the caller).

## Controls

| Threat | Control | File |
| --- | --- | --- |
| Nonce replay | Single-use, delete-on-consume, TTL | `lib/nonce-store.ts` |
| Session cookie theft via XSS | `httpOnly` cookie | `lib/session.ts` |
| CSRF on logout | `sameSite: lax` | `lib/session.ts` |
| SIWE phishing / cross-domain replay | domain/uri checked against env, never request headers | `app/api/auth/verify/route.ts` |
| Mixed-case address authz bypass | `getAddress()` checksum normalization everywhere | `lib/authz.ts`, `app/api/auth/verify/route.ts` |
| Connected-but-unauthorized tool use | `canUse()` re-checked on every call, not just the offered tool list | `lib/tools.ts` |
| Arbitrary code execution / host escape | QuickJS, zero host bindings, memory/stack/time limits | `lib/sandbox.ts` |
| Sandbox resource exhaustion (loop/OOM) | Interrupt handler + memory limit; disposal wrapped so a crash there can't take the process down | `lib/sandbox.ts` |
| Unknown/hallucinated tool name | Deny by default | `lib/tools.ts` |
| Internal error detail leaking to client | Generic client message, real reason logged server side | `app/api/auth/verify/route.ts`, `app/api/chat/route.ts` |
| Client forging conversation history | History kept server side, keyed by session address | `app/api/chat/route.ts` |

## Known gaps

- Nonce/role/conversation stores are single-instance, in-memory `Map`s: no cross-instance consistency, wiped on restart.
- No rate limiting anywhere (confirmed live: hit both the 5 req/min and the 20/day free Gemini quota).
- No cap on conversation length; unbounded token cost, eventual context-length failure with no recovery.
- History can be left corrupted (a function call with no matching result) if a client disconnects mid tool-call, or two requests for the same address race, no lock, no reset path.
- No body-size limit on `/api/auth/verify` or `/api/chat` (no `proxy.ts` in this app).
- Sandbox error classification for OOM/exception is still substring-matched off the untrusted code's own thrown message, spoofable (the timeout half is no longer spoofable, fixed via an authoritative interrupt flag).
- `verifySiweMessage` defaults to `mode: 'auto'`, so every login, EOA included, makes a real RPC call; RPC downtime blocks all sign-ins, not just contract wallets. The EOA-only fallback this README's own Phase 1 trap called for was never implemented.
- `run_js` output is fed back to the model with no label marking it as untrusted; a sandboxed script could return text designed to look like new instructions.
- `SANDBOX_ALLOWLIST` is read once at process start; revoking an address needs a restart, not just the next tool call.
- No CSP or other security headers.

## Production changes

- Nonce/role/conversation stores → Redis, KV, or Durable Objects.
- Add rate limiting at the edge on `/api/auth/nonce`, `/api/auth/verify`, `/api/chat`.
- **Cloudflare Workers**: no Node APIs, this app currently sets `runtime: 'nodejs'` and imports `node:crypto` directly (`lib/log.ts`, `lib/nonce-store.ts`), both would need Web Crypto equivalents. `iron-session` would need its Web-standard cookie path (`webCookies`/`nextProxyCookies`), not the Node req/res one. QuickJS is pure WASM and should still run at the edge, but per-invocation CPU limits are stricter than a Node server and haven't been tested against them.
- Move off the free-tier Gemini key onto one with provisioned quota and alerting.
- Ship `lib/log.ts`'s output to a real log sink instead of stdout; surface `requestId` to the client (e.g. a response header) so a user report can be correlated to server logs.
- Add CSP and standard security headers.
- Decide and pin `verifySiweMessage`'s `mode` instead of defaulting to `auto`.
