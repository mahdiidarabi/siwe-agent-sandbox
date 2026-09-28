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
const conversations = new Map<string, Content[]>();

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
          send("error", { message: err instanceof Error ? err.message : "internal error" });
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
