import { NextResponse } from "next/server";

import {
  gmailPaymentsPublicStatus,
  loadGmailPaymentsConnection,
  clearGmailPaymentsConnection,
} from "@/lib/gmail-payments/settings";
import type { ManagerPaymentReceiptChannel } from "@/lib/gmail-payments/portal-role";
import { requireManager } from "@/lib/gmail-payments/require-manager.server";

export const runtime = "nodejs";

function parseChannelParam(value: string | null): ManagerPaymentReceiptChannel | undefined {
  const trimmed = value?.trim();
  return trimmed === "venmo" || trimmed === "zelle" ? trimmed : undefined;
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const channel = parseChannelParam(new URL(req.url).searchParams.get("channel"));
    const connection = await loadGmailPaymentsConnection(ctx.db, ctx.userId, "manager", channel);
    return NextResponse.json({ status: gmailPaymentsPublicStatus(connection), channel: channel ?? null });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const channel = parseChannelParam(new URL(req.url).searchParams.get("channel"));
    await clearGmailPaymentsConnection(ctx.db, ctx.userId, "manager", channel);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
