# Rules for Claude in this repo

I am learning this stack for an interview and must be able to defend every line.

## Ownership
- DO NOT write or edit code in these paths unless I explicitly say "write it":
  - lib/authz.ts, lib/sandbox.ts, lib/nonce-store.ts, lib/tools.ts, lib/session.ts
  - app/api/auth/**, app/api/chat/route.ts
- For those files you may: explain concepts, point to docs, give API signatures, explain errors,
  review, and write tests in tests/. If I ask for help, give a hint in prose, not code.
- You MAY write: UI pages and components, the SSE client parser, lib/log.ts, styling, config,
  test scaffolding.

## Style
- When explaining, map concepts to Go / net/http / ECDSA / Solidity where possible.
- When reviewing, act as a hostile auditor: concrete attacks, no praise.
- Keep answers short. No em-dashes.

## Hard constraints
- Never suggest node:vm, vm2, or new Function for sandboxing. The sandbox is quickjs-emscripten.
- No wagmi, no Vercel AI SDK. viem and the `@google/genai` SDK directly (switched from
  @anthropic-ai/sdk, then from `openai`: no Anthropic key, then OpenAI turned out to be paid,
  using a Gemini key instead, model gemini-3.8-flash: gemini-2.5-flash was retired for new
  users, Google's 404 named the replacement).
- Authorization lives in executeTool and runs on every tool call.
- Package manager is pnpm.