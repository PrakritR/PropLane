import { describe, expect, it } from "vitest";
import {
  isSameOrigin,
  isViewAsExitRequest,
  isViewAsOperatorId,
  normalizeViewAsReason,
  parseViewAsOperatorIds,
  readViewAsSecret,
  signViewAsToken,
  VIEW_AS_TTL_SECONDS,
  verifyViewAsToken,
  viewAsBlocksRequest,
  viewAsDeniesPrivateBytes,
  viewAsKeepsRealIdentity,
  type ViewAsPayload,
} from "@/lib/auth/view-as-token";

const SECRET = "s".repeat(40);
const OTHER_SECRET = "t".repeat(40);
const NOW = 1_800_000_000_000;

function payload(overrides: Partial<ViewAsPayload> = {}): ViewAsPayload {
  const iat = Math.floor(NOW / 1000);
  return {
    v: 1,
    adminId: "admin-1",
    targetId: "target-1",
    portal: "manager",
    iat,
    exp: iat + VIEW_AS_TTL_SECONDS,
    sid: "sid-1",
    ...overrides,
  };
}

describe("view-as signed cookie", () => {
  it("round-trips a signed payload", async () => {
    const token = await signViewAsToken(payload(), SECRET);
    expect(await verifyViewAsToken(token, SECRET, { nowMs: NOW + 1000 })).toEqual(payload());
  });

  it("rejects a payload edited after signing (tampered target)", async () => {
    const token = await signViewAsToken(payload(), SECRET);
    const [body, sig] = token.split(".");
    const edited = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    edited.targetId = "someone-else";
    const forged = `${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${sig}`;
    expect(await verifyViewAsToken(forged, SECRET, { nowMs: NOW })).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signViewAsToken(payload(), OTHER_SECRET);
    expect(await verifyViewAsToken(token, SECRET, { nowMs: NOW })).toBeNull();
  });

  it("rejects the legacy unsigned shapes and junk", async () => {
    for (const junk of ["", "target-uid", "manager", "a.b", "a.b.c", ".", "x".repeat(3000)]) {
      expect(await verifyViewAsToken(junk, SECRET, { nowMs: NOW })).toBeNull();
    }
    expect(await verifyViewAsToken(undefined, SECRET)).toBeNull();
    expect(await verifyViewAsToken(null, SECRET)).toBeNull();
  });

  it("fails closed with no secret", async () => {
    const token = await signViewAsToken(payload(), SECRET);
    expect(await verifyViewAsToken(token, null, { nowMs: NOW })).toBeNull();
  });

  it("expires after the fixed 30 minutes, to the second", async () => {
    const token = await signViewAsToken(payload(), SECRET);
    const exp = payload().exp * 1000;
    expect(await verifyViewAsToken(token, SECRET, { nowMs: exp - 1000 })).not.toBeNull();
    expect(await verifyViewAsToken(token, SECRET, { nowMs: exp })).toBeNull();
    expect(await verifyViewAsToken(token, SECRET, { nowMs: exp + 60_000 })).toBeNull();
    // An expired token still proves WHICH session to close, never access.
    expect(await verifyViewAsToken(token, SECRET, { nowMs: exp + 60_000, allowExpired: true })).not.toBeNull();
  });

  it("refuses a signed token whose window is longer than 30 minutes", async () => {
    const long = payload({ exp: payload().iat + VIEW_AS_TTL_SECONDS + 1 });
    const token = await signViewAsToken(long, SECRET);
    expect(await verifyViewAsToken(token, SECRET, { nowMs: NOW })).toBeNull();
  });

  it("refuses a malformed payload even with a valid signature", async () => {
    const bad = { ...payload(), portal: "admin" } as unknown as ViewAsPayload;
    expect(await verifyViewAsToken(await signViewAsToken(bad, SECRET), SECRET, { nowMs: NOW })).toBeNull();
    const noSid = { ...payload(), sid: "" } as ViewAsPayload;
    expect(await verifyViewAsToken(await signViewAsToken(noSid, SECRET), SECRET, { nowMs: NOW })).toBeNull();
  });

  it("every portal, vendor included, round-trips", async () => {
    for (const portal of ["manager", "resident", "vendor"] as const) {
      const token = await signViewAsToken(payload({ portal }), SECRET);
      expect((await verifyViewAsToken(token, SECRET, { nowMs: NOW }))?.portal).toBe(portal);
    }
  });
});

