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

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default function ChatPage() {
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then(async (res) => {
        if (res.status === 401) {
          router.push("/");
          return;
        }
        const data = (await res.json()) as { address: string };
        setAddress(data.address);
      })
      .catch(() => {});
  }, [router]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/");
  }

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

  // True the instant a message is sent, false the moment anything at all
  // comes back for it, so the "thinking" indicator only shows during the
  // genuine gap before the first token/tool_call/error.
  const waitingForFirstEvent = busy && turns[turns.length - 1]?.kind === "user";

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-black">
      <header className="flex items-center justify-between border-b border-black/[.08] px-4 py-3 sm:px-6 dark:border-white/[.08]">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
              <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
              <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-black dark:text-zinc-50">wallet-agent-demo</span>
        </div>
        <div className="flex items-center gap-3">
          {address && (
            <span className="hidden rounded-full bg-zinc-100 px-3 py-1 font-mono text-xs text-zinc-600 sm:inline dark:bg-zinc-900 dark:text-zinc-400">
              {truncateAddress(address)}
            </span>
          )}
          <button
            onClick={signOut}
            className="text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            Sign out
          </button>
        </div>
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-end gap-2.5 px-4 py-6 sm:px-6">
          {turns.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <p className="text-sm text-zinc-500 dark:text-zinc-500">
                Say something. Try asking for the time, or to run some JavaScript.
              </p>
            </div>
          )}
          {turns.map((turn, i) => (
            <Turn key={i} turn={turn} />
          ))}
          {waitingForFirstEvent && <ThinkingBubble />}
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="border-t border-black/[.08] bg-white px-4 py-3 dark:border-white/[.08] dark:bg-zinc-950"
      >
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            placeholder="Message"
            className="flex-1 rounded-full border border-black/[.08] bg-white px-4 py-2 text-sm text-black transition-shadow focus:outline-none focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-60 dark:border-white/[.1] dark:bg-zinc-950 dark:text-zinc-50"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Send"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-400"
          >
            {busy ? (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4Z" />
              </svg>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-zinc-100 px-4 py-3 dark:bg-zinc-900">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-600"
            style={{ animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

function Turn({ turn }: { turn: ChatTurn }) {
  if (turn.kind === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[80%] rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2 text-sm break-words text-white dark:bg-indigo-500">
          {turn.text}
        </p>
      </div>
    );
  }
  if (turn.kind === "assistant") {
    return (
      <div className="flex justify-start">
        <p className="max-w-[80%] rounded-2xl rounded-bl-sm bg-zinc-100 px-4 py-2 text-sm break-words whitespace-pre-wrap text-black dark:bg-zinc-900 dark:text-zinc-50">
          {turn.text}
        </p>
      </div>
    );
  }
  if (turn.kind === "tool_call") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-lg border-l-2 border-amber-400 bg-amber-50 px-3 py-1.5 font-mono text-xs break-all text-amber-800 dark:border-amber-500 dark:bg-amber-500/10 dark:text-amber-300">
          <span className="font-semibold">{turn.name}</span>({JSON.stringify(turn.input)})
        </div>
      </div>
    );
  }
  if (turn.kind === "tool_result") {
    return (
      <div className="flex justify-start">
        <div
          className={
            turn.ok
              ? "max-w-[85%] rounded-lg border-l-2 border-emerald-400 bg-emerald-50 px-3 py-1.5 font-mono text-xs break-all text-emerald-800 dark:border-emerald-500 dark:bg-emerald-500/10 dark:text-emerald-300"
              : "max-w-[85%] rounded-lg border-l-2 border-red-400 bg-red-50 px-3 py-1.5 font-mono text-xs break-all text-red-800 dark:border-red-500 dark:bg-red-500/10 dark:text-red-300"
          }
        >
          → {turn.ok ? turn.output : `error: ${turn.error}`}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-center">
      <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
        {turn.message}
      </p>
    </div>
  );
}
