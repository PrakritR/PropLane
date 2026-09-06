/**
 * AgentContext — the MANAGER (and admin) agent context, plus the two SMS-agent
 * contexts built from a webhook session. Resolved server-side from the
 * authenticated Supabase session; `landlordId` is always the authenticated
 * user's id, never taken from model or client input, and every manager tool
 * scopes its data access to it. This is the choke point that makes
 * cross-landlord access structurally impossible.
 *
 * The signed-in RESIDENT and VENDOR portals have their own context types
 * (`resident-context.ts`, `vendor-context.ts`) with their own scope keys, so a
 * manager tool cannot even typecheck into a role registry.
 */
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { resolveManagerSmsAccess } from "@/lib/sms/manager-sms-access.server";

import type { ManagerSmsAccess } from "@/lib/sms/manager-sms-access";

export type AgentContext = {
  /** Authenticated manager_user_id. The per-landlord scope key for every tool. */
  landlordId: string;
  userId: string;
  email: string;
  roles: string[];
  isAdmin: boolean;
  /**
   * Service-role client. It bypasses RLS, so every query built from it MUST
   * include an explicit `.eq("manager_user_id", ctx.landlordId)` (or equivalent
   * ownership filter). Never query it without a landlord scope.
   */
  db: ReturnType<typeof createSupabaseServiceRoleClient>;
  /** Present only on vendor-agent turns; pins every vendor tool to one job. */
  vendorScope?: VendorAgentScope;
  /** Present only on leasing SMS agent turns; pins links to the prospect phone. */
  leasingScope?: LeasingSmsAgentScope;
  /**
   * This manager's data reach beyond their own portfolio, on ANY surface.
   *
   * Named for SMS because that is where it started, but it is not SMS-specific:
   * a co-manager asking the assistant in the PORTAL needs exactly the same
   * widening, and without it every tool filtered on `landlordId` alone and a
   * pure co-manager — who owns no properties — got an empty answer to every
   * question while their texts to the same assistant worked.
   *
   * Delegated turns (someone else's work number) keep `landlordId` as the
   * work-number owner and `userId` as the verified co-manager. Combined turns
   * keep both as the actor and add the houses assigned to them.
   */
  managerSmsAccess?: ManagerSmsAccess;
};

/** The single work-order conversation a vendor-agent turn is allowed to see. */
export type VendorAgentScope = {
  sessionId: string;
  vendorDirectoryId: string;
  vendorUserId: string | null;
  workOrderId: string;
};

/** Prospect texting a PropLane leasing line (per-manager Twilio or the shared Claw line). */
export type LeasingSmsAgentScope = {
  sessionId: string;
  prospectPhoneE164: string;
  /**
   * The prospect's email when they wrote in by mail instead of text. Exactly one
   * of this and `prospectPhoneE164` carries a real value — an email prospect has
   * no phone to prefill or to name in an escalation, and writing an address into
   * a field called `prospectPhoneE164` would silently poison both.
   */
  prospectEmail?: string | null;
  /** How the prospect reached us. Absent means SMS, which is the original path. */
  channel?: "sms" | "email";
  workNumber: string | null;
  /**
   * True on the shared Claw line (`+12053690702`), where a single number fronts
   * EVERY manager. Listing tools then read the whole public catalog (any owner)
   * instead of only `ctx.landlordId`'s listings, so the agent can find and link
   * any live listing on PropLane — the same set the public `/rent` pages show.
   * False/undefined on a per-manager work number (scoped to that manager only).
   */
  crossCatalog?: boolean;
};

/**
 * Returns the agent context for the current request, or null when the caller is
 * unauthenticated or is not a manager/owner (the agent is a manager surface).
 */
export async function resolveAgentContext(): Promise<AgentContext | null> {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return null;

  const db = createSupabaseServiceRoleClient();
  const [{ data: profile }, { data: roleRows }] = await Promise.all([
    db.from("profiles").select("email, role").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);

  const isAdmin = await isAdminUser(user.id);
  const roleList = (roleRows ?? []).map((r) => String(r.role).toLowerCase());
  const legacyRole = String(profile?.role ?? "").toLowerCase();
  const roles = roleList.length > 0 ? roleList : legacyRole ? [legacyRole] : [];
  const isManagerOrOwner = roles.some((r) => r === "manager" || r === "owner");
  if (!isAdmin && !isManagerOrOwner) return null;

  // The same access decision the SMS and email assistants make, so a manager's reach cannot
  // differ depending on which surface they asked from. For a manager with no incoming
  // assignments this resolves to plain `owner` and changes nothing; for a co-manager it is what
  // makes the portal assistant able to answer at all.
  const managerSmsAccess =
    (await resolveManagerSmsAccess(db, { actorUserId: user.id, workNumberOwnerId: user.id })) ?? undefined;

  return {
    landlordId: user.id,
    userId: user.id,
    email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
    roles,
    isAdmin,
    db,
    managerSmsAccess,
  };
}

/**
 * Context for a vendor-agent turn. There is NO authenticated user on an
 * inbound-SMS webhook, so this is constructed ONLY from an agent_sessions row
 * our own dispatch code created — landlordId and the scope never come from
 * client or model input. resolveAgentContext stays vendor-rejecting on purpose.
 */
export function buildVendorAgentContext(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  args: { landlordId: string; scope: VendorAgentScope },
): AgentContext {
  return {
    landlordId: args.landlordId,
    userId: args.scope.vendorUserId ?? args.landlordId,
    email: "",
    roles: ["vendor_agent"],
    isAdmin: false,
    db,
    vendorScope: args.scope,
  };
}

/**
 * Context for a leasing-SMS agent turn. Built ONLY from a work-number inbound
 * webhook we already authenticated — landlordId and prospect phone never come
 * from model or client input.
 */
export function buildLeasingSmsAgentContext(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  args: { landlordId: string; scope: LeasingSmsAgentScope },
): AgentContext {
  return {
    landlordId: args.landlordId,
    userId: args.landlordId,
    email: "",
    roles: ["leasing_sms_agent"],
    isAdmin: false,
    db,
    leasingScope: args.scope,
  };
}
