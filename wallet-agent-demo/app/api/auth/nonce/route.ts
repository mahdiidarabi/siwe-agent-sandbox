import { NextResponse } from "next/server";
import { issueNonce } from "@/lib/nonce-store";
import { createRequestLogger } from "@/lib/log";

export async function GET() {
  const started = Date.now();
  const logger = createRequestLogger({ route: "/api/auth/nonce" });

  const nonce = issueNonce();

  logger.info("request", { status: 200, durationMs: Date.now() - started });
  return NextResponse.json({ nonce });
}
