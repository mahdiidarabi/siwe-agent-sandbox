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
  idle: "Connect + Sign In",
  connecting: "Connecting wallet...",
  signing: "Waiting for signature...",
  verifying: "Verifying...",
};

export default function Home() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

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
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-sm flex-col items-center gap-6 rounded-xl border border-black/[.08] bg-white px-8 py-12 text-center dark:border-white/[.145] dark:bg-zinc-950">
        <h1 className="text-xl font-semibold text-black dark:text-zinc-50">
          wallet-agent-demo
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Sign in with Ethereum to start a chat session.
        </p>
        <button
          onClick={connectAndSignIn}
          disabled={status !== "idle"}
          className="flex h-11 w-full items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
        >
          {STATUS_LABEL[status]}
        </button>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </main>
    </div>
  );
}
