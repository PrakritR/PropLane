import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { getManagerSubscriptionTierByManagerId } from "@/lib/manager-access-server";
import { getPublicListings } from "@/lib/public-listings.server";
import { applicationBucket } from "@/lib/resident-manager-scope";
import { isSubmittedPendingApplicationRow } from "@/lib/rental-application/in-progress-application";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAgentContext, type AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import {
  requireActiveTestWorkspaceActor,
  isTestWorkspaceFeatureEnabled,
} from "@/lib/test-workspaces/index.server";

const SMS_TEST_PROJECT_REF_BY_ENV: Record<string, string> = {
  development: "emstjswhotsnyksqhqyf",
  preview: "xwszcafaontidfgznlxd",
  production: "qahnczmilgptcedaqype",
};

export type SmsTestPortal = "manager" | "resident";
export type SmsTestMode = "manager" | "prospect" | "resident";
export type SmsTestApplicationStage = "prospect" | "submitted" | "approved";

export const SMS_TEST_SESSION_KINDS = {
  manager: "manager_sms_test",
  prospect: "leasing_sms_test",
  resident: "resident_sms_test",
} as const;

export type SmsTestTarget = {
  listingId: string;
  managerUserId: string;
  title: string;
  address: string;
  stage?: SmsTestApplicationStage;
};

export type SmsTestCapability = {
  enabled: true;
  portal: SmsTestPortal;
  actorUserId: string;
  actorName: string | null;
  workspaceId: string;
  targets: SmsTestTarget[];
};

export type SmsTestResolvedContext = {
  capability: SmsTestCapability;
  mode: SmsTestMode;
  stage: SmsTestApplicationStage;
  managerUserId: string;
  sessionKind: string;
  target: SmsTestTarget | null;
  actorEmail: string;
  managerContext?: AgentContext;
  residentContext?: ResidentAgentContext;
};

export function smsTestEnvironmentAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isTestWorkspaceFeatureEnabled(env)) return false;
  const raw = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
      return env.NODE_ENV !== "production" && env.VERCEL_ENV !== "production";
    }
    if (url.protocol !== "https:") return false;
    const match = url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
    const runtime = env.VERCEL_ENV?.trim() || (env.NODE_ENV === "production" ? "production" : "development");
    return Boolean(match?.[1] && SMS_TEST_PROJECT_REF_BY_ENV[runtime] === match[1]);
  } catch {
    return false;
  }
}

export function assertSmsTestEnvironment(): void {
  if (!smsTestEnvironmentAllowed()) {
    throw new Error("SMS test conversations are unavailable.");
  }
}

async function authenticatedCapability(portal: SmsTestPortal): Promise<SmsTestCapability | null> {
  assertSmsTestEnvironment();
  const access = await getPortalAccessContext();
  if (!access.user || !hasRole(access, portal)) return null;
  const membership = await requireActiveTestWorkspaceActor(portal);
  let targets: SmsTestTarget[] = [];
  if (portal === "resident") {
    const email = String(access.user.email ?? access.profile?.email ?? "").trim().toLowerCase();
    if (!email) return null;
    const db = createSupabaseServiceRoleClient();
    const { data, error } = await db
      .from("manager_application_records")
      .select("manager_user_id, property_id, assigned_property_id, row_data")
      .eq("resident_email", email)
      .eq("test_workspace_id", membership.workspaceId)
      .limit(100);
    if (error) throw new Error("Could not verify SMS test listing access.");
    const linked = (data ?? []).flatMap((row) => {
      const application = (row.row_data ?? {}) as DemoApplicantRow;
      const active = application.bucket === "approved"
        ? !isWithdrawnApplicationRow(application)
        : isSubmittedPendingApplicationRow(application);
      if (!active) return [];
      const managerUserId = String(row.manager_user_id ?? "").trim();
      const listingId =
        String(row.assigned_property_id ?? "").trim() ||
        String(row.property_id ?? "").trim() ||
        application.assignedPropertyId?.trim() ||
        application.propertyId?.trim() ||
        application.application?.propertyId?.trim() ||
        "";
      const stage: SmsTestApplicationStage = application.bucket === "approved" ? "approved" : "submitted";
      return managerUserId ? [{ managerUserId, listingId, stage }] : [];
    });
    const listings = await getPublicListings({ testWorkspaceId: membership.workspaceId });
    targets = listings.flatMap((property) => {
      const listingId = property.id.trim();
      const managerUserId = property.managerUserId?.trim() ?? "";
      if (!listingId || !managerUserId) return [];
      const linkedScope = linked.find((scope) =>
        scope.managerUserId === managerUserId && scope.listingId === listingId,
      );
      if (linked.length > 0 && !linkedScope) return [];
      return [{
        listingId,
        managerUserId,
        title: property.title,
        address: property.address,
        stage: linkedScope?.stage ?? "prospect",
      }];
    });
  }
  return {
    enabled: true,
    portal,
    actorUserId: access.user.id,
    actorName: access.profile?.full_name?.trim() || null,
    workspaceId: membership.workspaceId,
    targets,
  };
}

