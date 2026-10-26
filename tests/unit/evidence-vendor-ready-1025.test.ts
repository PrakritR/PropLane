/**
 * vendor-ready-1025 — the server-side halves of "a real vendor can be onboarded", written out as a
 * readable transcript instead of only asserted.
 *
 * These three paths have no screen of their own (the invite redemption happens between two page
 * loads, the send outcome is one toast, the 90-day hold expiry is a cron), so the artifact is what
 * the rows and the people actually end up with:
 *
 *   1. a job assigned to a roster vendor who has NO account yet, then that vendor redeeming the
 *      manager's Add-vendor link: the manager's own directory row is claimed (not duplicated) and
 *      the job is back-filled to the new account — for that manager only;
 *   2. the one line the manager reads back after sending a service to vendors: who was requested,
 *      who was auto-invited, who was skipped and why;
 *   3. a 90-day-unclaimed `classified_held` payment returning to the manager through the central
 *      rail, under the reserved `hold-expiry:` attempt key a vendor's own Idempotency-Key cannot
 *      produce, announced as something PropLane did rather than "You refunded".
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-vendor-ready-1025.test.ts
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

vi.mock("server-only", () => ({}));

const hoisted = vi.hoisted(() => ({
  invites: [] as Array<Record<string, unknown>>,
  notices: [] as Array<Record<string, unknown>>,
  refunds: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => null, hasRole: () => true }));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: async () => ({ duplicate: false }) }));
vi.mock("@/lib/work-order-resident-confirmation.server", () => ({ requestResidentConfirmation: async () => null }));
vi.mock("@/lib/work-order-vendor-invoice.server", () => ({ ensureSubmittedVendorInvoiceForMarkedDone: async () => undefined }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({ resolvePropertyScopedManagerRecipientIds: async () => ["mgr-taylor"] }));
vi.mock("@/lib/service-automation-settings.server", () => ({ resolveServiceAutomationSettingsForRow: async () => null }));
vi.mock("@/lib/service-work-board.server", () => ({ revealHeldVendorContact: async () => undefined }));
vi.mock("@/lib/vendor-invite.server", () => ({
  sendVendorInvite: async (_db: unknown, opts: Record<string, unknown>) => {
    hoisted.invites.push(opts);
    return { ok: true, emailId: "e1", linkUrl: "https://proplane.test/invite/TOKEN" };
  },
}));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: async (_db: unknown, msg: Record<string, unknown>) => {
    hoisted.notices.push(msg);
    return { ok: true, recipientCount: 1 };
  },
}));
vi.mock("@/lib/vendor-banking/central-refund.server", () => ({
  submitVendorRefund: async (_s: unknown, _d: unknown, input: Record<string, unknown>) => {
    hoisted.refunds.push(input);
    return { ok: true, status: "succeeded", replay: false, grossCents: 14_935 };
  },
}));

import { describeVendorSendOutcome } from "@/lib/work-order-vendor-offers";
import { isReservedVendorClientKey, vendorRefundAttemptKey, holdExpiryAttemptKey } from "@/lib/vendor-banking/refund-cap";

type Row = Record<string, unknown>;

const transcript: string[] = [];
const say = (line = "") => transcript.push(line);
const dump = (label: string, value: unknown) => say(`${label}\n${JSON.stringify(value, null, 2)}`);

afterAll(() => {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "vendor-ready-server-transcript.txt"), `${transcript.join("\n")}\n`);
});

/* ----------------------------------------------------------------- shared doubles */

