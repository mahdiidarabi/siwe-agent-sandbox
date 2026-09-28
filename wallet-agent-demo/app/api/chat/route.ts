import { GoogleGenAI, type Content, type FunctionCall } from "@google/genai";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { allowedTools } from "@/lib/authz";
import { TOOL_DEFS, executeTool } from "@/lib/tools";

export const runtime = "nodejs";

const bodySchema = z.object({
  message: z.string().min(1).max(4000),
});

const MAX_STEPS = 5;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Trap (README Phase 2): if the client sent its own history, it could forge
// model turns or fake function results. History lives server side instead,
// keyed by session address. Single conversation per address, an in-memory
// scope decision matching the nonce/role stores.
//
// TODO(audit), all unfixed, need a design decision rather than a silent
// rewrite:
//  - No cap on message count or total size per conversation. Every request
//    re-sends the full history to Gemini, unbounded token cost, and
//    eventually a context-length failure with no recovery path (see next
//    point).
//  - If the client disconnects (or anything else throws) between pushing
//    the model's turn (below, functionCall parts included) and pushing the
//    matching functionResponse turn from the tool loop, history is left
//    with a dangling unanswered function call. Every future request in that
//    conversation then gets rejected by Gemini. There's no reset endpoint
//    and no TTL, so this is permanent short of restarting the whole server
//    (which wipes every user's history, not just the broken one).
//  - No per-address lock: two concurrent requests for the same address
//    (double-click, two tabs) both read/push into the same array with no
//    mutual exclusion, interleaving turns into a shape Gemini will reject.
const conversations = new Map<string, Content[]>();

// TODO(audit): no rate limiting on this route, and it shares one
// GoogleGenAI client (below) across every user. Confirmed live: the key in
// use is free-tier, 5 requests/minute. Any single signed-in user (even
// without the sandbox role, get_time alone is enough) can exhaust that for
// everyone. Left unfixed on purpose: README section 2 lists rate limiting
// as an explicit, accepted scope cut, not an oversight, so this isn't
// silently added here.

