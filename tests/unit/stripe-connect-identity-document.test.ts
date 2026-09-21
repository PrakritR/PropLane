// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The identity-document proxy forwards bytes straight to Stripe Files and
 * returns only the resulting file id — it must never write the file (or any
 * derived record of it) to our own database or storage.
 */

const payout = {
  payoutOwnerUserId: "owner-1",
  canEditBankAccount: true,
  isCoManagerForPayout: false,
  unresolvedReason: undefined as string | undefined,
};
vi.mock("@/lib/auth/manager-stripe-payout-access.server", () => ({
  resolveStripePayoutContext: async () => payout,
  stripePayoutContextError: () => "unresolved",
}));
vi.mock("@/lib/auth/co-manager-bank-account-access", () => ({
  assertCoManagerBankAccountAccess: async () => ({ ok: true }),
}));

let callerId = "owner-1";
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: callerId } } }) },
  }),
}));

const serviceDbCalls: string[] = [];
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      serviceDbCalls.push(table);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "owner@example.com" } }) }) }) };
    },
    // No `.storage` on purpose — a route that tried to upload to our own
    // storage would throw here rather than silently succeeding.
  }),
}));

const filesCreate = vi.fn().mockResolvedValue({ id: "file_abc123" });
const stripe = { files: { create: filesCreate } };
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe }));
vi.mock("@/lib/stripe-connect-account", () => ({
  ensureManagerConnectAccountId: vi.fn().mockResolvedValue("acct_1"),
}));

import { POST } from "@/app/api/stripe/connect/identity/document/route";

beforeEach(() => {
  vi.clearAllMocks();
  filesCreate.mockResolvedValue({ id: "file_abc123" });
  serviceDbCalls.length = 0;
  callerId = "owner-1";
  payout.payoutOwnerUserId = "owner-1";
});

function multipartRequest(file: File): Request {
  const form = new FormData();
  form.append("file", file);
  return new Request("http://x/api/stripe/connect/identity/document", { method: "POST", body: form });
}

describe("POST /api/stripe/connect/identity/document", () => {
  it("proxies the file to Stripe Files (purpose identity_document) and returns only the file id — never persisted locally", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "id.jpg", { type: "image/jpeg" });
    const res = await POST(multipartRequest(file));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ fileId: "file_abc123" });

    expect(filesCreate).toHaveBeenCalledTimes(1);
    const [params, options] = filesCreate.mock.calls[0]!;
    expect(params.purpose).toBe("identity_document");
    expect(options).toMatchObject({ stripeAccount: "acct_1" });

    // Only ever reads `profiles` (for the owner's email) — nothing writes a
    // document/file/upload record anywhere in our own database.
    expect(serviceDbCalls).toEqual(["profiles"]);
  });

  it("403s a caller who is not the payout owner", async () => {
    callerId = "someone-else";
    const file = new File([new Uint8Array([1])], "id.jpg", { type: "image/jpeg" });
    const res = await POST(multipartRequest(file));
    expect(res.status).toBe(403);
    expect(filesCreate).not.toHaveBeenCalled();
  });

  it("rejects a disallowed file type before ever calling Stripe", async () => {
    const file = new File([new Uint8Array([1])], "id.txt", { type: "text/plain" });
    const res = await POST(multipartRequest(file));
    expect(res.status).toBe(400);
    expect(filesCreate).not.toHaveBeenCalled();
  });
});
