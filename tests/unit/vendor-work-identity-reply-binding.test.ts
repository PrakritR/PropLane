import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bindVendorReplyTarget } from "@/lib/vendor-sponsored-outbound.server";

function dbForBinding(existing?: { recipient: string; recipient_user_id: string | null }) {
  const inserts: unknown[] = [];
  const from = vi.fn((table: string) => {
    const q: Record<string, unknown> = {};
    q.select = () => q; q.eq = () => q;
    q.maybeSingle = async () => table === "vendor_work_identities"
      ? { data: { id: "identity-1" }, error: null }
      : { data: existing ?? null, error: null };
    q.insert = (row: unknown) => { inserts.push(row); return Promise.resolve({ error: existing ? { code: "23505" } : null }); };
    return q;
  });
  return { db: { from } as unknown as SupabaseClient, inserts };
}

describe("vendor work identity reply bindings", () => {
  it("records a service-role destination once and accepts an exact replay", async () => {
    const first = dbForBinding();
    await expect(bindVendorReplyTarget(first.db, { vendorUserId: "vendor-1", threadId: "thread-1", channel: "email", recipient: "manager@example.test", recipientUserId: "manager-1", messageId: "inbound-1" })).resolves.toBeUndefined();
    expect(first.inserts[0]).toMatchObject({ recipient: "manager@example.test", recipient_user_id: "manager-1" });
    const replay = dbForBinding({ recipient: "manager@example.test", recipient_user_id: "manager-1" });
    await expect(bindVendorReplyTarget(replay.db, { vendorUserId: "vendor-1", threadId: "thread-1", channel: "email", recipient: "manager@example.test", recipientUserId: "manager-1", messageId: "inbound-1" })).resolves.toBeUndefined();
  });

  it("fails closed when a replay attempts to retarget a thread", async () => {
    const db = dbForBinding({ recipient: "manager@example.test", recipient_user_id: "manager-1" });
    await expect(bindVendorReplyTarget(db.db, { vendorUserId: "vendor-1", threadId: "thread-1", channel: "email", recipient: "attacker@example.test", recipientUserId: "manager-2", messageId: "inbound-2" })).rejects.toThrow("binding conflict");
  });

  it("uses bindings for every reply and never synthesizes an SMS email address", () => {
    const outbound = readFileSync("src/lib/vendor-sponsored-outbound.server.ts", "utf8");
    const inbound = readFileSync("src/lib/vendor-work-identity-inbound.server.ts", "utf8");
    expect(outbound).toContain("binding?.recipient_user_id");
    expect(outbound).not.toContain("@sms.proplane.local");
    expect(inbound).not.toContain("row_data: { ...");
  });
});
