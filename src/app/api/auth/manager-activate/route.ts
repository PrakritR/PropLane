import { NextResponse } from "next/server";

/** Manager IDs and email addresses are not purchase-claim capabilities. */
export async function POST() {
  return NextResponse.json({ error: "Use your original checkout or signup link to continue." }, { status: 410 });
}
