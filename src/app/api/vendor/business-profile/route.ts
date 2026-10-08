import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import {
  loadVendorBusinessProfile,
  loadVendorWorkspaceAccess,
  saveVendorBusinessProfile,
} from "@/lib/vendor-business-profile.server";
import { parseVendorAiInfoPatch } from "@/lib/vendor-ai-info";
import { provisionVendorWorkNumberAtSignup, type SignupWorkNumberResult } from "@/lib/vendor-work-number-signup.server";

export const runtime = "nodejs";

async function requireVendor() {
  // The same vendor-role resolver every other /api/vendor route uses (profile_roles-aware).
  const access = await resolveVendorPortalUserId();
  if (!access.ok) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: access.status === 401 ? "Unauthorized." : "Forbidden." }, { status: access.status }),
    };
  }
  return { ok: true as const, userId: access.userId, db: createSupabaseServiceRoleClient() };
}

/** The vendor's own business profile plus the manager workspaces they can act in. */
export async function GET() {
  try {
    const auth = await requireVendor();
    if (!auth.ok) return auth.response;
    const [profile, workspaces] = await Promise.all([
      loadVendorBusinessProfile(auth.db, auth.userId),
      loadVendorWorkspaceAccess(auth.db, auth.userId),
    ]);
    return NextResponse.json({ profile, workspaces }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load business profile." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireVendor();
    if (!auth.ok) return auth.response;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const str = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined);
    const bool = (key: string) => (typeof body[key] === "boolean" ? (body[key] as boolean) : undefined);
    const strArray = (key: string) =>
      Array.isArray(body[key]) ? (body[key] as unknown[]).filter((v): v is string => typeof v === "string") : undefined;
    const num = (key: string) => {
      if (body[key] === null) return null;
      return typeof body[key] === "number" ? (body[key] as number) : undefined;
    };
    // Only the five known AI-info keys are read, each validated; a user id in the body is never read.
    let aiInfo: ReturnType<typeof parseVendorAiInfoPatch> | null = null;
    if ("aiInfo" in body) {
      aiInfo = parseVendorAiInfoPatch(body.aiInfo);
      if (!aiInfo.ok) return NextResponse.json({ error: aiInfo.error }, { status: 400 });
    }
    const result = await saveVendorBusinessProfile(auth.db, auth.userId, {
      ...(aiInfo?.ok ? { aiInfo: aiInfo.patch } : {}),
      businessName: str("businessName"),
      contactName: str("contactName"),
      workEmail: str("workEmail"),
      workPhone: str("workPhone"),
      serviceArea: str("serviceArea"),
      notifyNewOffers: bool("notifyNewOffers"),
      notifyScheduleChanges: bool("notifyScheduleChanges"),
      notifyPayments: bool("notifyPayments"),
      trades: strArray("trades"),
      serviceAreaZips: strArray("serviceAreaZips"),
      serviceRadiusMiles: num("serviceRadiusMiles"),
      licenseNumber: str("licenseNumber"),
      insuranceProvider: str("insuranceProvider"),
      insurancePolicyNumber: str("insurancePolicyNumber"),
      insuranceExpiresAt: "insuranceExpiresAt" in body ? (str("insuranceExpiresAt") ?? "") : undefined,
      directoryListed: bool("directoryListed"),
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    // The Finish button of onboarding: give a vendor with a verified phone their number. Soft-fails
    // (and does nothing while the vendor-number switches are off); the number never comes from the body.
    let workNumber: SignupWorkNumberResult | undefined;
    if (body.finishOnboarding === true && result.profile.onboardingCompletedAt) {
      workNumber = await provisionVendorWorkNumberAtSignup(auth.db, auth.userId, { serviceAreaZips: result.profile.serviceAreaZips });
    }
    return NextResponse.json({ profile: result.profile, ...(workNumber ? { workNumber } : {}) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to save business profile." }, { status: 500 });
  }
}
