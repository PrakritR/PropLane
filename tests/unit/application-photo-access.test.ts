import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashResidentSetupToken } from "@/lib/auth/resident-setup-token";
import {
  MAX_APPLICATION_PHOTO_BYTES,
  validateApplicationPhotoUpload,
} from "@/lib/rental-application/application-photos";
import {
  applicationPhotoFolderKey,
  authorizeApplicationPhotoWrite,
  buildApplicationPhotoPath,
  canActorAccessApplicationPhoto,
  isPathInApplicationFolder,
  reclaimApplicationPhotos,
  type ApplicationPhotoActor,
  type ApplicationPhotoWriteTarget,
  type StoredApplicationOwnership,
} from "@/lib/rental-application/application-photos.server";

/**
 * The security-critical boundary for applicant ID / income photos: only the
 * applicant and the manager who received that application may reach the bytes.
 * `canActorAccessApplicationPhoto` is the single decision the read route makes
 * (after resolving actor + application from the session/DB), so proving it here
 * proves the boundary without a live database — the same shape as the
 * waiver-code isolation test.
 */

// Manager A owns `propA`; the application was submitted to `propA`.
const appForManagerA: StoredApplicationOwnership = {
  managerUserId: "mgr_A",
  propertyId: "propA",
  assignedPropertyId: null,
  residentEmail: "applicant@example.com",
};

const managerA: ApplicationPhotoActor = {
  kind: "manager",
  userId: "mgr_A",
  accessiblePropertyIds: new Set(["propA"]),
};

// Manager B owns only `propB` and is not attributed to the application.
const managerB: ApplicationPhotoActor = {
  kind: "manager",
  userId: "mgr_B",
  accessiblePropertyIds: new Set(["propB"]),
};

describe("canActorAccessApplicationPhoto — cross-manager isolation", () => {
  it("lets the owning manager view the photo (attribution AND property both match)", () => {
    expect(canActorAccessApplicationPhoto(managerA, appForManagerA)).toBe(true);
  });

  it("DENIES a different manager access to another manager's applicant's photo", () => {
    // mgr_B has no grant on propA and is not the attributed manager — the exact
    // boundary the task requires a test for. Must be false, no matter the URL.
    expect(canActorAccessApplicationPhoto(managerB, appForManagerA)).toBe(false);
  });

  it("still lets the CURRENT property owner in when attribution is stale (property transfer)", () => {
    // Attributed to mgr_A, but the property now belongs to mgr_B. Property
    // access is the source of truth (mirrors fetchApplicationsForManagerUser).
    const transferred: ApplicationPhotoActor = {
      kind: "manager",
      userId: "mgr_B",
      accessiblePropertyIds: new Set(["propA"]),
    };
    expect(canActorAccessApplicationPhoto(transferred, appForManagerA)).toBe(true);
  });

  it("lets the attributed manager in even after they no longer own the property", () => {
    const attributedOnly: ApplicationPhotoActor = {
      kind: "manager",
      userId: "mgr_A",
      accessiblePropertyIds: new Set(), // owns nothing now
    };
    expect(canActorAccessApplicationPhoto(attributedOnly, appForManagerA)).toBe(true);
  });

  it("matches on the assigned property id too", () => {
    const assignedElsewhere: StoredApplicationOwnership = {
      managerUserId: "mgr_A",
      propertyId: null,
      assignedPropertyId: "propAssigned",
      residentEmail: "applicant@example.com",
    };
    const withAssigned: ApplicationPhotoActor = {
      kind: "manager",
      userId: "mgr_B",
      accessiblePropertyIds: new Set(["propAssigned"]),
    };
    expect(canActorAccessApplicationPhoto(withAssigned, assignedElsewhere)).toBe(true);
  });
});

describe("canActorAccessApplicationPhoto — applicant + admin", () => {
  it("lets the applicant view their own photo (email matches, case-insensitive)", () => {
    const resident: ApplicationPhotoActor = { kind: "resident", email: "Applicant@Example.com" };
    expect(canActorAccessApplicationPhoto(resident, appForManagerA)).toBe(true);
  });

  it("DENIES a resident whose email does not match the application", () => {
    const other: ApplicationPhotoActor = { kind: "resident", email: "someone-else@example.com" };
    expect(canActorAccessApplicationPhoto(other, appForManagerA)).toBe(false);
  });

  it("DENIES a guest with a mismatched claimed email", () => {
    const guest: ApplicationPhotoActor = { kind: "guest", email: "attacker@example.com" };
    expect(canActorAccessApplicationPhoto(guest, appForManagerA)).toBe(false);
  });

  it("never matches an application that has no applicant email", () => {
    const resident: ApplicationPhotoActor = { kind: "resident", email: "" };
    const noEmailApp: StoredApplicationOwnership = { ...appForManagerA, residentEmail: null };
    expect(canActorAccessApplicationPhoto(resident, noEmailApp)).toBe(false);
  });

  it("lets an admin view any application's photo", () => {
    expect(canActorAccessApplicationPhoto({ kind: "admin" }, appForManagerA)).toBe(true);
  });
});

