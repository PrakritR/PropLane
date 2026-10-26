import { getAdminPreviewFromCookies, isAdminUser } from "@/lib/auth/admin-preview";
import { getEffectiveUserIdForPortal } from "@/lib/auth/effective-session";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import type { AuthRole } from "@/lib/auth/portal-roles";

export type VendorApiActor = {
  userId: string;
  email: string;
  fullName: string;
  admin: boolean;
  roles: AuthRole[];
  effectiveRole: AuthRole | null;
};

/** Vendor API routes must allow multi-role users (profile_roles), not only profiles.role. */
export async function requireVendorApiAccess(): Promise<
  | { ok: true; actor: VendorApiActor }
  | { ok: false; status: 401 | 403 }
> {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return { ok: false, status: 401 };
  if (!hasRole(ctx, "vendor")) return { ok: false, status: 403 };

  const admin = await isAdminUser(ctx.user.id);
  return {
    ok: true,
    actor: {
      userId: ctx.user.id,
      email: (ctx.profile?.email ?? ctx.user.email ?? "").trim().toLowerCase(),
      fullName: ctx.profile?.full_name?.trim() ?? "",
      admin,
      roles: ctx.roles,
      effectiveRole: ctx.effectiveRole,
    },
  };
}

/**
 * Vendor-scoped user id for self-service routes (documents, availability, tax profile).
 * Supports multi-role users (profile_roles) and admin preview of a vendor account.
 */
export async function resolveVendorPortalUserId(): Promise<
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403 }
> {
  const access = await requireVendorApiAccess();
  if (access.ok) {
    const effectiveId = await getEffectiveUserIdForPortal("vendor");
    return { ok: true, userId: effectiveId ?? access.actor.userId };
  }

  const ctx = await getPortalAccessContext();
  if (!ctx.user) return { ok: false, status: 401 };
  if (await isAdminUser(ctx.user.id)) {
    const preview = await getAdminPreviewFromCookies();
    const effectiveId = await getEffectiveUserIdForPortal("vendor");
    if (preview?.portal === "vendor" && effectiveId) {
      return { ok: true, userId: effectiveId };
    }
  }

  return { ok: false, status: access.status };
}

/** Role used for mixed manager/vendor API routes (e.g. work-order bids). */
export function resolvePortalApiActorRole(
  ctx: Pick<Awaited<ReturnType<typeof getPortalAccessContext>>, "effectiveRole" | "roles" | "profile">,
): string {
  if (ctx.effectiveRole) return ctx.effectiveRole;
  if (ctx.roles.length === 1) return ctx.roles[0]!;
  return String(ctx.profile?.role ?? "").toLowerCase();
}

/**
 * Acting role for the mixed manager/vendor work-order routes: the portal the request came from
 * (`profile_roles` + active-portal cookie), falling back to the legacy `profiles.role` only when
 * the portal context cannot name one. `profiles.role` alone reads a manager+vendor as "manager"
 * forever, which locked that account out of its own vendor jobs.
 */
export async function resolveSessionActorRole(legacyRole: unknown): Promise<string> {
  const legacy = String(legacyRole ?? "").trim().toLowerCase();
  try {
    const ctx = await getPortalAccessContext();
    const role = resolvePortalApiActorRole(ctx).trim().toLowerCase();
    return role || legacy;
  } catch {
    return legacy;
  }
}