describe("view-as secret and operator allowlist", () => {
  it("requires a 32+ character secret", () => {
    expect(readViewAsSecret({})).toBeNull();
    expect(readViewAsSecret({ PROPLANE_VIEW_AS_SECRET: "short" })).toBeNull();
    expect(readViewAsSecret({ PROPLANE_VIEW_AS_SECRET: SECRET })).toBe(SECRET);
  });

  it("empty or unset allowlist means nobody", () => {
    expect(parseViewAsOperatorIds({}).size).toBe(0);
    expect(parseViewAsOperatorIds({ PROPLANE_VIEW_AS_OPERATOR_IDS: " , ," }).size).toBe(0);
    expect(isViewAsOperatorId("admin-1", {})).toBe(false);
    expect(isViewAsOperatorId("", { PROPLANE_VIEW_AS_OPERATOR_IDS: "admin-1" })).toBe(false);
  });

  it("matches exact ids only", () => {
    const env = { PROPLANE_VIEW_AS_OPERATOR_IDS: "admin-1, admin-2" };
    expect(isViewAsOperatorId("admin-1", env)).toBe(true);
    expect(isViewAsOperatorId("admin-2", env)).toBe(true);
    expect(isViewAsOperatorId("admin-", env)).toBe(false);
    expect(isViewAsOperatorId("ADMIN-1", env)).toBe(false);
  });
});

describe("view-as reason", () => {
  it("is 3..300 characters after trimming and collapsing whitespace", () => {
    expect(normalizeViewAsReason(undefined)).toBeNull();
    expect(normalizeViewAsReason("")).toBeNull();
    expect(normalizeViewAsReason("  ab  ")).toBeNull();
    expect(normalizeViewAsReason("abc")).toBe("abc");
    expect(normalizeViewAsReason("  help   with\n rent  ")).toBe("help with rent");
    expect(normalizeViewAsReason("x".repeat(300))).toHaveLength(300);
    expect(normalizeViewAsReason("x".repeat(301))).toBeNull();
    expect(normalizeViewAsReason(42)).toBeNull();
  });
});

describe("view-as read-only guard: viewAsBlocksRequest", () => {
  const writes = ["POST", "PUT", "PATCH", "DELETE", "post", "Patch"];
  const reads = ["GET", "HEAD", "OPTIONS", "get"];
  const apiPaths = [
    "/api/property-records",
    "/api/portal-work-orders",
    "/api/manager-applications/abc",
    "/api/agent/chat",
    "/api/auth/set-active-portal",
    "/api/admin/preview/other",
    "/api/native/register-push-token",
  ];

  it("lets every read through", () => {
    for (const method of reads) {
      for (const path of [...apiPaths, "/portal/dashboard", "/resident"]) {
        expect(viewAsBlocksRequest(method, path), `${method} ${path}`).toBe(false);
      }
    }
  });

  it("refuses POST / PUT / PATCH / DELETE on /api/*", () => {
    for (const method of writes) {
      for (const path of apiPaths) {
        expect(viewAsBlocksRequest(method, path), `${method} ${path}`).toBe(true);
      }
    }
  });

  it("refuses server actions: a POST to a page path", () => {
    expect(viewAsBlocksRequest("POST", "/portal/dashboard")).toBe(true);
    expect(viewAsBlocksRequest("POST", "/resident/payments")).toBe(true);
    expect(viewAsBlocksRequest("POST", "/")).toBe(true);
  });

  it("allows exactly two exits: DELETE /api/admin/preview and POST /api/auth/sign-out", () => {
    expect(viewAsBlocksRequest("DELETE", "/api/admin/preview")).toBe(false);
    expect(viewAsBlocksRequest("DELETE", "/api/admin/preview/")).toBe(false);
    expect(viewAsBlocksRequest("POST", "/api/auth/sign-out")).toBe(false);
    expect(isViewAsExitRequest("DELETE", "/api/admin/preview")).toBe(true);
    // The start route and every sibling stay closed while a session is open.
    expect(viewAsBlocksRequest("POST", "/api/admin/preview")).toBe(true);
    expect(viewAsBlocksRequest("PATCH", "/api/admin/preview")).toBe(true);
    expect(viewAsBlocksRequest("DELETE", "/api/admin/preview/x")).toBe(true);
    expect(viewAsBlocksRequest("DELETE", "/api/auth/sign-out")).toBe(true);
    expect(viewAsBlocksRequest("POST", "/api/auth/sign-out/extra")).toBe(true);
    expect(viewAsBlocksRequest("POST", "//api//auth//sign-out")).toBe(false);
  });
});

