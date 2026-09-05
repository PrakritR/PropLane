import { NextResponse } from "next/server";
import { buildPortalInboxThreadUpsert } from "@/lib/portal-inbox-thread-upsert";
import { ADMIN_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(req: Request) {
  try {
    if (!(await rateLimit(`contact-message:${clientIpFrom(req)}`, 8, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
    }

    const body = (await req.json()) as {
      name?: string;
      email?: string;
      topic?: string;
      body?: string;
    };

    const name = textField(body.name);
    const email = textField(body.email).toLowerCase();
    const topic = textField(body.topic);
    const message = textField(body.body);

    if (!name || !email.includes("@")) {
      return NextResponse.json({ error: "Name and valid email are required." }, { status: 400 });
    }
    if (!topic) return NextResponse.json({ error: "Topic is required." }, { status: 400 });
    if (!message) return NextResponse.json({ error: "Message is required." }, { status: 400 });

    const row = {
      id: crypto.randomUUID(),
      name,
      email,
      participantEmail: email,
      topic,
      body: message,
      createdAt: new Date().toISOString(),
      read: false,
      folder: "inbox",
      senderRole: "partner",
      thread: [],
      scope: ADMIN_INBOX_SCOPE,
    };

    const db = createSupabaseServiceRoleClient();
    const record = buildPortalInboxThreadUpsert(row, { id: "", email: null });
    const { error } = await db.from("portal_inbox_thread_records").upsert(record, { onConflict: "id" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not send message.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