/** In-memory Supabase double: select/insert/update/upsert/delete with the filters these paths use. */
function makeDb(tables: Record<string, Row[]>) {
  const pick = (row: Row, col: string): unknown => {
    if (col.includes("->>")) {
      const [base, key] = col.split("->>");
      return ((row[base!] ?? {}) as Row)[key!];
    }
    return row[col];
  };
  return {
    tables,
    auth: { admin: {} },
    from(name: string) {
      const rows = (tables[name] ??= []);
      const preds: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" | "delete" = "select";
      let patch: Row = {};
      let lim = Infinity;
      const run = () => {
        const hit = rows.filter((r) => preds.every((p) => p(r))).slice(0, lim);
        if (op === "update") hit.forEach((r) => Object.assign(r, patch));
        if (op === "delete") hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return hit;
      };
      const b: Record<string, unknown> = {
        select: () => b,
        update: (v: Row) => ((op = "update"), (patch = v), b),
        delete: () => ((op = "delete"), b),
        insert: async (v: Row | Row[]) => {
          for (const r of Array.isArray(v) ? v : [v]) rows.push({ id: `gen-${rows.length + 1}`, ...r });
          return { data: null, error: null };
        },
        upsert: async (v: Row | Row[]) => {
          for (const r of Array.isArray(v) ? v : [v]) {
            const at = rows.findIndex((x) => x.id !== undefined && x.id === r.id);
            if (at >= 0) Object.assign(rows[at]!, r);
            else rows.push({ ...r });
          }
          return { data: null, error: null };
        },
        eq: (c: string, v: unknown) => (preds.push((r) => pick(r, c) === v), b),
        neq: (c: string, v: unknown) => (preds.push((r) => pick(r, c) !== v), b),
        is: (c: string, v: unknown) => (preds.push((r) => (pick(r, c) ?? null) === v), b),
        in: (c: string, v: unknown[]) => (preds.push((r) => v.includes(pick(r, c))), b),
        or: (expr: string) => {
          const terms = expr.split(",").map((t) => {
            const [col, o, ...rest] = t.split(".");
            const val = rest.join(".");
            return (r: Row) =>
              o === "is" && val === "null" ? (pick(r, col!) ?? null) === null : o === "eq" && String(pick(r, col!)) === val;
          });
          preds.push((r) => terms.some((t) => t(r)));
          return b;
        },
        gt: (c: string, v: string) => (preds.push((r) => String(pick(r, c)) > v), b),
        lt: (c: string, v: string) => (preds.push((r) => String(pick(r, c)) < v), b),
        not: () => b,
        order: () => b,
        limit: (n: number) => ((lim = n), b),
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve),
      };
      return b;
    },
  };
}

/** Chainable fake whose answers are canned per table (what the offer path reads). */
function fakeDb(tables: Record<string, { rows?: unknown; single?: unknown }>) {
  return {
    from(table: string) {
      const t = tables[table] ?? {};
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "is", "not", "gt", "limit", "order", "or"]) builder[m] = () => builder;
      builder.maybeSingle = async () => ({ data: t.single ?? null, error: null });
      builder.update = () => builder;
      builder.upsert = () => Promise.resolve({ error: null });
      builder.insert = () => Promise.resolve({ error: null });
      builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: t.rows ?? [], error: null });
      return builder;
    },
  };
}

/* ------------------------------------------------------------------------ 1. onboarding */

describe("onboarding: a job assigned before signup follows the vendor into their new account", () => {
  it("redeeming the manager's Add-vendor link claims that roster row and back-fills the job", async () => {
    const { redeemVendorLink } = await import("@/lib/invite-links/invite-links.server");
    const db = makeDb({
      profiles: [{ id: "usr-harbor", email: "dispatch@harborplumbing.com", full_name: "Dana Harbor", role: "resident" }],
      profile_roles: [],
      manager_invite_link_redemptions: [],
      manager_vendor_records: [
        // Taylor typed Harbor Plumbing into their roster; nobody has signed in as them yet.
        { id: "vrec-harbor", manager_user_id: "mgr-taylor", vendor_user_id: null, row_data: { id: "vrec-harbor", name: "Harbor Plumbing", trade: "Plumbing", phone: "206-555-0101", email: "" } },
        // Another manager's roster row for the same trade: it must not move.
        { id: "vrec-other", manager_user_id: "mgr-alex", vendor_user_id: null, row_data: { name: "Alex's plumber" } },
      ],
      work_order_vendor_offers: [],
      portal_work_order_records: [
        { id: "wo-radiator", manager_user_id: "mgr-taylor", vendor_user_id: null, row_data: { vendorId: "vrec-harbor", title: "Hallway radiator bleed" } },
        { id: "wo-self", manager_user_id: "mgr-taylor", vendor_user_id: null, row_data: { vendorId: "vrec-harbor", title: "Change the porch bulb", selfAssigned: true } },
        { id: "wo-alex", manager_user_id: "mgr-alex", vendor_user_id: null, row_data: { vendorId: "vrec-harbor", title: "Alex's job" } },
      ],
    });

    say("=== 1. Onboarding: invite link → claimed roster row → back-filled job ===");
    say();
    say("Before — Taylor's roster row has no account, and the radiator job is assigned to the row only:");
    dump("manager_vendor_records:", db.tables.manager_vendor_records);
    dump("portal_work_order_records (vendor_user_id):", db.tables.portal_work_order_records!.map((r) => ({ id: r.id, manager: r.manager_user_id, vendor_user_id: r.vendor_user_id })));
    say();

    // The Add-vendor link carries the directory row (the new, nullable
    // `manager_invite_links.vendor_directory_id` column).
    const result = await redeemVendorLink({
      db: db as never,
      link: { id: "lnk-1", owner_user_id: "mgr-taylor", label: "Plumbing", assigned_property_ids: [], vendor_directory_id: "vrec-harbor" },
      redeemerUserId: "usr-harbor",
      alreadyRedeemed: false,
      spendUse: async () => ({ ok: true as const }),
      releaseSpentUse: async () => {},
    });
    say(`Dana opens the link and signs in → redeemVendorLink: ${JSON.stringify(result)}`);
    say();
    say("After:");
    dump("manager_vendor_records:", db.tables.manager_vendor_records);
    dump("portal_work_order_records (vendor_user_id):", db.tables.portal_work_order_records!.map((r) => ({ id: r.id, manager: r.manager_user_id, vendor_user_id: r.vendor_user_id })));
    dump("profile_roles:", db.tables.profile_roles);
    say();

    expect(result).toMatchObject({ ok: true, kind: "vendor", vendorDirectoryId: "vrec-harbor" });
    // One row for this manager, still named the way the manager typed it.
    const taylorRows = db.tables.manager_vendor_records!.filter((r) => r.manager_user_id === "mgr-taylor");
    expect(taylorRows).toHaveLength(1);
    expect(taylorRows[0]!.vendor_user_id).toBe("usr-harbor");
    expect((taylorRows[0]!.row_data as Row).name).toBe("Harbor Plumbing");
    expect((taylorRows[0]!.row_data as Row).phone).toBe("206-555-0101");
    // The job assigned before signup is now theirs; the manager's own job and another
    // manager's job are untouched.
    const byId = Object.fromEntries(db.tables.portal_work_order_records!.map((r) => [r.id as string, r.vendor_user_id]));
    expect(byId).toEqual({ "wo-radiator": "usr-harbor", "wo-self": null, "wo-alex": null });
    expect(db.tables.manager_vendor_records!.find((r) => r.id === "vrec-other")!.vendor_user_id).toBeNull();
    say("→ One roster row, the manager's own name and phone kept, the radiator job now reachable in Dana's");
    say("  Services. The manager's self-assigned job and the other manager's job did not move.");
    say();
  });
});

