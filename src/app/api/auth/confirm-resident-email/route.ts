import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** An email address alone is not proof of ownership. */
export async function POST() {
  return NextResponse.json({ error: "Use the verification link sent to your email.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });
}
