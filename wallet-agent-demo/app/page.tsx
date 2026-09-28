"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createWalletClient, custom } from "viem";
import { mainnet } from "viem/chains";
import { createSiweMessage } from "viem/siwe";

// Minimal EIP-1193 shape so we don't need `any` for window.ethereum.
type EIP1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

type Status = "idle" | "connecting" | "signing" | "verifying";

const STATUS_LABEL: Record<Status, string> = {
  idle: "Connect wallet & sign in",
  connecting: "Connecting wallet…",
  signing: "Waiting for signature…",
  verifying: "Verifying…",
};

export default function Home() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = status !== "idle";

  async function connectAndSignIn() {
    setError(null);

    if (!window.ethereum) {
      setError("No wallet found. Install MetaMask or a compatible extension.");
      return;
    }

    try {
      const walletClient = createWalletClient({
        chain: mainnet,
        transport: custom(window.ethereum),
      });

      // 1. Ask the wallet for an address (triggers eth_requestAccounts).
      setStatus("connecting");
      const [address] = await walletClient.requestAddresses();

      // 2. Get a fresh, single-use nonce from the server.
      const nonceRes = await fetch("/api/auth/nonce");
      if (!nonceRes.ok) throw new Error("Could not fetch nonce.");
      const { nonce } = (await nonceRes.json()) as { nonce: string };

      // 3. Build the SIWE message. domain/uri come from the browser location,
      // not from the server, so the wallet UI shows the site the user is
      // actually on. The server independently checks these against env vars.
      const message = createSiweMessage({
        address,
        chainId: 1,
        domain: window.location.host,
        uri: window.location.origin,
        version: "1",
        statement: "Sign in to wallet-agent-demo",
        nonce,
      });

      // 4. Sign it. This is the only step that proves control of the key.
      setStatus("signing");
      const signature = await walletClient.signMessage({ account: address, message });

      // 5. Hand message + signature to the server. It re-derives the signer,
      // checks domain/uri/chainId/expiry, and consumes the nonce.
      setStatus("verifying");
      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });

      if (!verifyRes.ok) {
        const body = (await verifyRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Sign-in failed.");
      }

      router.push("/chat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("idle");
    }
  }

  return (
    <div className="relative flex min-h-screen flex-1 flex-col items-center justify-center overflow-hidden bg-zinc-50 px-4 dark:bg-black">
      {/* Soft accent glow behind the card, pure CSS, no image assets. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-1/2 h-[32rem] w-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-500/10 blur-3xl dark:bg-indigo-500/15"
      />

      <main className="relative flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl border border-black/[.08] bg-white px-8 py-10 text-center shadow-xl shadow-black/[.03] dark:border-white/[.08] dark:bg-zinc-950 dark:shadow-black/20">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
            <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
            <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
          </svg>
        </div>

        <div className="flex flex-col gap-1.5">
          <h1 className="text-lg font-semibold tracking-tight text-black dark:text-zinc-50">
            wallet-agent-demo
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Sign in with Ethereum to start a chat session backed by your wallet.
          </p>
        </div>

        <button
          onClick={connectAndSignIn}
          disabled={busy}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-full bg-indigo-600 px-5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-indigo-500 dark:hover:bg-indigo-400"
        >
          {busy && (
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z" />
            </svg>
          )}
          {STATUS_LABEL[status]}
        </button>

        {error && (
          <p
            role="alert"
            className="w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-left text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400"
          >
            {error}
          </p>
        )}

        <p className="text-xs text-zinc-400 dark:text-zinc-600">Ethereum mainnet · no gas, message signing only</p>
      </main>
    </div>
  );
}
