import { NextResponse } from "next/server";
import { issueNonce } from "@/lib/nonce-store";

export async function GET() {
  const nonce = issueNonce();
  return NextResponse.json({ nonce });
}
