/**
 * vendor-ready-1025, Builder C: the vendor job paths a multi-role / unlinked / directly assigned
 * vendor hits. Each block pins one failure the plan named.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  access: { user: { id: "u1" }, profile: { role: "manager" }, roles: ["manager", "vendor"], effectiveRole: "vendor" } as Record<string, unknown>,
  events: [] as Array<Record<string, unknown>>,
  invites: [] as Array<Record<string, unknown>>,
  inviteOk: true,
}));

vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: async () => hoisted.access,
  hasRole: () => true,
}));
vi.mock("@/lib/auth/admin-preview", () => ({ getAdminPreviewFromCookies: async () => null, isAdminUser: async () => false }));
vi.mock("@/lib/auth/effective-session", () => ({ getEffectiveUserIdForPortal: async () => null }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/work-order-events.server", () => ({
  workOrderEvent: async (_db: unknown, input: Record<string, unknown>) => {
    hoisted.events.push(input);
    return { duplicate: false };
  },
}));
vi.mock("@/lib/vendor-invite.server", () => ({
  sendVendorInvite: async (_db: unknown, opts: Record<string, unknown>) => {
    hoisted.invites.push(opts);
    return hoisted.inviteOk ? { ok: true, emailId: "e1", linkUrl: "https://x/invite" } : { ok: false, status: 503, error: "no email", mailtoHref: "", linkUrl: "" };
  },
}));
vi.mock("@/lib/work-order-resident-confirmation.server", () => ({ requestResidentConfirmation: async () => null }));
vi.mock("@/lib/work-order-vendor-invoice.server", () => ({ ensureSubmittedVendorInvoiceForMarkedDone: async () => undefined }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({ resolvePropertyScopedManagerRecipientIds: async () => ["m1"] }));
vi.mock("@/lib/service-automation-settings.server", () => ({ resolveServiceAutomationSettingsForRow: async () => null }));
vi.mock("@/lib/service-work-board.server", () => ({ revealHeldVendorContact: async () => undefined }));

import { resolveSessionActorRole } from "@/lib/auth/vendor-api-access";
import { MAX_COMPLETION_PHOTO_BYTES, validateCompletionPhotos } from "@/lib/completion-photos";
import { markWorkOrderDoneByVendor, scheduleAssignedVisit, bookedVisitPatch } from "@/lib/work-order-bids.server";
import { sendWorkOrderVendorOffers } from "@/lib/work-order-offers.server";
import { describeVendorSendOutcome } from "@/lib/work-order-vendor-offers";
import { projectWorkOrderForHiredVendor, projectWorkOrderForOfferedVendor, assignedVendorDirectoryId, normalizeAssignedVendorAssignee, vendorVisibleGeneralArea, vendorLeadMapsQuery, vendorServiceWorkflowSteps } from "@/lib/work-order-vendor-privacy";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

type Rec = Record<string, unknown>;

/** A chainable fake: every builder method returns itself; awaiting or maybeSingle() yields the table's canned result. */
function fakeDb(tables: Record<string, { rows?: unknown; single?: unknown; error?: { message: string } | null }>, log: Array<{ table: string; op: string; row?: Rec }> = []) {
  return {
    from(table: string) {
      const t = tables[table] ?? {};
      const result = () => ({ data: t.rows ?? [], error: t.error ?? null });
      const builder: Rec = {};
      for (const m of ["select", "eq", "neq", "in", "is", "not", "gt", "limit", "order", "or"]) builder[m] = () => builder;
      builder.maybeSingle = async () => ({ data: t.single ?? null, error: null });
      builder.update = (row: Rec) => {
        log.push({ table, op: "update", row });
        return builder;
      };
      builder.upsert = (row: Rec) => {
        log.push({ table, op: "upsert", row });
        return Promise.resolve({ error: null });
      };
      builder.insert = (row: Rec) => {
        log.push({ table, op: "insert", row });
        return Promise.resolve({ error: null });
      };
      builder.delete = () => {
        log.push({ table, op: "delete" });
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) => resolve(result());
      return builder;
    },
  } as never;
}

