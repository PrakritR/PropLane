import "server-only";
import { NextResponse } from "next/server";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { getServerSessionProfile } from "@/lib/auth/server-profile";
import { NumberBillingError } from "./subscription.server";
import type { NumberOwnerRole } from "./constants";

export type NumberOwner = { userId: string; email: string; role: NumberOwnerRole };

/**
 * The authenticated caller as a number owner: must HOLD the vendor or resident role in
 * `profile_roles` (never the legacy `profiles.role`). A multi-role account names the role it is
 * acting as, or the active portal decides. A "View as" session never spends the viewed account's money.
 */
export async function resolveNumberOwner(
  requestedRole?: unknown,
): Promise<{ ok: true; owner: NumberOwner } | { ok: false; status: 400 | 401 | 403; error: string }> {
  const session = await getServerSessionProfile();
  if (!session.user) return { ok: false, status: 401, error: "Unauthorized." };
  if (session.viewAs) return { ok: false, status: 403, error: "Not available while viewing another account." };
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return { ok: false, status: 401, error: "Unauthorized." };

  const held = (["vendor", "resident"] as const).filter((role) => hasRole(ctx, role));
  if (held.length === 0) return { ok: false, status: 403, error: "Only vendor and resident accounts can have a PropLane Number." };

  let role: NumberOwnerRole | null = null;
  if (requestedRole !== undefined && requestedRole !== null && requestedRole !== "") {
    if (requestedRole !== "vendor" && requestedRole !== "resident") return { ok: false, status: 400, error: "Invalid role." };
    if (!held.includes(requestedRole)) return { ok: false, status: 403, error: "You do not hold that role." };
    role = requestedRole;
  } else if (held.length === 1) {
    role = held[0]!;
  } else if (ctx.effectiveRole === "vendor" || ctx.effectiveRole === "resident") {
    role = ctx.effectiveRole;
  }
  if (!role) return { ok: false, status: 400, error: "Choose vendor or resident." };

  return {
    ok: true,
    owner: {
      userId: ctx.user.id,
      email: (ctx.profile?.email ?? ctx.user.email ?? "").trim().toLowerCase(),
      role,
    },
  };
}

const NO_STORE = { "Cache-Control": "private, no-store" };

export function numberJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function numberErrorResponse(error: unknown) {
  if (error instanceof NumberBillingError) {
    return numberJson({ ok: false, code: error.code, error: error.message }, error.status);
  }
  console.error("[number subscription] route error", error instanceof Error ? error.message : "unknown");
  return numberJson({ ok: false, code: "unavailable", error: "This is temporarily unavailable. Try again." }, 503);
}
