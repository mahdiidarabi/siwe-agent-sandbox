import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { createRequestLogger } from "@/lib/log";

export async function POST() {
  const started = Date.now();
  const logger = createRequestLogger({ route: "/api/auth/logout" });

  const session = await getSession();
  const address = session.address; // read before destroy() clears it
  session.destroy();

  logger.info("request", { status: 200, address, durationMs: Date.now() - started });
  return NextResponse.json({ ok: true });
}
