import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleteMetaDataForProviderUser = vi.hoisted(() => vi.fn(async (_db: unknown, _id: string) => 1));
vi.mock("@/lib/listing-channels/meta/connection.server", () => ({ deleteMetaDataForProviderUser }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));

import { POST } from "@/app/api/integrations/meta/data-deletion/route";
import {
  mintDeletionConfirmationCode,
  readDeletionConfirmationCode,
  verifyMetaSignedRequest,
} from "@/lib/listing-channels/meta/data-deletion";

const SECRET = "app-secret";

function signed(payload: Record<string, unknown>, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${sig}.${encoded}`;
}

function formRequest(signedRequest?: string): Request {
  const body = new URLSearchParams();
  if (signedRequest !== undefined) body.set("signed_request", signedRequest);
  return new Request("https://proplane.ai/api/integrations/meta/data-deletion", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("verifyMetaSignedRequest", () => {
  it("accepts a correctly signed request and returns the Meta user id", () => {
    expect(verifyMetaSignedRequest(signed({ user_id: "123", algorithm: "HMAC-SHA256" }), SECRET)?.user_id).toBe("123");
  });

  it("rejects a wrong secret, a tampered payload, a bad algorithm and malformed input", () => {
    expect(verifyMetaSignedRequest(signed({ user_id: "123" }, "other"), SECRET)).toBeNull();
    const [sig, payload] = signed({ user_id: "123" }).split(".");
    const tampered = Buffer.from(JSON.stringify({ user_id: "999" })).toString("base64url");
    expect(verifyMetaSignedRequest(`${sig}.${tampered}`, SECRET)).toBeNull();
    expect(verifyMetaSignedRequest(signed({ user_id: "1", algorithm: "HMAC-SHA1" }), SECRET)).toBeNull();
    expect(verifyMetaSignedRequest(signed({ nothing: true }), SECRET)).toBeNull();
    expect(verifyMetaSignedRequest(`${sig}.${payload}.extra`, SECRET)).toBeNull();
    expect(verifyMetaSignedRequest("", SECRET)).toBeNull();
    expect(verifyMetaSignedRequest(null, SECRET)).toBeNull();
    expect(verifyMetaSignedRequest(signed({ user_id: "1" }), "")).toBeNull();
  });
});

describe("deletion confirmation code", () => {
  it("is verifiable without a table and carries no Meta user id", () => {
    const now = 1_700_000_000_000;
    const code = mintDeletionConfirmationCode("123456789", SECRET, now);
    expect(code).not.toContain("123456789");
    expect(readDeletionConfirmationCode(code, SECRET)?.deletedAt).toBe(new Date(now).toISOString());
    expect(readDeletionConfirmationCode(code, "other")).toBeNull();
    expect(readDeletionConfirmationCode(`${code}x`, SECRET)).toBeNull();
    expect(readDeletionConfirmationCode(undefined, SECRET)).toBeNull();
  });
});

describe("POST /api/integrations/meta/data-deletion", () => {
  beforeEach(() => {
    process.env.META_APP_ID = "app";
    process.env.META_APP_SECRET = SECRET;
    deleteMetaDataForProviderUser.mockClear();
  });
  afterEach(() => {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  });

  it("deletes that user's data and answers { url, confirmation_code }", async () => {
    const res = await POST(formRequest(signed({ user_id: "42", algorithm: "HMAC-SHA256" })));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string; confirmation_code: string };
    expect(deleteMetaDataForProviderUser).toHaveBeenCalledWith(expect.anything(), "42");
    expect(json.url).toContain("/integrations/meta/data-deletion?code=");
    expect(readDeletionConfirmationCode(json.confirmation_code, SECRET)).not.toBeNull();
  });

  it("refuses an unsigned or wrongly signed request and deletes nothing", async () => {
    expect((await POST(formRequest(signed({ user_id: "42" }, "forged")))).status).toBe(400);
    expect((await POST(formRequest("garbage"))).status).toBe(400);
    expect((await POST(formRequest())).status).toBe(400);
    expect(deleteMetaDataForProviderUser).not.toHaveBeenCalled();
  });

  it("is a 503 when the Meta app is not configured", async () => {
    delete process.env.META_APP_SECRET;
    expect((await POST(formRequest(signed({ user_id: "42" })))).status).toBe(503);
  });
});