describe("path containment + upload validation", () => {
  it("builds an unguessable path inside the application's own folder", () => {
    const path = buildApplicationPhotoPath("PROPLANE-ABC123", "idFront", "jpg");
    expect(isPathInApplicationFolder(path, "PROPLANE-ABC123")).toBe(true);
    expect(path.endsWith(".jpg")).toBe(true);
    // Two builds never collide.
    expect(buildApplicationPhotoPath("PROPLANE-ABC123", "idFront", "jpg")).not.toBe(path);
  });

  it("rejects a stored path that does not belong to the named application (no traversal)", () => {
    const otherPath = buildApplicationPhotoPath("PROPLANE-OTHER", "idFront", "jpg");
    expect(isPathInApplicationFolder(otherPath, "PROPLANE-ABC123")).toBe(false);
    expect(isPathInApplicationFolder("application/../secrets/x.jpg", "PROPLANE-ABC123")).toBe(false);
    expect(isPathInApplicationFolder("application/PROPLANE-ABC123/../PROPLANE-OTHER/x.jpg", "PROPLANE-ABC123")).toBe(false);
    expect(isPathInApplicationFolder("application/PROPLANE-ABC123/%2e%2e%2fsecret.jpg", "PROPLANE-ABC123")).toBe(false);
  });

  it("enforces the MIME allowlist per slot (ID photos are images only)", () => {
    // Allowed for income proof …
    expect(validateApplicationPhotoUpload("income", "application/pdf", 1024).ok).toBe(true);
    // … but not for an ID photo slot.
    expect(validateApplicationPhotoUpload("idFront", "application/pdf", 1024).ok).toBe(false);
  });

  it("rejects a disallowed MIME type", () => {
    expect(validateApplicationPhotoUpload("idFront", "image/svg+xml", 1024).ok).toBe(false);
    expect(validateApplicationPhotoUpload("idFront", null, 1024).ok).toBe(false);
  });

  it("rejects an empty or oversized declared file", () => {
    expect(validateApplicationPhotoUpload("idFront", "image/jpeg", 0).ok).toBe(false);
    expect(validateApplicationPhotoUpload("idFront", "image/jpeg", MAX_APPLICATION_PHOTO_BYTES + 1).ok).toBe(false);
    expect(validateApplicationPhotoUpload("idFront", "image/jpeg", undefined).ok).toBe(false);
  });

  it("accepts a valid JPEG upload declaration", () => {
    const result = validateApplicationPhotoUpload("idFront", "image/jpeg", 4096);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mime).toBe("image/jpeg");
      expect(result.ext).toBe("jpg");
    }
  });
});

/**
 * Write (sign-upload / delete) authorization. Guests hold no session, so their
 * ONLY credential is the row's unguessable resident-setup token — a claimed
 * email must never grant a write (no email oracle), a nonexistent row must
 * never be writable, and a decided application is immutable to everyone but an
 * admin (retention Option A: the photos are the manager's record).
 */
