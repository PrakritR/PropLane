import { NextResponse } from "next/server";
import type { MockProperty } from "@/data/types";
import { isPropertyActiveForLeads } from "@/lib/demo-property-pipeline";
import { resolveListingCtaSmsPhone } from "@/lib/listing-cta-phone.server";
import { publicListingProjection } from "@/lib/public-listings.server";
import { resolveListingCtaEmail } from "@/lib/listing-cta-email.server";
import { isSandboxPublicListing } from "@/lib/public-sandbox-listings";
import { isProductionRuntime } from "@/lib/server-env";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function asProperty(value: unknown): MockProperty | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as MockProperty;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const propertyId = url.searchParams.get("propertyId")?.trim() ?? "";
    if (!propertyId) {
      return NextResponse.json({ error: "propertyId is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const { data, error } = await db
      .from("manager_property_records")
      .select("id, manager_user_id, status, property_data")
      .eq("id", propertyId)
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.status !== "live") {
      return NextResponse.json({ error: "Property not found." }, { status: 404 });
    }

    const storedProperty = asProperty(data.property_data);
    // `manager_property_records.status` is the canonical publish state. Older
    // rows can be live while their JSON predates `adminPublishLive`; the public
    // catalog already normalizes those rows, and the single-listing endpoint
    // must make the same decision or a generated share URL returns 404 while
    // that exact home is visible in Browse.
    const property = storedProperty
      ? { ...storedProperty, adminPublishLive: true }
      : null;
    if (!property || !isPropertyActiveForLeads(property)) {
      return NextResponse.json({ error: "Property is not active for apply or tour links." }, { status: 404 });
    }

    let managerEmail: string | null = null;
    let managerProfile: {
      phone: string | null;
      phone_verified_at: string | null;
      sms_from_number: string | null;
    } | null = null;
    if (data.manager_user_id) {
      const { data: profile } = await db
        .from("profiles")
        .select("email, phone, phone_verified_at, sms_from_number")
        .eq("id", data.manager_user_id)
        .maybeSingle();
      managerEmail = profile?.email ?? null;
      managerProfile = profile
        ? {
            phone: profile.phone ?? null,
            phone_verified_at: profile.phone_verified_at ?? null,
            sms_from_number: profile.sms_from_number ?? null,
          }
        : null;
    }

    const resolved: MockProperty = {
      ...property,
      id: property.id || propertyId,
      managerUserId: property.managerUserId ?? data.manager_user_id ?? undefined,
      managerContactEmail: managerEmail?.trim() || undefined,
      // Same per-property rule as the public catalog: this listing's own
      // manager, and the stored blob number is never trusted. See
      // `resolveListingCtaSmsPhone`.
      contactSmsPhone: resolveListingCtaSmsPhone(managerProfile) ?? undefined,
      contactWorkEmail:
        (await resolveListingCtaEmail(db, data.manager_user_id ?? null)) ?? undefined,
    };

    if (isProductionRuntime()) {
      if (isSandboxPublicListing({ property: resolved, managerEmail })) {
        return NextResponse.json({ error: "Property not found." }, { status: 404 });
      }
    }

    // Public per-property detail: CDN-cacheable, same for everyone. Same
    // allowlist as the catalog — this route reaches the SAME stored blob from
    // the SAME anonymous audience, so a projection on only one of the two is
    // trivially bypassed by asking for the property by id.
    return NextResponse.json(
      { property: publicListingProjection(resolved) },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load property." },
      { status: 500 },
    );
  }
}
