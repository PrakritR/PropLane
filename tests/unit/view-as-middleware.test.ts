import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  signViewAsToken,
  VIEW_AS_COOKIE,
  VIEW_AS_TTL_SECONDS,
  type ViewAsPayload,
} from "@/lib/auth/view-as-token";
import { middleware } from "@/middleware";

const SECRET = "m".repeat(40);

function payload(overrides: Partial<ViewAsPayload> = {}): ViewAsPayload {
  const iat = Math.floor(Date.now() / 1000);
  return { v: 1, adminId: "admin-1", targetId: "t-1", portal: "manager", iat, exp: iat + VIEW_AS_TTL_SECONDS, sid: "s-1", ...overrides };
}

async function request(method: string, path: string, cookie?: string) {
  return new NextRequest(`https://proplane.ai${path}`, {
    method,
    headers: cookie ? { cookie: `${VIEW_AS_COOKIE}=${cookie}` } : {},
  });
}

const ORIGINAL = process.env.PROPLANE_VIEW_AS_SECRET;
beforeEach(() => {
  process.env.PROPLANE_VIEW_AS_SECRET = SECRET;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PROPLANE_VIEW_AS_SECRET;
  else process.env.PROPLANE_VIEW_AS_SECRET = ORIGINAL;
});

describe("middleware read-only guard while viewing as", () => {
  it("returns 403 read_only_view_as for POST / PATCH / PUT / DELETE on /api/*", async () => {
    const good = await signViewAsToken(payload(), SECRET);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      for (const path of ["/api/property-records", "/api/portal-work-orders", "/api/auth/set-active-portal", "/api/agent/chat"]) {
        const res = await middleware(await request(method, path, good));
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await res.json()).toEqual({ error: "read_only_view_as" });
      }
    }
  });

  it("refuses a server action: a POST to a page", async () => {
    const good = await signViewAsToken(payload(), SECRET);
    const res = await middleware(await request("POST", "/portal/dashboard", good));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "read_only_view_as" });
  });

  it("lets the two exits through: DELETE /api/admin/preview and POST /api/auth/sign-out", async () => {
    const good = await signViewAsToken(payload(), SECRET);
    const end = await middleware(await request("DELETE", "/api/admin/preview", good));
    expect(end.status).not.toBe(403);
    const out = await middleware(await request("POST", "/api/auth/sign-out", good));
    expect(out.status).not.toBe(403);
  });

  it("does not let the start route be used to swap sessions mid-view", async () => {
    const good = await signViewAsToken(payload(), SECRET);
    const res = await middleware(await request("POST", "/api/admin/preview", good));
    expect(res.status).toBe(403);
  });

  it("leaves reads alone", async () => {
    const good = await signViewAsToken(payload(), SECRET);
    for (const path of ["/api/property-records", "/api/manager-documents"]) {
      const res = await middleware(await request("GET", path, good));
      expect(res.status, path).not.toBe(403);
    }
  });

  it("refuses signed-URL minting and document bytes on GET", async () => {
    const good = await signViewAsToken(payload(), SECRET);
    const res = await middleware(await request("GET", "/api/manager-documents/doc-1/signed-url", good));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "read_only_view_as" });
  });

  it("vendor sessions are read-only too", async () => {
    const good = await signViewAsToken(payload({ portal: "vendor" }), SECRET);
    const res = await middleware(await request("POST", "/api/vendor/invoices", good));
    expect(res.status).toBe(403);
  });

  it("ignores a tampered, expired, wrong-secret or garbage cookie (no lock-out)", async () => {
    const signed = await signViewAsToken(payload(), SECRET);
    const [body] = signed.split(".");
    const cookies = [
      `${body}.AAAA`,
      await signViewAsToken(payload(), "z".repeat(40)),
      await signViewAsToken(payload({ iat: 1_000, exp: 1_000 + VIEW_AS_TTL_SECONDS }), SECRET),
      "target-uid-legacy",
    ];
    for (const cookie of cookies) {
      const res = await middleware(await request("POST", "/api/anything", cookie));
      expect(res.status).not.toBe(403);
    }
  });

  it("does nothing without a secret configured, even for a well-formed cookie", async () => {
    const good = await signViewAsToken(payload(), SECRET);
    delete process.env.PROPLANE_VIEW_AS_SECRET;
    const res = await middleware(await request("POST", "/api/anything", good));
    expect(res.status).not.toBe(403);
  });

  it("does nothing when no cookie is present", async () => {
    const res = await middleware(await request("POST", "/api/property-records"));
    expect(res.status).not.toBe(403);
  });
});
