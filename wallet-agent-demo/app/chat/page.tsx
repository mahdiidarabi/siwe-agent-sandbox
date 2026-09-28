"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type SSEEvent = { event: string; data: string };

// Pure and stateless on purpose: takes everything read so far, returns the
// complete frames it can find plus whatever incomplete tail to keep
// buffering. A network read is not guaranteed to land on a frame boundary
// (it can split one frame across reads, or deliver several in one read), so
// the caller re-feeds `remainder` back in on the next chunk.
export function parseSSE(buffer: string): { events: SSEEvent[]; remainder: string } {
  const frames = buffer.split("\n\n");
  const remainder = frames.pop() ?? "";
  const events: SSEEvent[] = [];

  for (const frame of frames) {
    if (!frame.trim()) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        // Per the SSE spec, strip exactly one leading space after the
        // colon if present, not all whitespace, the payload could have
        // meaningful leading spaces of its own.
        dataLines.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
      }
    }
    events.push({ event, data: dataLines.join("\n") });
  }

  return { events, remainder };
}

type ChatTurn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; ok: boolean; output?: string; error?: string }
  | { kind: "error"; message: string };

export default function ChatPage() {
  const router = useRouter();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => {
        if (res.status === 401) router.push("/");
      })
      .catch(() => {});
  }, [router]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns]);

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setTurns((t) => [...t, { kind: "user", text: message }]);

    let assistantIndex = -1;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      if (res.status === 401) {
        router.push("/");
        return;
      }

      if (!res.ok || !res.body) {
        setTurns((t) => [...t, { kind: "error", message: `request failed (${res.status})` }]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = parseSSE(buffer);
        buffer = remainder;

        for (const evt of events) {
          if (evt.event === "token") {
            const { text } = JSON.parse(evt.data) as { text: string };
            setTurns((t) => {
              if (assistantIndex === -1) {
                assistantIndex = t.length;
                return [...t, { kind: "assistant", text }];
              }
              return t.map((turn, i) =>
                i === assistantIndex && turn.kind === "assistant"
                  ? { ...turn, text: turn.text + text }
                  : turn,
              );
            });
          } else if (evt.event === "tool_call") {
            const data = JSON.parse(evt.data) as { id: string; name: string; input: unknown };
            setTurns((t) => [...t, { kind: "tool_call", ...data }]);
          } else if (evt.event === "tool_result") {
            const data = JSON.parse(evt.data) as { id: string; ok: boolean; output?: string; error?: string };
            setTurns((t) => [...t, { kind: "tool_result", ...data }]);
          } else if (evt.event === "error") {
            const data = JSON.parse(evt.data) as { message: string };
            setTurns((t) => [...t, { kind: "error", message: data.message }]);
          } else if (evt.event === "done") {
            assistantIndex = -1;
          }
        }
      }
    } catch (err) {
      setTurns((t) => [
        ...t,
        { kind: "error", message: err instanceof Error ? err.message : "connection lost" },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 bg-zinc-50 p-6 font-sans dark:bg-black">
      <h1 className="text-lg font-semibold text-black dark:text-zinc-50">wallet-agent-demo chat</h1>

      <div
        ref={listRef}
        className="flex flex-1 flex-col gap-2 overflow-y-auto rounded-lg border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
      >
        {turns.length === 0 && (
          <p className="text-sm text-zinc-500">
            Say something. Try asking for the time, or to run some JavaScript.
          </p>
        )}
        {turns.map((turn, i) => (
          <Turn key={i} turn={turn} />
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          placeholder="Message"
          className="flex-1 rounded-full border border-black/[.08] bg-white px-4 py-2 text-sm text-black dark:border-white/[.145] dark:bg-zinc-950 dark:text-zinc-50"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background disabled:opacity-60"
        >
          {busy ? "..." : "Send"}
        </button>
      </form>
    </div>
  );
}

function Turn({ turn }: { turn: ChatTurn }) {
  if (turn.kind === "user") {
    return (
      <p className="text-sm text-black dark:text-zinc-50">
        <span className="font-medium">You: </span>
        {turn.text}
      </p>
    );
  }
  if (turn.kind === "assistant") {
    return (
      <p className="text-sm text-black dark:text-zinc-50">
        <span className="font-medium">Assistant: </span>
        {turn.text}
      </p>
    );
  }
  if (turn.kind === "tool_call") {
    return (
      <p className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        tool_call {turn.name}({JSON.stringify(turn.input)})
      </p>
    );
  }
  if (turn.kind === "tool_result") {
    return (
      <p
        className={
          turn.ok
            ? "rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
            : "rounded bg-red-100 px-2 py-1 text-xs text-red-900 dark:bg-red-950 dark:text-red-200"
        }
      >
        tool_result {turn.ok ? turn.output : `error: ${turn.error}`}
      </p>
    );
  }
  return <p className="text-xs text-red-600 dark:text-red-400">error: {turn.message}</p>;
}