/* ------------------------------------------------------------------- 2. the send outcome */

describe("sending a service to vendors always reports what really happened", () => {
  const workOrderRow = { id: "wo-radiator", title: "Hallway radiator bleed", reference: "WO-1", bucket: "open", propertyName: "The Magnolia" };
  const manager = { userId: "mgr-taylor", email: "taylor@example.com", fullName: "Taylor M.", admin: false, role: "manager" as const };
  const roster = (vendors: Array<{ id: string; vendor_user_id: string | null; email: string; name: string }>) =>
    fakeDb({
      portal_work_order_records: { single: { manager_user_id: "mgr-taylor", row_data: workOrderRow } },
      work_order_bids: { rows: [] },
      work_order_vendor_offers: { rows: [] },
      manager_vendor_records: {
        rows: vendors.map((v) => ({ id: v.id, manager_user_id: "mgr-taylor", vendor_user_id: v.vendor_user_id, row_data: { name: v.name, email: v.email } })),
      },
    });

  it("names the invited and the skipped, never a bare 'requested N vendors'", async () => {
    const { sendWorkOrderVendorOffers } = await import("@/lib/work-order-offers.server");
    say("=== 2. What the manager reads back after Send to vendors ===");
    say();

    const cases: Array<{ what: string; vendors: Array<{ id: string; vendor_user_id: string | null; email: string; name: string }> }> = [
      { what: "a vendor already on PropLane", vendors: [{ id: "d-linked", vendor_user_id: "usr-harbor", email: "dispatch@harborplumbing.com", name: "Harbor Plumbing" }] },
      { what: "a roster vendor with an email but no account", vendors: [{ id: "d-new", vendor_user_id: null, email: "joe@joeselectric.test", name: "Joe's Electric" }] },
      { what: "a roster vendor with neither", vendors: [{ id: "d-none", vendor_user_id: null, email: "", name: "Ace Roofing" }] },
    ];
    const lines: string[] = [];
    for (const c of cases) {
      hoisted.invites.length = 0;
      const result = await sendWorkOrderVendorOffers(roster(c.vendors) as never, manager, {
        workOrderId: "wo-radiator",
        vendorIds: c.vendors.map((v) => v.id),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const toast = describeVendorSendOutcome({ ok: true, ...result }, (id) => c.vendors.find((v) => v.id === id)?.name ?? "");
      lines.push(toast);
      say(`${c.what}`);
      say(`  server: ${JSON.stringify({ sent: result.sent, invited: result.invited, skippedDetails: result.skippedDetails })}`);
      say(`  invite emailed: ${hoisted.invites.length ? JSON.stringify({ to: hoisted.invites[0]!.vendorEmail, job: hoisted.invites[0]!.jobLine }) : "none"}`);
      say(`  toast:  "${toast}"`);
      say();
    }

    expect(lines[0]).toBe("Requested Harbor Plumbing.");
    expect(lines[1]).toBe("Invited Joe's Electric and sent the job.");
    expect(lines[2]).toBe("Skipped Ace Roofing: no email or account.");
    say("→ Nothing is reported as sent that nobody could receive.");
    say();
  });
});

/* -------------------------------------------------------------- 3. the 90-day hold expiry */

describe("a 90-day-unclaimed held payment goes back to the manager", () => {
  it("refunds a classified_held hold on a reserved key and announces it as PropLane's doing", async () => {
    const { expireVendorHolds } = await import("@/lib/vendor-banking/hold-expiry.server");
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const holds = [
      { id: "hold-1", source: "vendor_invoice", status: "classified_held", created_at: daysAgo(95), owner_user_id: "usr-harbor", owner_role: "vendor", amount_cents: 14_500, source_id: "inv-harbor-1", stripe_charge_id: "ch_1", stripe_transfer_id: null },
      { id: "hold-young", source: "vendor_invoice", status: "classified_held", created_at: daysAgo(12), owner_user_id: "usr-harbor", owner_role: "vendor", amount_cents: 9_000, source_id: "inv-harbor-2", stripe_charge_id: "ch_2", stripe_transfer_id: null },
    ];
    const db = makeDb({
      platform_payment_holds: holds,
      vendor_payouts: [{ id: "payout-1", platform_hold_id: "hold-1", vendor_user_id: "usr-harbor" }],
      vendor_invoices: [{ id: "inv-harbor-1", manager_user_id: "mgr-taylor", invoice_number: "HP-1042" }],
      profiles: [{ id: "mgr-taylor", email: "taylor@example.com" }, { id: "usr-harbor", email: "dispatch@harborplumbing.com" }],
      portal_work_order_records: [],
    });

    say("=== 3. The 90-day hold expiry ===");
    say();
    say("Holds on the platform (the vendor never finished connecting a bank):");
    dump("platform_payment_holds:", holds.map((h) => ({ id: h.id, status: h.status, age_days: Math.round((Date.now() - Date.parse(h.created_at)) / 86_400_000), amount_cents: h.amount_cents })));
    say();

    hoisted.refunds.length = 0;
    hoisted.notices.length = 0;
    const result = await expireVendorHolds({} as never, db as never);
    say(`Cron pass: ${JSON.stringify(result)}`);
    say();
    dump("refund submitted to the central rail:", hoisted.refunds);
    say();
    say("Notices appended (one per audience, deterministic id so a re-run never doubles them):");
    for (const n of hoisted.notices) {
      say(`  [${n.messageId}] to ${JSON.stringify(n.toUserIds)} from "${n.fromName}"`);
      say(`    ${n.subject}`);
      say(`    ${n.text}`);
    }
    say();

    expect(result).toMatchObject({ checked: 1, returned: 1, failed: 0 });
    // Only the 95-day hold; the 12-day one is left alone.
    expect(hoisted.refunds).toHaveLength(1);
    expect(hoisted.refunds[0]).toMatchObject({ payoutId: "payout-1", vendorUserId: "usr-harbor", clientKey: "hold-1", initiatedBy: "hold_expiry" });
    // Full remaining gross — no cap, so the PropLane fee rides back to the manager with it.
    expect(hoisted.refunds[0]).not.toHaveProperty("requestedGrossCents");
    // Both parties are told, and neither is told they did it.
    const ids = hoisted.notices.map((n) => String(n.messageId)).sort();
    expect(ids).toEqual(["hold-expiry:hold-1:manager", "hold-expiry:hold-1:vendor"]);
    for (const n of hoisted.notices) {
      expect(n.fromName).toBe("PropLane");
      expect(String(n.text)).not.toMatch(/you refunded/i);
      expect(String(n.text)).toContain("$149.35");
    }

    // The key namespace itself: the cron's key cannot be produced by a vendor's Idempotency-Key.
    const cronKey = holdExpiryAttemptKey("payout-1", "hold-1");
    say(`Cron attempt key:                 ${cronKey}`);
    say(`A vendor sending that same word:  ${JSON.stringify(vendorRefundAttemptKey("payout-1", "hold-expiry-hold-1"))}  (refused)`);
    say(`A vendor's own key:               ${vendorRefundAttemptKey("payout-1", "modal-open-9f2c41aa")}`);
    expect(cronKey).toBe("hold-expiry:payout-1:hold-1");
    expect(isReservedVendorClientKey("hold-expiry-hold-1")).toBe(true);
    expect(vendorRefundAttemptKey("payout-1", "hold-expiry-hold-1")).toBeNull();
    expect(vendorRefundAttemptKey("payout-1", "modal-open-9f2c41aa")).toBe("vendor-refund:payout-1:modal-open-9f2c41aa");
    say();
    say("→ A vendor can neither pre-create nor collide with a cron refund attempt, so they cannot");
    say("  silence the return notice by replaying its key.");
  });
});
