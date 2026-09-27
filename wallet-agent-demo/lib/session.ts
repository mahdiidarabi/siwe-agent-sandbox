import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";

export type SessionData = {
  address?: `0x${string}`;
  chainId?: number;
  issuedAt?: number;
};

export const sessionOptions: SessionOptions = {
  cookieName: "wallet-agent-session",
  password: process.env.SESSION_PASSWORD!,
  // ttl also caps the cookie's max-age, so the cookie always expires with
  // (slightly before) the seal. Keep it short: this is a demo session, not
  // a long-lived login.
  ttl: 60 * 60,
  cookieOptions: {
    httpOnly: true, // never readable from document.cookie / XSS
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  },
};

export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}