describe("view-as private document bytes", () => {
  it("refuses signed-URL minting and byte routes", () => {
    for (const path of [
      "/api/manager-documents/doc-1/signed-url",
      "/api/resident/shared-documents/doc-1/signed-url",
      "/api/vendor/shared-documents/doc-1/signed-url",
      "/api/vendor/documents/signed-url",
      "/api/vendor/documents/file",
      "/api/vendor/onboarding/documents/signed-url",
      "/api/portal/inbox-attachments",
      "/api/manager-applications/app-1/pdf",
      "/api/manager-applications/app-1/receipt",
      "/api/owner/statements/pdf",
      "/api/owner/documents/doc-1/signed-url",
      "/api/reports/formal-documents/export",
    ]) {
      expect(viewAsDeniesPrivateBytes("GET", path), path).toBe(true);
    }
  });

  it("cannot be dodged with encoding, case or slashes", () => {
    expect(viewAsDeniesPrivateBytes("GET", "/api/manager-documents/doc-1/signed%2Durl")).toBe(true);
    expect(viewAsDeniesPrivateBytes("GET", "/api/manager-documents/doc-1/SIGNED-URL")).toBe(true);
    expect(viewAsDeniesPrivateBytes("GET", "/api//manager-documents/doc-1/signed-url/")).toBe(true);
    expect(viewAsDeniesPrivateBytes("GET", "/api/manager-documents/doc-1%2Fsigned-url")).toBe(true);
  });

  it("still lists document metadata", () => {
    expect(viewAsDeniesPrivateBytes("GET", "/api/manager-documents")).toBe(false);
    expect(viewAsDeniesPrivateBytes("GET", "/api/vendor/documents")).toBe(false);
    expect(viewAsDeniesPrivateBytes("GET", "/api/property-records")).toBe(false);
  });
});

describe("view-as identity scope and same-origin", () => {
  it("keeps the operator themselves on the admin console and auth routes", () => {
    expect(viewAsKeepsRealIdentity("/admin/dashboard")).toBe(true);
    expect(viewAsKeepsRealIdentity("/api/admin/preview")).toBe(true);
    expect(viewAsKeepsRealIdentity("/api/auth/sign-out")).toBe(true);
    expect(viewAsKeepsRealIdentity("/portal/dashboard")).toBe(false);
    expect(viewAsKeepsRealIdentity("/api/property-records")).toBe(false);
    expect(viewAsKeepsRealIdentity("/administrator")).toBe(false);
    expect(viewAsKeepsRealIdentity(null)).toBe(false);
  });

  it("requires an Origin that names the serving host", () => {
    const h = (o?: string, host = "proplane.ai") =>
      new Headers({ ...(o ? { origin: o } : {}), host });
    expect(isSameOrigin(h("https://proplane.ai"))).toBe(true);
    expect(isSameOrigin(h("https://evil.example"))).toBe(false);
    expect(isSameOrigin(h())).toBe(false);
    expect(isSameOrigin(h("not a url"))).toBe(false);
  });
});
