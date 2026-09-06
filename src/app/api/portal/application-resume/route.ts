import { openApplicantRow } from "@/lib/security/applicant-identity";
import { NextResponse } from "next/server";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { isResidentSetupTokenValid } from "@/lib/auth/resident-setup-token";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { isInProgressApplicationRow } from "@/lib/rental-application/in-progress-application";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Guest draft resume for the PUBLIC apply flow. A true guest has no session, so
 * after a real page reload the only proof they own an in-progress application is
 * the row's freshest resident-setup token (returned by every guest autosave and
 * kept in sessionStorage — never the answers themselves). Presenting the axis id
 * plus that token returns the stored in-progress row so the wizard can restore
 * the form and step. Every denial — missing row, wrong/expired token, decided or
 * withdrawn application — returns the identical response, so probing an id
 * reveals nothing (no email/row oracle).
 */

function denied(): NextResponse {
  return NextResponse.json({ error: "Not allowed." }, { status: 403 });
}

// Per-IP sliding window — in-memory, per-instance; defense-in-depth only. The
// real bound is the unguessable setup token.
const RESUME_RATE_WINDOW_MS = 60_000;
const RESUME_RATE_MAX = 30;
const resumeRequestsByIp = new Map<string, number[]>();

function isResumeRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RESUME_RATE_WINDOW_MS;
  const recent = (resumeRequestsByIp.get(ip) ?? []).filter((t) => t > cutoff);
  if (recent.length >= RESUME_RATE_MAX) {
    resumeRequestsByIp.set(ip, recent);
    return true;
  }
  recent.push(now);
  if (resumeRequestsByIp.size > 10_000) resumeRequestsByIp.clear();
  resumeRequestsByIp.set(ip, recent);
  return false;
}

function idVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, trimmed.toUpperCase(), normalized, normalized.toUpperCase()].filter(Boolean))];
}

export async function POST(req: Request) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (isResumeRateLimited(ip)) {
      return NextResponse.json({ error: "Too many requests. Try again in a minute." }, { status: 429 });
    }

    const body = (await req.json().catch(() => null)) as { id?: string; token?: string } | null;
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!id || !token) return denied();

    const db = createSupabaseServiceRoleClient();
    const { data, error } = await db
      .from("manager_application_records")
      .select("id, row_data")
      .in("id", idVariants(id))
      .limit(1);
    if (error) return denied();

    const stored = (data?.[0]?.row_data ?? null) as DemoApplicantRow | null;
    if (!stored) return denied();
    if (!isResidentSetupTokenValid(stored, token)) return denied();
    const guarded: DemoApplicantRow = { ...stored, stage: typeof stored.stage === "string" ? stored.stage : "" };
    if (!isInProgressApplicationRow(guarded) || isWithdrawnApplicationRow(guarded)) return denied();

    // The token fields are the row's write credential material — never echo them.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure strips the credential fields
    const { setupTokenHash: _hash, setupTokenExpiresAt: _expires, setupTokenConsumedAt: _consumed, ...row } = openApplicantRow(stored, String(data?.[0]?.id ?? stored.id));
    return NextResponse.json({ row: { ...row, id: normalizeApplicationAxisId(stored.id) } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