const actor = (over: Partial<{ userId: string; role: string; admin: boolean }> = {}) => ({
  userId: "v1",
  email: "v@x.com",
  fullName: "Vee",
  admin: false,
  role: "vendor",
  ...over,
});

beforeEach(() => {
  hoisted.events.length = 0;
  hoisted.invites.length = 0;
  hoisted.inviteOk = true;
  hoisted.access = { user: { id: "u1" }, profile: { role: "manager" }, roles: ["manager", "vendor"], effectiveRole: "vendor" };
});

describe("R1: multi-role vendor resolves as vendor from the portal, not profiles.role", () => {
  it("a manager+vendor in the vendor portal acts as vendor; in the manager portal as manager", async () => {
    expect(await resolveSessionActorRole("manager")).toBe("vendor");
    hoisted.access = { ...hoisted.access, effectiveRole: "manager" };
    expect(await resolveSessionActorRole("manager")).toBe("manager");
  });
  it("does not grant a role from legacy metadata when no stored role exists", async () => {
    hoisted.access = { user: { id: "u1" }, profile: null, roles: [], effectiveRole: null };
    expect(await resolveSessionActorRole("Vendor")).toBe("");
  });
  it("the job routes and bids library no longer read profiles.role directly", async () => {
    const fs = await import("node:fs");
    for (const f of [
      "src/app/api/portal/work-order-vendor-offers/route.ts",
      "src/app/api/portal/work-order-bids/route.ts",
      "src/app/api/portal/work-orders/mark-done/route.ts",
      "src/app/api/portal/work-orders/set-vendor-price/route.ts",
      "src/app/api/vendor/availability/route.ts",
    ]) {
      expect(fs.readFileSync(f, "utf8"), f).toContain("resolveSessionActorRole");
      expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/String\(profile\?\.role \?\? user\.user_metadata\?\.role \?\? ""\)\.toLowerCase\(\)/);
    }
    // The payment follow-up is vendor-only, so it asks profile_roles for the vendor role itself.
    const paymentNotify = fs.readFileSync("src/app/api/vendor/work-orders/payment-notify/route.ts", "utf8");
    expect(paymentNotify).toContain("requireVendorApiAccess");
    expect(paymentNotify).not.toMatch(/String\(profile\?\.role \?\? user\.user_metadata\?\.role \?\? ""\)\.toLowerCase\(\)/);
    expect(fs.readFileSync("src/app/api/portal-work-orders/route.ts", "utf8")).toContain("isVendorPortalRequest");
  });
});

