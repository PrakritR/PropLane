import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import { createDocumentShareLink, resolveDocumentShareToken } from "@/lib/documents/document-share-links.server";
import { createPortalRecordShareLink, resolvePortalRecordShareToken } from "@/lib/portal-record-share-links.server";
import { hashShareToken, isMissingTokenHashColumn } from "@/lib/share-token-hash";
import { linksFakeDb } from "../helpers/links-fake-db";

const sha = (token: string) => createHash("sha256").update(token).digest("hex");
const FUTURE = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

describe("record share links store a hash, not the token", () => {
  it("creates a link with only token_hash and hands the raw token back once", async () => {
    const { db, rows, writes } = linksFakeDb();
    const link = await createPortalRecordShareLink(db, {
      recordKind: "lease", recordId: "lease-1", managerUserId: "mgr", createdBy: "mgr",
    });
    expect(link.shareToken).toHaveLength(32);
    const stored = rows.portal_record_share_links![0]!;
    expect(stored.token_hash).toBe(sha(link.shareToken));
    expect(stored).not.toHaveProperty("share_token");
    expect(JSON.stringify(writes)).not.toContain(link.shareToken);
  });

  it("resolves a new link by its hash", async () => {
    const { db } = linksFakeDb();
    const link = await createPortalRecordShareLink(db, { recordKind: "application", recordId: "app-1", managerUserId: "mgr", createdBy: "mgr" });
    const resolved = await resolvePortalRecordShareToken(db, link.shareToken);
    expect(resolved?.link.recordId).toBe("app-1");
    expect(await resolvePortalRecordShareToken(db, `${link.shareToken}x`)).toBeNull();
  });

  it("a link from before the migration (raw token, no hash) still resolves", async () => {
    const { db } = linksFakeDb({
      portal_record_share_links: [
        { id: "l1", record_kind: "lease", record_id: "lease-9", manager_user_id: "mgr", share_token: "legacy-raw-token", token_hash: null, expires_at: FUTURE, created_at: PAST, revoked_at: null, access_count: 0, created_by: "mgr" },
      ],
    });
    expect((await resolvePortalRecordShareToken(db, "legacy-raw-token"))?.link.recordId).toBe("lease-9");
  });

  it("a backfilled row resolves by hash even after the raw column is cleared", async () => {
    const { db } = linksFakeDb({
      portal_record_share_links: [
        { id: "l1", record_kind: "lease", record_id: "lease-9", manager_user_id: "mgr", share_token: null, token_hash: sha("tok-abc"), expires_at: FUTURE, created_at: PAST, revoked_at: null, access_count: 0, created_by: "mgr" },
      ],
    });
    expect((await resolvePortalRecordShareToken(db, "tok-abc"))?.link.recordId).toBe("lease-9");
  });

  it("expired and revoked links do not resolve", async () => {
    const { db } = linksFakeDb({
      portal_record_share_links: [
        { id: "l1", record_kind: "lease", record_id: "a", manager_user_id: "m", share_token: null, token_hash: sha("expired"), expires_at: PAST, revoked_at: null, access_count: 0, created_by: "m" },
        { id: "l2", record_kind: "lease", record_id: "b", manager_user_id: "m", share_token: null, token_hash: sha("revoked"), expires_at: FUTURE, revoked_at: PAST, access_count: 0, created_by: "m" },
      ],
    });
    expect(await resolvePortalRecordShareToken(db, "expired")).toBeNull();
    expect(await resolvePortalRecordShareToken(db, "revoked")).toBeNull();
  });

  it("code ahead of its migration falls back to the raw column and still works", async () => {
    const { db, rows } = linksFakeDb({}, { missingColumns: { portal_record_share_links: ["token_hash"] } });
    const link = await createPortalRecordShareLink(db, { recordKind: "lease", recordId: "lease-2", managerUserId: "mgr", createdBy: "mgr" });
    expect(rows.portal_record_share_links![0]!.share_token).toBe(link.shareToken);
    expect((await resolvePortalRecordShareToken(db, link.shareToken))?.link.recordId).toBe("lease-2");
  });
});

describe("document share links store a hash, not the token", () => {
  it("creates with token_hash only and resolves by hash, legacy rows included", async () => {
    const { db, rows } = linksFakeDb({
      manager_documents: [{ id: "doc-1", display_name: "Lease.pdf", mime_type: "application/pdf", storage_path: "p", manager_user_id: "mgr", deleted_at: null }],
      document_share_links: [
        { id: "old", document_id: "doc-1", manager_user_id: "mgr", share_token: "legacy-doc-token", token_hash: null, expires_at: FUTURE, revoked_at: null, access_count: 0 },
      ],
    });
    const link = await createDocumentShareLink(db, { documentId: "doc-1", managerUserId: "mgr", createdBy: "mgr" });
    const created = rows.document_share_links!.find((r) => r.id !== "old")!;
    expect(created.token_hash).toBe(sha(link.shareToken));
    expect(created).not.toHaveProperty("share_token");
    expect((await resolveDocumentShareToken(db, link.shareToken))?.document.id).toBe("doc-1");
    expect((await resolveDocumentShareToken(db, "legacy-doc-token"))?.document.id).toBe("doc-1");
    expect(await resolveDocumentShareToken(db, "nope")).toBeNull();
  });
});

describe("token hashing helpers", () => {
  it("hashes the trimmed token as SHA-256 hex", () => {
    expect(hashShareToken("  abc ")).toBe(sha("abc"));
  });
  it("recognises only a missing token_hash column", () => {
    expect(isMissingTokenHashColumn({ code: "42703", message: "column x.token_hash does not exist" })).toBe(true);
    expect(isMissingTokenHashColumn({ code: "PGRST204", message: "" })).toBe(true);
    expect(isMissingTokenHashColumn({ code: "42703", message: "column other does not exist" })).toBe(false);
    expect(isMissingTokenHashColumn({ code: "23505", message: "duplicate" })).toBe(false);
    expect(isMissingTokenHashColumn(null)).toBe(false);
  });
});
