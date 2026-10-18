/**
 * Follow-ups the captain called on the Oct 16 sweep review.
 *
 * Each case pins the DECISION, not the wording around it: the export password carries its
 * warning on the label, a room's price is shown once per row, the tour calendar reads
 * "today" in Pacific like the slot keys it compares against, and the filter sheet's Reset
 * stays on one line.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPORT_PASSWORD_MIN_LENGTH } from "@/lib/account-export/export-password";
import { tourAvailabilityHasUpcoming } from "@/components/marketing/tour-schedule-flow";
import { submissionRoomRentLabel } from "@/lib/listing-room-resolution";

const SRC = join(__dirname, "..", "..", "src");
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf8");

describe("the export password warning lives on the label", () => {
  it("states the length rule and that PropLane cannot recover it — in the label, not a paragraph", () => {
    const source = read("components", "portal", "portal-data-export-button.tsx");
    const label = source.slice(source.indexOf("htmlFor={passwordId}"));
    const firstLabel = label.slice(0, label.indexOf("</label>"));
    expect(firstLabel).toContain("EXPORT_PASSWORD_MIN_LENGTH");
    expect(firstLabel).toMatch(/can't recover it/);
    expect(EXPORT_PASSWORD_MIN_LENGTH).toBe(12);
    // Still no subtext: no muted sentence under the field.
    expect(source).not.toMatch(/store it somewhere safe/);
  });
});

describe("a room's price is shown once per row", () => {
  it("the Pricing step keeps the amount on the right and the facts carry the stay type alone", () => {
    const source = read("components", "portal", "listing-wizard-v2", "listing-detail-steps.tsx");
    const step = source.slice(source.indexOf("export function StepPricing"));
    // The figure (or "Rent not set") sits on the right of every card in the step.
    expect(step.match(/<RentOnRight text=/g)?.length).toBeGreaterThanOrEqual(3);
    expect(step.match(/Rent not set/g)?.length).toBeGreaterThanOrEqual(3);
    // ...and the long-term fact no longer repeats it beside the stay type.
    expect(step).not.toMatch(/Long-term · \$\{/);
  });

  it("a room's rent line is written through the shared money formatter", () => {
    expect(submissionRoomRentLabel({ monthlyRent: 1200 } as never)).toBe("$1,200 / month");
    expect(submissionRoomRentLabel({ monthlyRent: 0 } as never)).toBeUndefined();
    expect(submissionRoomRentLabel(null)).toBeUndefined();
  });
});

describe("the tour calendar reads today in Pacific", () => {
  it("compares Pacific-keyed slots against a Pacific calendar date", () => {
    const source = read("components", "marketing", "tour-schedule-flow.tsx");
    expect(source).toContain("const todayPacific = pacificCalendarDateYmd()");
    expect(source).toContain("tourAvailabilityHasUpcoming(availability, todayPacific)");
    // The browser's own calendar no longer decides which day is past.
    expect(source).not.toMatch(/today\.getFullYear\(\)/);
    expect(source).not.toMatch(/toLocalDateStr\(today\)/);
  });

  it("a slot published for today still counts as upcoming", () => {
    const availability = new Set(["2026-10-17:2"]);
    expect(tourAvailabilityHasUpcoming(availability, "2026-10-17")).toBe(true);
    // The browser a day ahead of Pacific used to ask with its own date and get "none".
    expect(tourAvailabilityHasUpcoming(availability, "2026-10-18")).toBe(false);
  });
});

describe("filter sheet footer", () => {
  it("keeps Reset on one line next to a long apply label", () => {
    const source = read("components", "portal", "portal-filter-sort-sheet.tsx");
    const reset = source.slice(source.indexOf("function FilterResetLink"));
    expect(reset.slice(0, reset.indexOf("</button>"))).toMatch(/whitespace-nowrap/);
  });
});

describe("the inbox work identity label fits its box", () => {
  it("reads as a pair with Work email rather than the clipped longer wording", () => {
    const source = read("components", "portal", "pro-work-number-card.tsx");
    const label = source.slice(source.indexOf("const numberLabel ="));
    expect(label.slice(0, label.indexOf(";"))).toBe('const numberLabel = coManager ? "Workspace number" : "Work number"');
  });
});

describe("resident Payments after both parties sign", () => {
  it("drops the pay-before-signing instruction once the lease is fully signed", () => {
    const source = read("components", "portal", "resident-payments-panel.tsx");
    expect(source).toContain("leaseFullyExecuted(lease)");
    // Both sites — the charge detail and the move-in group — read the same gate.
    expect(source.match(/&& !leaseFullySigned \?/g)?.length).toBe(2);
    // Both labels are still there — they are gated, not deleted.
    expect(source.match(/Pay this before signing your lease/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("returns to the routed bucket after a checkout return, not the bare section", () => {
    const source = read("components", "portal", "resident-payments-panel.tsx");
    expect(source).toContain("const listPath = `${basePath}/payments/${resolvedBucketProp}`");
    const effect = source.slice(source.indexOf('searchParams.get("ach_checkout")'));
    expect(effect.slice(0, effect.indexOf("const rows ="))).not.toContain('router.replace("/resident/payments")');
  });
});

describe("inbox writes drop the shared GET after they settle", () => {
  it("never invalidates before the request, which would cache the pre-write rows", () => {
    const source = read("lib", "portal-inbox-storage.ts");
    // Every write to the list route goes through the write-through helper, which
    // invalidates in a `finally` once the response has settled.
    expect(source).not.toContain("invalidateSharedGets(");
    expect(source.match(/writeThroughFetch\("\/api\/portal-inbox-threads"/g)?.length).toBe(6);
    expect(source).not.toMatch(/await fetch\("\/api\/portal-inbox-threads"/);
  });
});

describe("the record header's fold reacts to the header, not only the window", () => {
  it("observes the ancestor the budget is measured from", () => {
    const source = read("components", "portal", "portal-adaptive-action-row.tsx");
    // The row lives in a content-sized host, so its own box only moves once the fold has
    // already changed: the detail pane opening or a longer record title would otherwise
    // leave the fold stale until the next window resize.
    expect(source).toContain('container.closest("[data-portal-record-header-actions]")');
    const effect = source.slice(source.indexOf("new ResizeObserver(sync)"));
    const observed = effect.slice(0, effect.indexOf("window.addEventListener"));
    expect(observed).toContain("ro.observe(recordHeader)");
  });
});

describe("the resident Payments lease gate", () => {
  it("reads both signatures or the stamp, through the one execution-evidence predicate", () => {
    const source = read("components", "portal", "resident-payments-panel.tsx");
    expect(source).toContain("leaseFullyExecuted(lease)");
    // Never the bare stamp: a row can carry both signatures without it (an offline-signed
    // PDF returned to the manager).
    expect(source).not.toMatch(/fullySignedAt\?\.trim\(\)/);
  });
});

describe("the merged-conversation read settle", () => {
  it("flips unread through the database's surgical jsonb_set, never a whole-row rewrite", () => {
    const route = readFileSync(join(SRC, "app", "api", "portal-inbox-threads", "route.ts"), "utf8");
    const settle = route.slice(route.indexOf("async function settleCollapsedSiblingsRead"));
    const body = settle.slice(0, settle.indexOf("export async function GET"));
    expect(body).toContain('db.rpc("mark_portal_inbox_thread_read_surgical"');
    expect(body).not.toContain("row_data: { ...rowData");
    expect(body).not.toContain("advanceAfterIso");
    const migration = readFileSync(
      join(SRC, "..", "supabase", "migrations", "20261017120000_mark_portal_inbox_thread_read_surgical.sql"),
      "utf8",
    );
    // Idempotent, surgical, and it can only ever clear the flag.
    expect(migration).toContain("create or replace function public.mark_portal_inbox_thread_read_surgical");
    expect(migration).toContain("jsonb_set(row_data, '{unread}', 'false'::jsonb, true)");
    expect(migration).toContain("row_data->'unread' = 'true'::jsonb");
    expect(migration).toContain("revoke all on function");
    expect(migration).toContain("grant execute on function public.mark_portal_inbox_thread_read_surgical(text,text) to service_role");
  });
});

describe("the Edit flyer pop-up", () => {
  it("is exactly two columns — the editor and the live flyer", () => {
    const panel = read("components", "portal", "pro-property-promotion-panel.tsx");
    const modal = panel.slice(panel.indexOf('title="Edit flyer"'));
    const props = modal.slice(0, modal.indexOf("<PromotionForm"));
    // A Modal row is rail + form + preview + assistant strip; this one keeps form + preview.
    expect(props).toContain("contextPanel={null}");
    expect(props).toContain("assistantStrip={false}");
    expect(props).toContain("preview={<PromotionFlyerPreview");
    expect(modal).toContain("singleColumn");
  });

  it("stacks the editor's fields one per row so none of them is ~200px", () => {
    const form = read("components", "portal", "promotion-form.tsx");
    expect(form).toContain('singleColumn ? "grid gap-3" : "grid gap-3 sm:grid-cols-2"');
    // The span helpers come off with the second column, or every cell keeps a stale span.
    expect(form).toContain('const wide = singleColumn ? "" : "sm:col-span-2"');
    expect(form).not.toContain('<div className="sm:col-span-2">');
  });
});
