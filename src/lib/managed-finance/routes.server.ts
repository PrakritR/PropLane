import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { resolveRouteSessionUser } from "@/lib/auth/route-actor.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { LedgerError } from "@/lib/managed-finance/ledger.server";
import { PolicyError, listManagedWorkspacesForOwner, type OwnedManagedWorkspace } from "@/lib/owner-management/policies.server";

export type ManagedOwnerContext = {
  db: SupabaseClient;
  userId: string;
  email: string;
  workspaces: OwnedManagedWorkspace[];
};

/**
 * The one gate for `/api/owner/finances/*`. The person is the session. What they may touch is exactly the managed workspaces
 * where they are the owner of record: read fresh on every call, so a person who is no longer the owner of record is refused on
 * the very next request. Nothing in a request names an owner, and nothing here is a signing surface - a fee policy is
 * PropLane's own rate, never an agreement the owner is asked to accept.
 */
export async function requireManagedOwner(): Promise<ManagedOwnerContext | NextResponse> {
  // A failed READ of the session is a retryable 503, never a 401 that signs the owner out (route-actor.server.ts).
  const session = await resolveRouteSessionUser({ route: "owner-finances" });
  if (!session.ok) return NextResponse.json({ error: session.error }, { status: session.status });
  const user = session.user;
  const db = createSupabaseServiceRoleClient();
  try {
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  } catch {
    return NextResponse.json({ error: "PropLane could not check your sign-in. Try again." }, { status: 503 });
  }
  let workspaces: OwnedManagedWorkspace[];
  try {
    workspaces = await listManagedWorkspacesForOwner(db, user.id);
  } catch {
    return NextResponse.json({ error: "Could not load your finances." }, { status: 500 });
  }
  if (workspaces.length === 0) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  return { db, userId: user.id, email: user.email ?? "", workspaces };
}

export function stripeOrNull(): Stripe | null {
  try {
    return getStripe();
  } catch {
    return null;
  }
}

export function financeErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof PolicyError || error instanceof LedgerError) {
    return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
  }
  console.error("[managed-finance]", error instanceof Error ? error.name : "unknown");
  return NextResponse.json({ error: fallback }, { status: 500 });
}
