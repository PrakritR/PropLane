import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb } from "../helpers/fake-table-db";

const sendEmails = vi.fn(async (opts: { toEmails: string[] }) => new Map(opts.toEmails.map((e) => [e, { sent: true, resendId: "r1" }])));
vi.mock("@/lib/portal-email-send.server", () => ({
  sendPortalConversationEmails: (opts: { toEmails: string[] }) => sendEmails(opts),
}));
const workEmail = vi.fn(async (..._args: unknown[]): Promise<{ address: string | null; workspaceName: string } | null> => ({
  address: "assistant@seattle-homes.proplane.ai", workspaceName: "Seattle Homes",
}));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({
  resolveWorkspaceWorkEmail: (...args: unknown[]) => workEmail(...args),
}));

import { managerNoticeEmailClaimId, sendManagerNoticeEmail } from "@/lib/manager-notice-email.server";

/** The fake plus PostgREST's `upsert(..., { ignoreDuplicates: true })`: a conflict inserts nothing and returns no row. */
function seed() {
  const fake = createFakeDb({
    profiles: [{ id: "mate-1", email: "Mate@Example.com" }, { id: "no-email", email: "" }],
    portal_outbound_mail_records: [],
  });
  const from = fake.from.bind(fake);
  (fake as { from: unknown }).from = (table: string) => {
    if (table !== "portal_outbound_mail_records") return from(table);
    return {
      upsert: (row: Record<string, unknown>) => ({
        select: async () => {
          const rows = fake.tables.portal_outbound_mail_records!;
          if (rows.some((existing) => existing.id === row.id)) return { data: [], error: null };
          rows.push({ ...row });
          return { data: [{ id: row.id }], error: null };
        },
      }),
      delete: () => ({
        eq: async (_column: string, id: unknown) => {
          fake.tables.portal_outbound_mail_records = fake.tables.portal_outbound_mail_records!.filter((existing) => existing.id !== id);
          return { error: null };
        },
      }),
    };
  };
  return fake;
}
const base = {
  recipientUserId: "mate-1", ownerUserId: "owner-1", workspaceId: "ws-1",
  subject: "Rent · Payment update", text: "$1,000.00 was received", url: "/portal/payments", idempotencyKey: "k1",
};

beforeEach(() => {
  vi.clearAllMocks();
  sendEmails.mockImplementation(async (opts) => new Map(opts.toEmails.map((e) => [e, { sent: true, resendId: "r1" }])));
});

describe("sendManagerNoticeEmail", () => {
  it("emails the recipient's account address FROM the OWNER's workspace work email, as PropLane Assistant · <workspace>, with no signed reply route", async () => {
    const fake = seed();
    expect(await sendManagerNoticeEmail(fake as unknown as SupabaseClient, base)).toEqual({ status: "sent" });
    expect(workEmail).toHaveBeenCalledWith(expect.anything(), "owner-1", "ws-1");
    const sent = sendEmails.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      senderUserId: "owner-1",
      toEmails: ["mate@example.com"],
      subject: "Rent · Payment update",
      fromAddress: "PropLane Assistant · Seattle Homes <assistant@seattle-homes.proplane.ai>",
      omitReplyTo: true,
    });
    expect(String(sent.text)).toContain("$1,000.00 was received");
    expect(String(sent.text)).toContain("/portal/payments");
  });

  it("is idempotent per (key, recipient): a retry sends nothing, a different recipient still gets theirs", async () => {
    const fake = seed();
    fake.tables.profiles!.push({ id: "mate-2", email: "two@example.com" });
    const db = fake as unknown as SupabaseClient;
    expect(await sendManagerNoticeEmail(db, base)).toEqual({ status: "sent" });
    expect(await sendManagerNoticeEmail(db, base)).toEqual({ status: "skipped", reason: "duplicate" });
    expect(await sendManagerNoticeEmail(db, { ...base, recipientUserId: "mate-2" })).toEqual({ status: "sent" });
    expect(sendEmails).toHaveBeenCalledTimes(2);
    expect(managerNoticeEmailClaimId("mate-1", "k1")).not.toBe(managerNoticeEmailClaimId("mate-2", "k1"));
  });

  it("a failed send releases the claim so the retry sends", async () => {
    const fake = seed();
    const db = fake as unknown as SupabaseClient;
    sendEmails.mockImplementationOnce(async (opts) => new Map(opts.toEmails.map((e) => [e, { sent: false, resendId: null }])));
    expect(await sendManagerNoticeEmail(db, base)).toEqual({ status: "failed" });
    expect(fake.tables.portal_outbound_mail_records).toHaveLength(0);
    expect(await sendManagerNoticeEmail(db, base)).toEqual({ status: "sent" });
  });

  it("a thrown send is a failed leg (claim released), never a throw", async () => {
    const fake = seed();
    sendEmails.mockRejectedValueOnce(new Error("resend down"));
    expect(await sendManagerNoticeEmail(fake as unknown as SupabaseClient, base)).toEqual({ status: "failed" });
    expect(fake.tables.portal_outbound_mail_records).toHaveLength(0);
  });

  it("a workspace with no work email falls back to the shared PropLane sender (no From override)", async () => {
    workEmail.mockResolvedValueOnce({ address: null, workspaceName: "Seattle Homes" });
    await sendManagerNoticeEmail(seed() as unknown as SupabaseClient, base);
    expect((sendEmails.mock.calls[0]![0] as Record<string, unknown>).fromAddress).toBeNull();
  });

  it("an account with no email gets none", async () => {
    expect(await sendManagerNoticeEmail(seed() as unknown as SupabaseClient, { ...base, recipientUserId: "no-email" })).toEqual({
      status: "skipped", reason: "no_email",
    });
    expect(sendEmails).not.toHaveBeenCalled();
  });

  it("a notice with no key still sends (nothing to dedupe on)", async () => {
    const fake = seed();
    await sendManagerNoticeEmail(fake as unknown as SupabaseClient, { ...base, idempotencyKey: undefined });
    await sendManagerNoticeEmail(fake as unknown as SupabaseClient, { ...base, idempotencyKey: undefined });
    expect(sendEmails).toHaveBeenCalledTimes(2);
  });
});