describe("J1: an offer to a roster vendor with no account is reported, never silently 'requested'", () => {
  const workOrderRow = { id: "wo1", title: "Leaky tap", reference: "WO-1", bucket: "open", propertyName: "5257 Brooklyn" };
  function offerDb(vendors: Array<{ id: string; vendor_user_id: string | null; email: string; name: string }>, log: Array<{ table: string; op: string; row?: Rec }> = []) {
    return fakeDb(
      {
        portal_work_order_records: { single: { manager_user_id: "m1", row_data: workOrderRow } },
        work_order_bids: { rows: [] },
        manager_vendor_records: {
          rows: vendors.map((v) => ({ id: v.id, manager_user_id: "m1", vendor_user_id: v.vendor_user_id, row_data: { name: v.name, email: v.email } })),
        },
        work_order_vendor_offers: { rows: [] },
      },
      log,
    );
  }
  const mgr = { userId: "m1", email: "m@x.com", fullName: "Mo", admin: false, role: "manager" };

  it("emails the sign-up invite with the job and reports the vendor as invited", async () => {
    const result = await sendWorkOrderVendorOffers(offerDb([{ id: "d1", vendor_user_id: null, email: "joe@elec.com", name: "Joe's Electric" }]), mgr, {
      workOrderId: "wo1",
      vendorIds: ["d1"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invited).toEqual([{ id: "d1", name: "Joe's Electric" }]);
    expect(result.skippedDetails).toEqual([]);
    expect(hoisted.invites[0]).toMatchObject({ vendorId: "d1", vendorEmail: "joe@elec.com" });
    expect(String(hoisted.invites[0]!.jobLine)).toContain("Leaky tap");
    expect(describeVendorSendOutcome({ ok: true, ...result })).toBe("Invited Joe's Electric and sent the job.");
  });

  it("skips a vendor with no email and no account, naming the reason", async () => {
    const log: Array<{ table: string; op: string; row?: Rec }> = [];
    const result = await sendWorkOrderVendorOffers(offerDb([{ id: "d2", vendor_user_id: null, email: "", name: "Ace Roofing" }], log), mgr, {
      workOrderId: "wo1",
      vendorIds: ["d2"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sent).toEqual([]);
    expect(result.skippedDetails).toEqual([{ id: "d2", name: "Ace Roofing", reason: "no email or account" }]);
    expect(hoisted.invites).toHaveLength(0);
    expect(log.some((l) => l.op === "upsert")).toBe(false);
    expect(describeVendorSendOutcome({ ok: true, ...result })).toBe("Skipped Ace Roofing: no email or account.");
  });

  it("a failed invite email is a skip, not a success, and leaves no live offer behind", async () => {
    hoisted.inviteOk = false;
    const log: Array<{ table: string; op: string; row?: Rec }> = [];
    const result = await sendWorkOrderVendorOffers(offerDb([{ id: "d3", vendor_user_id: null, email: "a@b.co", name: "Bee" }], log), mgr, { workOrderId: "wo1", vendorIds: ["d3"] });
    if (!result.ok) throw new Error("expected ok");
    expect(result.sent).toEqual([]);
    expect(result.skippedDetails[0]!.reason).toMatch(/invite email/);
    // The row written before the invite is taken back: the manager was told nothing was sent to this vendor.
    expect(log.filter((l) => l.table === "work_order_vendor_offers").map((l) => l.op)).toEqual(["upsert", "delete"]);
  });

  it("J6a/b: a linked vendor is notified with a job link, and a re-offer carries a new event id", async () => {
    const db = () => offerDb([{ id: "d4", vendor_user_id: "vu4", email: "l@x.com", name: "Linked" }]);
    await sendWorkOrderVendorOffers(db(), mgr, { workOrderId: "wo1", vendorIds: ["d4"] });
    await new Promise((r) => setTimeout(r, 5));
    await sendWorkOrderVendorOffers(db(), mgr, { workOrderId: "wo1", vendorIds: ["d4"] });
    const vendorEvents = hoisted.events.filter((e) => e.event === "vendor_offered" && !String(e.eventId).endsWith(":manager"));
    expect(vendorEvents).toHaveLength(2);
    expect(vendorEvents[0]!.eventId).not.toBe(vendorEvents[1]!.eventId);
    expect((vendorEvents[0]!.facts as Rec).url).toMatch(/\/vendor\/work-orders$/);
  });
});

describe("J1 toast copy", () => {
  it("names who was requested, invited and skipped", () => {
    expect(
      describeVendorSendOutcome(
        { ok: true, sent: ["a", "b"], invited: [{ id: "b", name: "Joe's Electric" }], skippedDetails: [{ id: "c", name: "Ace Roofing", reason: "no email or account" }] },
        (id) => (id === "a" ? "Pat Plumbing" : ""),
      ),
    ).toBe("Requested Pat Plumbing. Invited Joe's Electric and sent the job. Skipped Ace Roofing: no email or account.");
    expect(describeVendorSendOutcome({ ok: true, sent: [] })).toBe("No vendors could be requested.");
  });
});

describe("J3: completion photos", () => {
  const jpeg = (bytes: number) => `data:image/jpeg;base64,${"A".repeat(Math.ceil((bytes * 4) / 3))}`;
  it("accepts a normal photo, rejects none / non-image with 400 and oversize with 413", () => {
    expect(validateCompletionPhotos([jpeg(50_000)]).ok).toBe(true);
    expect(validateCompletionPhotos([])).toMatchObject({ ok: false, status: 400 });
    expect(validateCompletionPhotos(["data:text/html;base64,AAAA"])).toMatchObject({ ok: false, status: 400 });
    expect(validateCompletionPhotos(["data:image/svg+xml;base64,AAAA"])).toMatchObject({ ok: false, status: 400 });
    expect(validateCompletionPhotos([jpeg(MAX_COMPLETION_PHOTO_BYTES + 4096)])).toMatchObject({ ok: false, status: 413 });
  });

  it("status and photos are written in ONE update; a failed write leaves nothing else done", async () => {
    const log: Array<{ table: string; op: string; row?: Rec }> = [];
    const row = { id: "wo1", bucket: "scheduled", title: "T", reference: "R" };
    const base0 = fakeDb({ portal_work_order_records: { single: { manager_user_id: "m1", vendor_user_id: "v1", row_data: row }, rows: [{ id: "wo1" }] } }, log) as unknown as Rec;
    const db = { ...base0, storage: { from: () => ({ upload: async () => ({ error: null }) }) } } as never;
    const ok = await markWorkOrderDoneByVendor(db, actor(), { workOrderId: "wo1", completionPhotoDataUrls: ["data:image/jpeg;base64,AAAA"] });
    expect(ok.ok).toBe(true);
    const updates = log.filter((l) => l.op === "update");
    expect(updates).toHaveLength(1);
    expect((updates[0]!.row!.row_data as Rec).automationStatus).toBe("vendor_marked_done");
    expect((updates[0]!.row!.row_data as Rec).completionPhotoPaths).toHaveLength(1);

    const failing = { ...(fakeDb({ portal_work_order_records: { single: { manager_user_id: "m1", vendor_user_id: "v1", row_data: row }, rows: [{ id: "wo1" }], error: { message: "boom" } } }) as unknown as Rec), storage: base0.storage } as never;
    hoisted.events.length = 0;
    const bad = await markWorkOrderDoneByVendor(failing, actor(), { workOrderId: "wo1", completionPhotoDataUrls: ["data:image/jpeg;base64,AAAA"] });
    expect(bad).toMatchObject({ ok: false, status: 500 });
    expect(hoisted.events).toHaveLength(0);
  });

  it("a double tap writes the done status once: the update re-asserts it, and a lost race fires nothing", async () => {
    const log: Array<{ table: string; op: string; row?: Rec }> = [];
    // The row still reads as not-done (the stale SELECT both requests made), but the conditional UPDATE matches no row
    // because the winner already stamped automationStatus.
    const base = fakeDb({ portal_work_order_records: { single: { manager_user_id: "m1", vendor_user_id: "v1", row_data: { id: "wo1", bucket: "scheduled", title: "T", reference: "R" } }, rows: [] } }, log) as unknown as Rec;
    const db = { ...base, storage: { from: () => ({ upload: async () => ({ error: null }) }) } } as never;
    hoisted.events.length = 0;
    expect(await markWorkOrderDoneByVendor(db, actor(), { workOrderId: "wo1" })).toMatchObject({ ok: false, status: 400 });
    expect(hoisted.events).toHaveLength(0);
  });
});

describe("J4: Assigned -> Scheduled through the vendor's own picker", () => {
  const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const assigned = { id: "wo1", bucket: "open", status: "Assigned", vendorId: "d1", title: "T", reference: "R" };
  it("books the same patch the bid-accept path writes and notifies the manager", async () => {
    const log: Array<{ table: string; op: string; row?: Rec }> = [];
    const db = fakeDb({ portal_work_order_records: { single: { manager_user_id: "m1", vendor_user_id: "v1", row_data: assigned }, rows: [{ id: "wo1" }] } }, log);
    const result = await scheduleAssignedVisit(db, actor(), { workOrderId: "wo1", visitAt: future });
    expect(result.ok).toBe(true);
    const written = log.find((l) => l.op === "update")!.row!.row_data as Rec;
    expect(written).toMatchObject({ bucket: "scheduled", status: "Scheduled", scheduledAtIso: future });
    expect(written.scheduled).toBe(bookedVisitPatch(future).scheduled);
    expect(hoisted.events.find((e) => e.event === "scheduled")).toBeTruthy();
  });
  it("refuses another vendor's job, a past time, and a non-vendor, writing nothing", async () => {
    const log: Array<{ table: string; op: string; row?: Rec }> = [];
    const db = fakeDb({ portal_work_order_records: { single: { manager_user_id: "m1", vendor_user_id: "SOMEONE_ELSE", row_data: assigned }, rows: [{ id: "wo1" }] } }, log);
    expect(await scheduleAssignedVisit(db, actor(), { workOrderId: "wo1", visitAt: future })).toMatchObject({ ok: false, status: 403 });
    expect(await scheduleAssignedVisit(db, actor({ role: "manager" }), { workOrderId: "wo1", visitAt: future })).toMatchObject({ ok: false, status: 403 });
    expect(await scheduleAssignedVisit(db, actor(), { workOrderId: "wo1", visitAt: "2000-01-01T00:00:00Z" })).toMatchObject({ ok: false, status: 400 });
    expect(log.filter((l) => l.op === "update")).toHaveLength(0);
  });
  it("refuses a job that is already scheduled", async () => {
    const db = fakeDb({ portal_work_order_records: { single: { manager_user_id: "m1", vendor_user_id: "v1", row_data: { ...assigned, bucket: "scheduled", scheduledAtIso: future } } } });
    expect(await scheduleAssignedVisit(db, actor(), { workOrderId: "wo1", visitAt: future })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("assigned vendor directory normalization", () => {
  const directory = [{ id: "directory-a", managerId: "manager-a" }, { id: "directory-b", managerId: "manager-b" }];
  it("replaces an Auth ID with the exact manager-scoped directory ID", () => {
    expect(assignedVendorDirectoryId("vendor-auth-id", "manager-a", "vendor-auth-id", directory)).toBe("directory-a");
    expect(assignedVendorDirectoryId("directory-a", "manager-a", "vendor-auth-id", directory)).toBe("directory-a");
    expect(assignedVendorDirectoryId("directory-b", "manager-a", "vendor-auth-id", directory)).toBe("directory-a");
  });
  it("replaces a nested vendor Auth ID while retaining the vendor display name", () => {
    const row = { assignee: { type: "vendor", id: "vendor-auth-id", name: "Vendor" } } as DemoManagerWorkOrderRow;
    expect(normalizeAssignedVendorAssignee(row, "directory-a")).toEqual({ type: "vendor", id: "directory-a", name: "Vendor" });
    expect(projectWorkOrderForOfferedVendor(row)).not.toHaveProperty("assignee");
  });
  it("denies missing, viewer-ID and ambiguous manager-scoped matches", () => {
    expect(assignedVendorDirectoryId("vendor-auth-id", "missing", "vendor-auth-id", directory)).toBeNull();
    expect(assignedVendorDirectoryId("vendor-auth-id", "manager-a", "vendor-auth-id", [{ id: "vendor-auth-id", managerId: "manager-a" }])).toBeNull();
    expect(assignedVendorDirectoryId("vendor-auth-id", "manager-a", "vendor-auth-id", [...directory, { id: "directory-c", managerId: "manager-a" }])).toBeNull();
    expect(assignedVendorDirectoryId("manager-a", "manager-a", "vendor-auth-id", [{ id: "manager-a", managerId: "manager-a" }])).toBeNull();
    expect(assignedVendorDirectoryId("resident-id", "manager-a", "vendor-auth-id", [{ id: "resident-id", managerId: "manager-a" }], "resident-id")).toBeNull();
  });
});

describe("J6c: what a vendor read carries", () => {
  const row = {
    id: "wo1",
    title: "T",
    propertyAddress: "1 Main",
    residentUserId: "resident-private-id",
    managerUserId: "manager-private-id",
    vendorUserId: "vendor-private-id",
    manager_user_id: "manager-private-id",
    vendor_user_id: "vendor-private-id",
    resident_user_id: "resident-private-id",
    vendorId: "directory-id",
    residentEmail: "resident@example.test",
    resident_email: "resident@example.test",
    managerName: "Property Manager",
    propertyId: "public-listing-id", assignedPropertyId: "public-listing-id", workspaceId: "private-workspace-id",
    property_id: "public-listing-id", assigned_property_id: "public-listing-id", workspace_id: "private-workspace-id",
    assignee: { type: "team", id: "manager-private-id", name: "Manager" },
    nested: { managerUserId: "manager-private-id" },
    residentChargeCents: 9900,
    residentChargeId: "ch_1",
    expenseEntryIds: ["e1"],
    residentConfirmation: { token: "x" },
    assignedRoomChoice: "Room 2",
  } as unknown as DemoManagerWorkOrderRow;
  it("a hired vendor keeps the site but never the resident billing fields", () => {
    const out = projectWorkOrderForHiredVendor(row) as unknown as Rec;
    expect(out.propertyAddress).toBe("1 Main");
    expect(out.residentEmail).toBe("resident@example.test");
    expect(out.vendorId).toBe("directory-id");
    expect(out.managerName).toBe("Property Manager");
    expect(out).not.toHaveProperty("resident_email");
    expect(JSON.stringify(out)).not.toMatch(/(?:resident|manager|vendor)-private-id/);
    for (const k of ["residentUserId", "residentChargeCents", "residentChargeId", "expenseEntryIds", "residentConfirmation"]) expect(out, k).not.toHaveProperty(k);
  });
  it("uses only an address city for offered area, preserving hired site details", () => {
    const distinctive = { ...row, propertyName: "Proof House", propertyAddress: "1 Main Street" } as DemoManagerWorkOrderRow;
    expect(projectWorkOrderForOfferedVendor(distinctive).propertyName).toBe("Nearby");
    expect(projectWorkOrderForOfferedVendor({ ...distinctive, propertyAddress: "1 Main Street, Seattle, WA" }).propertyName).toBe("Seattle");
    expect(projectWorkOrderForHiredVendor(distinctive).propertyName).toBe("Proof House");
    const offered = projectWorkOrderForOfferedVendor({ ...distinctive, propertyAddress: "1 Main Street, Seattle, WA", offeredGeneralArea: "Untrusted House" });
    expect(offered.offeredGeneralArea).toBe("Seattle");
    expect(vendorVisibleGeneralArea(offered)).toBe("Seattle");
    expect(vendorLeadMapsQuery(offered)).toContain("Seattle");
    expect(vendorServiceWorkflowSteps(offered)[0]?.detail).toBe("Seattle");
    expect(vendorVisibleGeneralArea(distinctive)).toBe("Nearby");
  });
  it("an offered vendor also loses assignedRoomChoice", () => {
    const out = projectWorkOrderForOfferedVendor(row) as unknown as Rec;
    expect(out).not.toHaveProperty("residentUserId");
    expect(out).not.toHaveProperty("vendorId");
    expect(out).not.toHaveProperty("assignee");
    expect(out.managerName).toBe("Property Manager");
    expect(out).not.toHaveProperty("resident_email");
    expect(JSON.stringify(out)).not.toMatch(/(?:resident|manager|vendor)-private-id/);
    expect(out).not.toHaveProperty("assignedRoomChoice");
    for (const key of ["propertyId", "assignedPropertyId", "workspaceId", "property_id", "assigned_property_id", "workspace_id"]) expect(out).not.toHaveProperty(key);
    expect(out).not.toHaveProperty("propertyAddress");
  });
});

describe("L1: a maintenance service can be assigned to a roster vendor", () => {
  it("the maintenance picker lists the roster vendors by directory name", async () => {
    const { assignmentCandidatesFor } = await import("@/lib/work-assignment");
    const input = { teamMembers: [{ userId: "u1", name: "Me" }], vendors: [{ id: "d1", name: "Pacific Plumbing", trade: "Plumbing", active: true }] };
    expect(assignmentCandidatesFor("maintenance", input).map((c) => `${c.type}:${c.name}`)).toEqual(["team:Me", "vendor:Pacific Plumbing"]);
    const fs = await import("node:fs");
    expect(fs.readFileSync("src/components/portal/pro-legacy-service-intake-form.tsx", "utf8")).toContain('kind={isMaintenanceOffer ? "maintenance" : "service"}');
  });
});

describe("L5: approving a bid reports back", () => {
  it("the approve handlers return their promise so the Button owns loading, and refresh before the toast", async () => {
    const fs = await import("node:fs");
    const panel = fs.readFileSync("src/components/portal/pro-work-orders-panel.tsx", "utf8");
    expect(panel).toContain("return bid ? acceptBidHandler(bid) : undefined;");
    // R3: toast and optimistic state come from the 200 itself; the refetch is never awaited.
    const handler = panel.slice(panel.indexOf("const acceptBidHandler"), panel.indexOf("const removeRequestHandler"));
    expect(handler.indexOf('showToast("Bid approved')).toBeLessThan(handler.indexOf("syncManagerWorkOrdersFromServer"));
    expect(handler).toContain('status: "accepted"');
    expect(handler).not.toMatch(/await (Promise\.all\(\[)?syncManagerWorkOrdersFromServer/);
    const actions = fs.readFileSync("src/lib/add-on-vendor-job-actions.ts", "utf8");
    expect(actions).not.toMatch(/approve_bid[\s\S]{0,300}await syncManagerWorkOrdersFromServer/);
    expect(fs.readFileSync("src/components/portal/pro-all-services-panel.tsx", "utf8")).toContain("onApprove={(request) => addOnJob.approve(request)}");
  });
});

describe("L6: completion photos go to the private bucket, row_data keeps paths", () => {
  it("mark-done uploads first and writes only paths in the one update", async () => {
    const uploads: string[] = [];
    const log: Array<{ table: string; op: string; row?: Rec }> = [];
    const base = fakeDb({ portal_work_order_records: { single: { manager_user_id: "m1", vendor_user_id: "v1", row_data: { id: "wo1", bucket: "scheduled" } }, rows: [{ id: "wo1" }] } }, log) as unknown as Rec;
    const db = { ...base, storage: { from: () => ({ upload: async (path: string) => { uploads.push(path); return { error: null }; } }) } } as never;
    const res = await markWorkOrderDoneByVendor(db, actor(), { workOrderId: "wo1", completionPhotoDataUrls: ["data:image/jpeg;base64,AAAA"] });
    expect(res.ok).toBe(true);
    expect(uploads[0]).toMatch(/^manager\/m1\/service-completion\/wo1\/.+\.jpg$/);
    const written = log.filter((l) => l.op === "update");
    expect(written).toHaveLength(1);
    const rd = written[0]!.row!.row_data as Rec;
    expect(rd.completionPhotoPaths).toEqual(uploads);
    expect(rd).not.toHaveProperty("completionPhotoDataUrls");
  });
  it("a failed upload leaves the job unmarked", async () => {
    const log: Array<{ table: string; op: string; row?: Rec }> = [];
    const base = fakeDb({ portal_work_order_records: { single: { manager_user_id: "m1", vendor_user_id: "v1", row_data: { id: "wo1", bucket: "scheduled" } }, rows: [{ id: "wo1" }] } }, log) as unknown as Rec;
    const db = { ...base, storage: { from: () => ({ upload: async () => ({ error: { message: "down" } }) }) } } as never;
    expect(await markWorkOrderDoneByVendor(db, actor(), { workOrderId: "wo1", completionPhotoDataUrls: ["data:image/jpeg;base64,AAAA"] })).toMatchObject({ ok: false, status: 500 });
    expect(log.filter((l) => l.op === "update")).toHaveLength(0);
  });
  it("signing refuses a path outside this manager's work order", async () => {
    const { signCompletionPhotoPaths } = await import("@/lib/completion-photo-storage.server");
    const signed: string[] = [];
    const db = { storage: { from: () => ({ createSignedUrl: async (p: string) => { signed.push(p); return { data: { signedUrl: `https://s/${p}` } }; } }) } } as never;
    const urls = await signCompletionPhotoPaths(db, {
      managerUserId: "m1",
      workOrderId: "wo1",
      paths: ["manager/m1/service-completion/wo1/a.jpg", "manager/OTHER/service-completion/wo1/a.jpg", "manager/m1/service-completion/wo2/a.jpg"],
    });
    expect(urls).toEqual(["https://s/manager/m1/service-completion/wo1/a.jpg"]);
  });
});

describe("L8: Upcoming visits are future only", () => {
  it("drops past and completed visits, soonest first", async () => {
    const { upcomingVendorVisits } = await import("@/lib/vendor-work-order-tabs");
    const now = Date.parse("2026-10-25T12:00:00Z");
    const rows = [
      { id: "past", scheduledAtIso: "2026-10-08T17:00:00Z", bucket: "scheduled" },
      { id: "later", scheduledAtIso: "2026-10-30T17:00:00Z", bucket: "scheduled" },
      { id: "soon", scheduledAtIso: "2026-10-26T17:00:00Z", bucket: "scheduled" },
      { id: "done", scheduledAtIso: "2026-10-27T17:00:00Z", bucket: "completed" },
    ] as unknown as DemoManagerWorkOrderRow[];
    expect(upcomingVendorVisits(rows, now).map((r) => r.id)).toEqual(["soon", "later"]);
  });
});


describe("R3-1: a service's Communication finds the vendor's login-email thread", () => {
  it("matches a thread under the linked account's login email, not only the roster email", async () => {
    const { serviceCommunicationParties, serviceThreadsForParty, serviceThreadsForEveryone } = await import("@/lib/service-communication-scope");
    const parties = serviceCommunicationParties({
      resident: null,
      offers: [{ vendorDirectoryId: "d1", vendorName: "Pacific Plumbing", vendorEmail: "office@pacificplumbing.example", vendorLoginEmail: "showcase.vendor@x.com" }],
    });
    expect(parties[0]).toMatchObject({ email: "office@pacificplumbing.example", altEmails: ["showcase.vendor@x.com"] });
    const thread = { id: "t1", email: "showcase.vendor@x.com", recordRef: { kind: "service", id: "REQ-1", label: "x" } };
    const other = { id: "t2", email: "someone@else.com", recordRef: { kind: "service", id: "REQ-1", label: "x" } };
    expect(serviceThreadsForParty([thread, other], { recordIds: ["REQ-1"], party: parties[0] })).toEqual([thread]);
    expect(serviceThreadsForEveryone([thread, other], { recordIds: ["REQ-1"], parties })).toEqual([thread]);
  });
  it("the bids and offers reads attach the login email for managers only", async () => {
    const fs = await import("node:fs");
    for (const f of ["src/app/api/portal/work-order-bids/route.ts", "src/app/api/portal/work-order-vendor-offers/route.ts"]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).toContain("vendorLoginEmailsByUserId");
      expect(src, f).toMatch(/actor\.role === "vendor" && !actor\.admin\s*\?\s*new Map/);
    }
  });
});

describe("R3-3: Upcoming visits exclude every completed form", () => {
  it("drops vendor-marked-done, paid and completedAt rows even when the bucket is still scheduled", async () => {
    const { upcomingVendorVisits } = await import("@/lib/vendor-work-order-tabs");
    const now = Date.parse("2026-10-26T12:00:00Z");
    const at = "2026-10-30T17:00:00Z";
    const rows = [
      { id: "ok", scheduledAtIso: at, bucket: "scheduled" },
      { id: "marked", scheduledAtIso: at, bucket: "scheduled", automationStatus: "vendor_marked_done" },
      { id: "paid", scheduledAtIso: at, bucket: "scheduled", automationStatus: "paid" },
      { id: "stamped", scheduledAtIso: at, bucket: "scheduled", completedAt: "2026-10-25T00:00:00Z" },
    ] as unknown as DemoManagerWorkOrderRow[];
    expect(upcomingVendorVisits(rows, now).map((r) => r.id)).toEqual(["ok"]);
  });
});

describe("R3-4: the manager's inbox titles the vendor thread with the roster name", () => {
  it("roster name first, else the profile name, never a login email", async () => {
    const { managerSideVendorName } = await import("@/lib/vendor-sponsored-outbound.server");
    const dbWith = (rowData: Rec | null) =>
      ({ from: () => { const b: Rec = {}; for (const m of ["select", "eq", "limit"]) b[m] = () => b; b.maybeSingle = async () => ({ data: rowData ? { row_data: rowData } : null }); return b; } }) as never;
    const input = { managerUserId: "m1", vendorUserId: "v1", fallbackName: "Vee Vendor" };
    expect(await managerSideVendorName(dbWith({ name: "Pacific Plumbing" }), input)).toBe("Pacific Plumbing");
    expect(await managerSideVendorName(dbWith(null), input)).toBe("Vee Vendor");
    expect(await managerSideVendorName(dbWith(null), { ...input, fallbackName: "showcase.vendor@x.com" })).toBe("PropLane vendor");
  });
});