export async function resolveSmsTestCapability(portal: SmsTestPortal): Promise<SmsTestCapability | null> {
  return authenticatedCapability(portal);
}

/**
 * Stage is re-read on every turn. Query errors throw instead of degrading to a
 * prospect, because that would expose the wrong tool catalog during an outage.
 */
export async function resolveSmsTestApplicationStage(
  db: SupabaseClient,
  args: { residentEmail: string; managerUserId: string; workspaceId?: string },
): Promise<SmsTestApplicationStage> {
  const email = args.residentEmail.trim().toLowerCase();
  const managerUserId = args.managerUserId.trim();
  if (!email || !managerUserId) return "prospect";
  let query = db
    .from("manager_application_records")
    .select("row_data")
    .eq("resident_email", email)
    .eq("manager_user_id", managerUserId);
  if (args.workspaceId) query = query.eq("test_workspace_id", args.workspaceId);
  const { data, error } = await query.limit(50);
  if (error) throw new Error("Could not verify the application stage.");
  const applications = (data ?? []).map((row) => (row.row_data ?? {}) as DemoApplicantRow);
  if (applications.some((row) => applicationBucket(row) === "approved" && !isWithdrawnApplicationRow(row))) {
    return "approved";
  }
  if (applications.some(isSubmittedPendingApplicationRow)) return "submitted";
  return "prospect";
}

function sessionKind(mode: SmsTestMode, managerUserId: string, listingId?: string): string {
  return [SMS_TEST_SESSION_KINDS[mode], managerUserId, listingId].filter(Boolean).join(":");
}

export async function resolveSmsTestContext(args: {
  portal: SmsTestPortal;
  targetListingId?: string | null;
}): Promise<SmsTestResolvedContext | null> {
  const capability = await authenticatedCapability(args.portal);
  if (!capability) return null;

  if (args.portal === "manager") {
    const managerContext = await resolveAgentContext();
    if (!managerContext || managerContext.userId !== capability.actorUserId) return null;
    return {
      capability,
      mode: "manager",
      stage: "approved",
      managerUserId: managerContext.userId,
      sessionKind: sessionKind("manager", managerContext.userId),
      target: null,
      actorEmail: managerContext.email,
      managerContext,
    };
  }

  const targetListingId = args.targetListingId?.trim() ?? "";
  const target = capability.targets.find((candidate) => candidate.listingId === targetListingId) ?? null;
  if (!target) return null;
  const access = await getPortalAccessContext();
  const actorEmail = String(access.user?.email ?? access.profile?.email ?? "").trim().toLowerCase();
  if (!actorEmail) return null;
  const db = createSupabaseServiceRoleClient();
  const stage = await resolveSmsTestApplicationStage(db, {
    residentEmail: actorEmail,
    managerUserId: target.managerUserId,
    workspaceId: capability.workspaceId,
  });
  if (stage === "prospect") {
    return {
      capability,
      mode: "prospect",
      stage,
      managerUserId: target.managerUserId,
      sessionKind: sessionKind("prospect", target.managerUserId, target.listingId),
      target,
      actorEmail,
    };
  }

  const managerTier = await getManagerSubscriptionTierByManagerId(target.managerUserId);
  const residentContext: ResidentAgentContext = {
    kind: "resident",
    userId: capability.actorUserId,
    email: actorEmail,
    managerIds: [target.managerUserId],
    activeManagerId: target.managerUserId,
    phase: stage === "approved" ? "approved" : "application",
    managerTier,
    landlordId: capability.actorUserId,
    db,
  };
  return {
    capability,
    mode: "resident",
    stage,
    managerUserId: target.managerUserId,
    sessionKind: sessionKind("resident", target.managerUserId, target.listingId),
    target,
    actorEmail,
    residentContext,
  };
}