describe("authorizeApplicationPhotoWrite", () => {
  const validToken = "guest-setup-token-abc123";
  const pendingRow: ApplicationPhotoWriteTarget = {
    ownership: appForManagerA,
    bucket: "pending",
    setupTokenHash: hashResidentSetupToken(validToken),
    setupTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    setupTokenConsumedAt: null,
  };
  const guest: ApplicationPhotoActor = { kind: "guest", email: "" };
  const applicant: ApplicationPhotoActor = { kind: "resident", email: "applicant@example.com" };

  it("allows a guest holding the row's valid setup token", () => {
    expect(authorizeApplicationPhotoWrite({ actor: guest, row: pendingRow, setupToken: validToken })).toBe(true);
  });

  it("DENIES a guest with a wrong or missing token — even one claiming the matching email", () => {
    const claiming: ApplicationPhotoActor = { kind: "guest", email: "applicant@example.com" };
    expect(authorizeApplicationPhotoWrite({ actor: claiming, row: pendingRow, setupToken: "wrong" })).toBe(false);
    expect(authorizeApplicationPhotoWrite({ actor: claiming, row: pendingRow })).toBe(false);
  });

  it("DENIES a guest when the token is expired or consumed", () => {
    const expired = { ...pendingRow, setupTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() };
    expect(authorizeApplicationPhotoWrite({ actor: guest, row: expired, setupToken: validToken })).toBe(false);
    const consumed = { ...pendingRow, setupTokenConsumedAt: new Date().toISOString() };
    expect(authorizeApplicationPhotoWrite({ actor: guest, row: consumed, setupToken: validToken })).toBe(false);
  });

  it("DENIES every actor when no stored row exists (no unbounded upload path)", () => {
    expect(authorizeApplicationPhotoWrite({ actor: guest, row: null, setupToken: validToken })).toBe(false);
    expect(authorizeApplicationPhotoWrite({ actor: applicant, row: null })).toBe(false);
    expect(authorizeApplicationPhotoWrite({ actor: managerA, row: null })).toBe(false);
  });

  it("allows the applicant and the owning manager on a pending row", () => {
    expect(authorizeApplicationPhotoWrite({ actor: applicant, row: pendingRow })).toBe(true);
    expect(authorizeApplicationPhotoWrite({ actor: managerA, row: pendingRow })).toBe(true);
  });

  it("allows a multi-role login via the authenticated session email", () => {
    const otherRoleManager: ApplicationPhotoActor = {
      kind: "manager",
      userId: "mgr_other",
      accessiblePropertyIds: new Set(),
    };
    expect(
      authorizeApplicationPhotoWrite({
        actor: otherRoleManager,
        row: pendingRow,
        sessionEmail: "applicant@example.com",
      }),
    ).toBe(true);
  });

  it("DENIES the applicant a destructive write once the application is decided (retention)", () => {
    for (const bucket of ["approved", "rejected"]) {
      expect(authorizeApplicationPhotoWrite({ actor: applicant, row: { ...pendingRow, bucket } })).toBe(false);
    }
  });

  it("DENIES the manager on a decided row too — only admin may override", () => {
    const approved = { ...pendingRow, bucket: "approved" };
    expect(authorizeApplicationPhotoWrite({ actor: managerA, row: approved })).toBe(false);
    expect(authorizeApplicationPhotoWrite({ actor: { kind: "admin" }, row: approved })).toBe(true);
  });

  it("DENIES a foreign manager and a mismatched resident even on a pending row", () => {
    expect(authorizeApplicationPhotoWrite({ actor: managerB, row: pendingRow })).toBe(false);
    const other: ApplicationPhotoActor = { kind: "resident", email: "someone-else@example.com" };
    expect(authorizeApplicationPhotoWrite({ actor: other, row: pendingRow })).toBe(false);
  });
});

/**
 * Retention is Option A (captain): photos live only as long as the application
 * row, and deleting the application is the ONLY thing that removes them — so a
 * delete MUST take the real storage bytes, not just the DB row, or ID photos of
 * rejected applicants accumulate forever with nothing pointing at them. This
 * proves the reclaim removes exactly the application's own objects and never
 * another application's folder.
 */
describe("reclaimApplicationPhotos — an application delete removes the bytes", () => {
  function makeFakeStorage(filesByFolder: Record<string, string[]>) {
    const listedFolders: string[] = [];
    const removedPaths: string[] = [];
    const db = {
      storage: {
        from() {
          return {
            async list(folder: string) {
              listedFolders.push(folder);
              const names = filesByFolder[folder] ?? [];
              return { data: names.map((name) => ({ name })), error: null };
            },
            async remove(paths: string[]) {
              removedPaths.push(...paths);
              return { data: null, error: null };
            },
          };
        },
      },
    } as unknown as SupabaseClient;
    return { db, listedFolders, removedPaths };
  }

  it("removes every object under the application's own folder", async () => {
    const appId = "PROPLANE-ABC123";
    const folder = `application/${applicationPhotoFolderKey(appId)}`;
    const { db, listedFolders, removedPaths } = makeFakeStorage({
      [folder]: ["idFront-1-uuid.jpg", "idBack-2-uuid.jpg", "income-3-uuid.pdf"],
      "application/PROPLANE-OTHER": ["idFront-9-uuid.jpg"], // a different applicant's photos
    });

    await reclaimApplicationPhotos(db, appId);

    expect(listedFolders).toContain(folder);
    expect(removedPaths).toEqual([
      `${folder}/idFront-1-uuid.jpg`,
      `${folder}/idBack-2-uuid.jpg`,
      `${folder}/income-3-uuid.pdf`,
    ]);
    // Never touches another application's folder.
    expect(removedPaths.every((p) => p.startsWith(`${folder}/`))).toBe(true);
    expect(removedPaths.some((p) => p.includes("PROPLANE-OTHER"))).toBe(false);
  });

  it("no-ops cleanly when the application has no photos", async () => {
    const { db, removedPaths } = makeFakeStorage({});
    await reclaimApplicationPhotos(db, "PROPLANE-EMPTY");
    expect(removedPaths).toEqual([]);
  });
});
