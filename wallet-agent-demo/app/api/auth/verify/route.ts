import { NextResponse } from "next/server";
import { z } from "zod";
import { createPublicClient, getAddress, http } from "viem";
import { mainnet } from "viem/chains";
import { parseSiweMessage, verifySiweMessage } from "viem/siwe";
import { consumeNonce } from "@/lib/nonce-store";
import { getSession } from "@/lib/session";

const bodySchema = z.object({
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

// Only used to verify signatures (ECDSA recovery locally, ERC-6492/EIP-1271
// via eth_call for contract wallets). No writes ever go through this.
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.RPC_URL),
});

// Every failure looks identical to the client. The real reason goes to the
// server log only, see README trap: "Any failure: 401 with a generic
// message, log the specific reason server side."
function deny(reason: string) {
  console.error("siwe verify denied:", reason);
  return NextResponse.json({ error: "sign-in failed" }, { status: 401 });
}

export async function POST(request: Request) {
  const rawBody = await request.json().catch(() => null);
  const body = bodySchema.safeParse(rawBody);
  if (!body.success) return deny("malformed request body");

  const { message, signature } = body.data;
  const parsed = parseSiweMessage(message);

  if (!parsed.nonce) return deny("message has no nonce");

  // Consume before any other check: a failed attempt still burns the
  // nonce, so the same nonce can't be retried after a rejected attempt.
  if (!consumeNonce(parsed.nonce)) return deny("unknown, expired, or reused nonce");

  if (!parsed.address) return deny("message has no address");

  // domain/uri/chainId are checked against our own env, never against the
  // request's Host/Origin header or anything else the caller supplies:
  // that would be comparing attacker-controlled data to itself.
  if (parsed.domain !== process.env.APP_DOMAIN) return deny("domain mismatch");
  if (parsed.uri !== process.env.APP_URI) return deny("uri mismatch");
  if (parsed.chainId !== Number(process.env.CHAIN_ID)) return deny("chainId mismatch");

  // viem's validateSiweMessage (called inside verifySiweMessage) checks
  // expirationTime/notBefore against now, but not issuedAt. A message
  // claiming to be issued in the future is malformed input, reject it.
  if (parsed.issuedAt && parsed.issuedAt.getTime() > Date.now()) {
    return deny("issuedAt is in the future");
  }

  let signatureIsValid: boolean;
  try {
    // Re-checks domain/nonce/expiry internally, then recovers the signer
    // and verifies the ECDSA signature (or EIP-1271 eth_call for a
    // contract wallet).
    signatureIsValid = await verifySiweMessage(publicClient, {
      message,
      signature: signature as `0x${string}`,
      address: parsed.address,
      domain: process.env.APP_DOMAIN,
      nonce: parsed.nonce,
    });
  } catch (err) {
    return deny(`verifySiweMessage threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!signatureIsValid) return deny("invalid signature");

  // Always compare/store the checksummed form. Mixed-case vs lowercase
  // address comparisons are a classic authz bypass.
  const address = getAddress(parsed.address);

  const session = await getSession();
  session.address = address;
  session.chainId = parsed.chainId;
  session.issuedAt = Date.now();
  await session.save();

  return NextResponse.json({ address });
}