function frame(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session.address) {
    return new Response(JSON.stringify({ error: "not signed in" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const address = session.address;

  // TODO(audit): unbounded request body. Next route handlers have no
  // default body-size cap without a proxy.ts, which this app doesn't have,
  // so request.json() buffers the entire body in memory before the
  // message field's .max(4000) below ever gets a chance to reject it. Same
  // unresolved root cause as the /api/auth/verify finding from the Phase 1
  // audit; a real fix belongs at the project level (a shared body-size
  // guard), not duplicated ad hoc per route.
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return new Response(JSON.stringify({ error: "invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const history = conversations.get(address) ?? [];
  conversations.set(address, history);
  history.push({ role: "user", parts: [{ text: body.data.message }] });

  const tools = [
    {
      functionDeclarations: allowedTools(address).map((name) => ({
        name,
        description: TOOL_DEFS[name].description,
        parametersJsonSchema: TOOL_DEFS[name].input_schema,
      })),
    },
  ];

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(event: string, data: unknown) {
        try {
          controller.enqueue(encoder.encode(frame(event, data)));
        } catch {
          // client is already gone; nothing more to write
        }
      }

      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          if (request.signal.aborted) return;

          // Note: abortSignal only stops the client from reading further;
          // per @google/genai's own docs it does not cancel billing on
          // Google's side. request.signal still saves us from streaming
          // tokens into a dead connection and from running further tool
          // steps for a client that's gone.
          // Accumulate the raw Part objects Gemini returns, not a
          // hand-rebuilt version. A functionCall part can carry a
          // thoughtSignature that must be echoed back verbatim on the next
          // turn, reconstructing `{ functionCall: call }` from just the
          // FunctionCall sub-object (via the .functionCalls getter) drops
          // that field, and the follow-up call then fails with a 400:
          // "Function call is missing a thought_signature in functionCall
          // parts." (confirmed live). Keeping the parts as-is avoids it.
          let modelParts: NonNullable<Content["parts"]> = [];

          // @google/genai's stream parser has a confirmed, non-deterministic
          // bug: it can throw "Incomplete JSON segment at the end" mid-
          // stream (reproduced independently of our code, ~2 times in 5
          // real calls). If it fires before anything has reached the
          // client for this turn, silently retry, that's what "nothing
          // happened" in the UI actually was. Once partial text has been
          // sent, retrying would duplicate/confuse it, so let it surface
          // as an error instead. Retry is narrowed to this specific bug:
          // blindly retrying a 429 (the free tier is 5 req/min) or a 503
          // would just burn more of an already-exhausted quota for a
          // guaranteed second failure.
          const MAX_ATTEMPTS = 3;
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (request.signal.aborted) return;
            modelParts = [];
            let sentAnyOutput = false;

            try {
              const responseStream = await ai.models.generateContentStream({
                model: MODEL,
                contents: history,
                config: { tools, abortSignal: request.signal },
              });

              for await (const chunk of responseStream) {
                if (request.signal.aborted) return;
                const parts = chunk.candidates?.[0]?.content?.parts ?? [];
                for (const part of parts) {
                  modelParts.push(part);
                  if (part.text) {
                    sentAnyOutput = true;
                    send("token", { text: part.text });
                  }
                }
              }
              break;
            } catch (err) {
              if (request.signal.aborted) return;
              const isKnownStreamParsingBug =
                err instanceof Error && err.message.includes("Incomplete JSON segment");
              const canRetry = isKnownStreamParsingBug && !sentAnyOutput && attempt < MAX_ATTEMPTS;
              if (!canRetry) throw err;
            }
          }

          if (modelParts.length === 0) {
            // A fully safety-filtered response (or similar) can come back
            // with no parts at all. Don't push a degenerate empty-parts
            // model turn, an untested edge case for yet another way to
            // wedge this conversation for good (see the TODO on
            // `conversations` above).
            send("error", { message: "the model returned no content for this turn" });
            send("done", {});
            return;
          }

          const functionCalls = modelParts
            .map((part) => part.functionCall)
            .filter((call): call is FunctionCall => call != null);

          history.push({ role: "model", parts: modelParts });

          if (functionCalls.length === 0) {
            send("done", {});
            return;
          }

          const responseParts: NonNullable<Content["parts"]> = [];
          for (const call of functionCalls) {
            // TODO(audit): the model turn above (with its functionCall
            // parts) is already in `history`. Returning here, before the
            // matching functionResponse turn is pushed below, leaves a
            // dangling unanswered function call in `history` permanently
            // (see the TODO on `conversations`). This is the single most
            // likely trigger: a user asking for a tool call and closing
            // the tab before it finishes, no malice required.
            if (request.signal.aborted) return;

            const name = call.name ?? "";
            const id = call.id ?? name;
            const input = call.args ?? {};

            send("tool_call", { id, name, input });
            const result = await executeTool(address, name, input);
            send(
              "tool_result",
              result.ok
                ? { id, ok: true, output: result.output }
                : { id, ok: false, error: result.error },
            );

            responseParts.push({
              functionResponse: {
                id: call.id,
                name,
                response: result.ok ? { output: result.output } : { error: result.error },
              },
            });
          }

          // Gemini has no separate "tool" role: a function result is a
          // 'user' turn carrying functionResponse parts (Content.role only
          // ever accepts 'user' or 'model').
          history.push({ role: "user", parts: responseParts });
        }

        send("error", { message: "step limit" });
        send("done", {});
      } catch (err) {
        if (!request.signal.aborted) {
          // Log the real reason server side; send a generic one to the
          // client. Same split as app/api/auth/verify/route.ts's deny().
          // This used to send the raw error message straight to the
          // client with no server-side log at all, confirmed live to leak
          // operator-side detail (e.g. Gemini's quota/billing error text
          // naming the exact free-tier metric and project) to whoever was
          // chatting, while leaving the operator with zero visibility into
          // the same failure.
          console.error("chat stream error:", err instanceof Error ? err.message : String(err));
          send("error", { message: "something went wrong, try again" });
        }
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
