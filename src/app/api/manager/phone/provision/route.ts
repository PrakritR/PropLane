import { NextResponse } from "next/server";
export const runtime = "nodejs";

/**
 * POST — provision (or reuse) the signed-in manager's Axis SMS work number.
 * Idempotent: returns the existing number when one is already provisioned.
 * An optional 3-digit `areaCode` biases the search; otherwise Twilio picks.
 */
export async function POST(req: Request) {
  void req;
  return NextResponse.json(
    { error: "Use Settings → Messaging to request a work number." },
    { status: 410 },
  );
}
