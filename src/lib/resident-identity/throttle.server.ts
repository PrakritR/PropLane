import "server-only";
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";

/**
 * One budget for every resident identity write (start, retry, manual review): 10 a minute per signed-in resident.
 * Returns the refusal to send, or null when the caller may proceed. An unavailable limiter fails closed.
 */
export async function residentIdentityThrottle(userId: string): Promise<NextResponse | null> {
  const result = await rateLimit(`resident-identity:${userId}`, 10, 60_000);
  if (result.ok) return null;
  if (result.unavailable) return NextResponse.json({ error: "Verification is unavailable." }, { status: 503 });
  return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429, headers: { "Retry-After": "60" } });
}
