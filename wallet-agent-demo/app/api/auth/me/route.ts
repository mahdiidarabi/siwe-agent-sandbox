import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { createRequestLogger } from "@/lib/log";

export async function GET() {
  const started = Date.now();
  const logger = createRequestLogger({ route: "/api/auth/me" });

  const session = await getSession();
  if (!session.address) {
    logger.info("request", { status: 401, durationMs: Date.now() - started });
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  logger.info("request", { status: 200, address: session.address, durationMs: Date.now() - started });
  return NextResponse.json({ address: session.address });
}
