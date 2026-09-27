import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function GET() {
  const session = await getSession();
  if (!session.address) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  return NextResponse.json({ address: session.address });
}
