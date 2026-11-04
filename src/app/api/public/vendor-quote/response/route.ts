import { NextResponse } from "next/server";
import { VendorQuoteConflictError, assertVendorQuoteSessionBinding, declineVendorQuote, submitVendorQuoteResponse } from "@/lib/vendor-quote-contact.server";
import type { VendorQuoteResponseInput } from "@/lib/vendor-quote-contract";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { notifyVendorQuoteResponse } from "@/lib/vendor-quote-notification.server";
import { hasSameOriginJson, limitPublicRequest, PRIVATE_HEADERS, readBoundedJson, VENDOR_QUOTE_SESSION_COOKIE } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!hasSameOriginJson(request)) return NextResponse.json({ ok: false }, { status: 403, headers: PRIVATE_HEADERS });
  const body = await readBoundedJson(request);
  if (!body) return NextResponse.json({ ok: false }, { status: 400, headers: PRIVATE_HEADERS });
  const action = body.action;
  if (action !== "submit" && action !== "decline") return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  const cookieName = VENDOR_QUOTE_SESSION_COOKIE.response;
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!token || !(await limitPublicRequest(request, `write-${String(action)}`, token))) {
    return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  }
  try {
    const db = createSupabaseServiceRoleClient();
    await assertVendorQuoteSessionBinding(db, token, request.headers.get("x-vendor-quote-binding"));
    const expectedVersion = body.expectedVersion;
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) {
      return NextResponse.json({ ok: false }, { status: 400, headers: PRIVATE_HEADERS });
    }
    if (action === "decline") {
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 1000) : "";
      await declineVendorQuote(db, token, { expectedVersion: Number(expectedVersion), reason });
      return NextResponse.json({ ok: true }, { headers: PRIVATE_HEADERS });
    }
    if (action === "submit") {
      const raw = body.response;
      if (!isVendorQuoteResponseInput(raw)) {
        return NextResponse.json({ ok: false }, { status: 400, headers: PRIVATE_HEADERS });
      }
      const result = await submitVendorQuoteResponse(db, token, { expectedVersion: Number(expectedVersion), response: raw });
      await notifyVendorQuoteResponse(db, {
        sessionToken: token,
        sourceMessageId: result.sourceMessageId,
        channel: "portal",
        body: formatManagerNotification(result.response, result.projection.reference, result.question, result.followUpReply),
      });
      return NextResponse.json({ ok: true, projection: result.projection, followUpReply: result.followUpReply }, { headers: PRIVATE_HEADERS });
    }
    // The response capability deliberately cannot withdraw email permission.
    return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof VendorQuoteConflictError) return NextResponse.json({ ok: false, error: error.message }, { status: 409, headers: PRIVATE_HEADERS });
    return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  }
}

function formatManagerNotification(response: VendorQuoteResponseInput, reference: string, question: string, followUpReply: string | null): string {
  const amount = (cents: number | null) => cents === null ? "Not provided" : `$${(cents / 100).toFixed(2)} USD`;
  const lines = [
    `Vendor quote response for service ${reference}.`,
    `Labor: ${amount(response.laborCents)}`,
    `Materials: ${amount(response.materialsCents)}`,
    `Diagnostic fee: ${amount(response.diagnosticFeeCents)}`,
    `Duration: ${response.durationMinutes === null ? "Not provided" : `${response.durationMinutes} minutes`}`,
    response.scope ? `Scope: ${response.scope}` : "Scope: Not provided",
    response.exclusions ? `Exclusions: ${response.exclusions}` : "Exclusions: Not provided",
    ...response.windows.map((window) => `Availability: ${window.startIso} to ${window.endIso} (${window.timeZone})`),
    question ? `Vendor question: ${question}` : "",
    followUpReply ? `Sender follow-up: ${followUpReply}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function isVendorQuoteResponseInput(value: unknown): value is VendorQuoteResponseInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const amount = (candidate: unknown) => candidate === null || Number.isSafeInteger(candidate) && Number(candidate) >= 0 && Number(candidate) <= 1_000_000_000;
  const dateTime = (candidate: unknown) => typeof candidate === "string" && candidate.length <= 64 && Number.isFinite(Date.parse(candidate));
  return amount(input.laborCents) && amount(input.materialsCents) && amount(input.diagnosticFeeCents) &&
    typeof input.scope === "string" && input.scope.length <= 4000 &&
    typeof input.exclusions === "string" && input.exclusions.length <= 4000 &&
    (input.durationMinutes === null || Number.isSafeInteger(input.durationMinutes) && Number(input.durationMinutes) >= 15 && Number(input.durationMinutes) <= 480) &&
    typeof input.question === "string" && input.question.length <= 2000 &&
    Array.isArray(input.windows) && input.windows.length <= 32 && input.windows.every((window) => {
      if (!window || typeof window !== "object" || Array.isArray(window)) return false;
      const candidate = window as Record<string, unknown>;
      return dateTime(candidate.startIso) && dateTime(candidate.endIso) && Date.parse(String(candidate.startIso)) < Date.parse(String(candidate.endIso)) &&
        typeof candidate.timeZone === "string" && candidate.timeZone.length > 0 && candidate.timeZone.length <= 80;
    });
}
