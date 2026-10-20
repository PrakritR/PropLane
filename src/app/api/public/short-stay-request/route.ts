import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Retired (captain, Oct 20): a website visitor books a short stay from inside the resident portal
 * (`/resident/stays/request`, `POST /api/resident/stays`, the session is the guest), and a texter books by text.
 * The anonymous public request, its guest-login minting and its add-on dry run are gone; anything still posting here
 * is told where to go instead.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "Booking requests are made in your resident portal. Sign in or create a resident account to request a stay.",
      signIn: "/auth/sign-in?intent=resident&next=%2Fresident%2Fstays%2Frequest",
      createAccount: "/auth/create-account?mode=create&role=resident&next=%2Fresident%2Fstays%2Frequest",
    },
    { status: 410, headers: { "Cache-Control": "private, no-store" } },
  );
}
