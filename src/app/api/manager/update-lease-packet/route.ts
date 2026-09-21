import { NextRequest, NextResponse } from "next/server";
import { patchLeasePacketForManagerReview } from "@/lib/lease-packet-edit.server";
import { applicationPatchFromLeasePacketInput, type UpdateLeasePacketInput } from "@/lib/tools/domains/leases-logic";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseBody(raw: unknown): UpdateLeasePacketInput | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Invalid request body." };
  const body = raw as Record<string, unknown>;
  const leaseId = String(body.leaseId ?? "").trim();
  if (!leaseId) return { error: "leaseId is required." };

  const input: UpdateLeasePacketInput = { leaseId };
  if (body.unit !== undefined) input.unit = String(body.unit);
  if (body.notes !== undefined) input.notes = String(body.notes);
  if (body.roomChoice !== undefined) input.roomChoice = String(body.roomChoice);
  if (body.rentalType === "standard" || body.rentalType === "short_term") input.rentalType = body.rentalType;
  if (body.leaseTerm !== undefined) input.leaseTerm = String(body.leaseTerm);
  if (body.leaseStart !== undefined) {
    const start = String(body.leaseStart).trim();
    if (start && !DATE_RE.test(start)) return { error: "leaseStart must use YYYY-MM-DD." };
    input.leaseStart = start;
  }
  if (body.leaseEnd !== undefined) {
    const end = String(body.leaseEnd).trim();
    if (end && !DATE_RE.test(end)) return { error: "leaseEnd must use YYYY-MM-DD or be empty." };
    input.leaseEnd = end;
  }

  const moneyKeys = ["monthlyRent", "monthlyUtilities", "securityDeposit", "moveInFee"] as const;
  for (const key of moneyKeys) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < 0) return { error: `${key} must be a non-negative number.` };
    input[key] = n;
  }

  const hasScalar =
    input.unit !== undefined ||
    input.notes !== undefined ||
    input.monthlyRent !== undefined ||
    input.monthlyUtilities !== undefined ||
    input.securityDeposit !== undefined ||
    input.moveInFee !== undefined ||
    input.leaseStart !== undefined ||
    input.leaseEnd !== undefined ||
    input.leaseTerm !== undefined ||
    input.roomChoice !== undefined ||
    input.rentalType !== undefined;
  if (!hasScalar) return { error: "Provide at least one field to change." };

  return input;
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Lease access is unavailable for this account." }, { status: 403 });
    }
    const { data: profile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
    const role = String(profile?.role ?? "").toLowerCase();
    if (role !== "manager" && role !== "admin") {
      return NextResponse.json({ error: "Managers only." }, { status: 403 });
    }

    const parsed = parseBody(await req.json());
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const appPatch = applicationPatchFromLeasePacketInput(parsed);
    const result = await patchLeasePacketForManagerReview(db, user.id, {
      leaseId: parsed.leaseId,
      ...(parsed.unit !== undefined ? { unit: parsed.unit } : {}),
      ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      ...(appPatch ? { application: appPatch } : {}),
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true, row: result.row });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
