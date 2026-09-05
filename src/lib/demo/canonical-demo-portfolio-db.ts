import { sealApplicantRow } from "@/lib/security/applicant-identity";
/**
 * Writes the idle `/demo` portfolio (`buildDemoIdleSnapshot`) into the canonical
 * sandbox accounts' real DB rows — the data the `/demo` read mirror serves.
 *
 * `buildDemoIdleSnapshot()` currently returns an EMPTY snapshot by design (see
 * `docs/agents/demo-sandbox.md`), so unless a caller passes its own
 * `opts.snapshot` this provisions the accounts/profiles with NO portfolio rows.
 * That is intentional, not a failed seed: fill in the snapshot — or put real
 * data on the canonical accounts — to give it something to write.
 *
 * ONE implementation shared by:
 * - `tests/helpers/seed-canonical-demo-portfolio.ts` (test-DB seed CLI)
 * - `POST /api/admin/provision-sandbox-accounts` (per-environment provisioning)
 *
 * Server/CLI use only — callers hold a service-role client. Not imported by
 * client code ("server-only" is omitted so the tsx seed CLI can import it).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow, DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import {
  CANONICAL_DEMO_MANAGER_EMAIL,
  CANONICAL_DEMO_MANAGER_NAME,
  CANONICAL_DEMO_RESIDENT_NAME,
  CANONICAL_DEMO_VENDOR_NAME,
} from "@/lib/demo/demo-canonical-accounts";
import { buildDemoIdleSnapshot, type DemoDataSnapshot } from "@/lib/demo/demo-guided-data";
import {
  remapDemoSnapshotForDb,
  type DemoPortfolioDbContext,
} from "@/lib/demo/demo-portfolio-db-remap";
import type { HouseholdCharge, RecurringRentProfile } from "@/lib/household-charges";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import type { ManagerPromotionRow } from "@/lib/promotion-flyer";
import type { ServiceRequest } from "@/lib/service-requests-storage";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { VendorPayout } from "@/lib/vendor-payouts";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";
const RESIDENT_INBOX_SCOPE = "axis_portal_inbox_resident_v1";
const VENDOR_INBOX_SCOPE = "axis_portal_inbox_vendor_v1";

export type CanonicalPortfolioContext = DemoPortfolioDbContext & {
  /** Email written to the manager's profile row. */
  managerEmail?: string;
};

async function must<T>(
  promise: PromiseLike<{ data: T; error: { message: string } | null }>,
  label: string,
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data as T;
}

function demoStableUuid(namespace: string, demoId: string): string {
  const match = demoId.match(/(\d+)/);
  const suffix = (match?.[1] ?? "0").padStart(12, "0").slice(-12);
  const ns = (namespace.charCodeAt(0) % 16).toString(16);
  return `00000000-0000-4000-800${ns}-${suffix}`;
}

export type SeedPortfolioOptions = {
  /**
   * Pre-built snapshot to write instead of the default remapped idle demo
   * portfolio. Lets a caller (scripts/seed-dev-manager-portfolio.ts) namespace
   * every row id so a second manager's portfolio never collides with the
   * canonical sandbox accounts' rows.
   */
  snapshot?: DemoDataSnapshot;
  /**
   * Skip the two GLOBAL singleton schedule rows (axis_admin_planned_events_v1 /
   * axis_admin_partner_inquiries_v1). Required when seeding any account other
   * than the canonical sandbox manager — those ids are deployment-wide, and a
   * second seed would steal them from the canonical account.
   */
  skipGlobalScheduleSingletons?: boolean;
};

export async function seedCanonicalDemoPortfolio(
  db: SupabaseClient,
  ctx: CanonicalPortfolioContext,
  opts: SeedPortfolioOptions = {},
): Promise<void> {
  const snapshot = opts.snapshot ?? remapDemoSnapshotForDb(buildDemoIdleSnapshot(), ctx);

  async function upsertProfiles() {
    await must(
      db.from("profiles").upsert(
        [
          {
            id: ctx.managerUserId,
            email: (ctx.managerEmail ?? CANONICAL_DEMO_MANAGER_EMAIL).toLowerCase(),
            role: "manager",
            full_name: CANONICAL_DEMO_MANAGER_NAME,
            application_approved: false,
          },
          {
            id: ctx.residentUserId,
            email: ctx.residentEmail,
            role: "resident",
            manager_id: ctx.residentAxisId,
            full_name: CANONICAL_DEMO_RESIDENT_NAME,
            application_approved: true,
          },
          {
            id: ctx.vendorUserId,
            email: ctx.vendorEmail,
            role: "vendor",
            full_name: CANONICAL_DEMO_VENDOR_NAME,
            application_approved: false,
          },
        ],
        { onConflict: "id" },
      ),
      "profiles(canonical names)",
    );
  }

  async function upsertProperties(properties: MockProperty[]) {
    const rows = properties.map((property) => ({
      id: property.id,
      manager_user_id: ctx.managerUserId,
      status: "live",
      property_data: { ...property, managerUserId: ctx.managerUserId, adminPublishLive: true },
      row_data: {
        id: property.id,
        status: "live",
        name: property.buildingName ?? property.title,
        buildingName: property.buildingName ?? property.title,
        address: property.address,
        managerUserId: ctx.managerUserId,
      },
      updated_at: new Date().toISOString(),
    }));
    if (rows.length === 0) return;
    await must(db.from("manager_property_records").upsert(rows, { onConflict: "id" }), "manager_property_records");
  }

  async function upsertApplications(applications: DemoApplicantRow[]) {
    const rows = applications.map((app) => ({
      id: app.id,
      manager_user_id: ctx.managerUserId,
      resident_email: app.email?.includes("@") ? app.email.toLowerCase() : null,
      property_id: app.propertyId ?? app.assignedPropertyId ?? null,
      assigned_property_id: app.assignedPropertyId ?? app.propertyId ?? null,
      row_data: sealApplicantRow({
        ...app,
        managerUserId: ctx.managerUserId,
        axisId: app.id,
      }, app.id, ctx.managerUserId),
      updated_at: new Date().toISOString(),
    }));
    if (rows.length === 0) return;
    await must(
      db.from("manager_application_records").upsert(rows, { onConflict: "id" }),
      "manager_application_records",
    );
  }

  async function upsertCharges(charges: HouseholdCharge[]) {
    const rows = charges.map((charge) => ({
      id: charge.id,
      manager_user_id: ctx.managerUserId,
      resident_user_id: charge.residentUserId ?? null,
      resident_email: charge.residentEmail?.toLowerCase() ?? null,
      property_id: charge.propertyId ?? null,
      kind: charge.kind ?? "rent",
      status: charge.status,
      row_data: { ...charge, managerUserId: ctx.managerUserId },
      updated_at: new Date().toISOString(),
    }));
    if (rows.length === 0) return;
    await must(
      db.from("portal_household_charge_records").upsert(rows, { onConflict: "id" }),
      "portal_household_charge_records",
    );
  }

  async function upsertRentProfiles(profiles: RecurringRentProfile[]) {
    const rows = profiles.map((profile) => ({
      id: profile.id,
      manager_user_id: ctx.managerUserId,
      resident_user_id: profile.residentUserId ?? null,
      resident_email: profile.residentEmail?.toLowerCase() ?? null,
      property_id: profile.propertyId ?? null,
      row_data: { ...profile, managerUserId: ctx.managerUserId },
      updated_at: new Date().toISOString(),
    }));
    if (rows.length === 0) return;
    await must(
      db.from("portal_recurring_rent_profile_records").upsert(rows, { onConflict: "id" }),
      "portal_recurring_rent_profile_records",
    );
  }

  async function upsertLeases(leases: LeasePipelineRow[]) {
    const rows = leases.map((lease) => ({
      id: lease.id,
      manager_user_id: ctx.managerUserId,
      resident_user_id: lease.residentUserId ?? null,
      resident_email: lease.residentEmail?.toLowerCase() ?? null,
      property_id: lease.propertyId ?? null,
      status: lease.status ?? lease.stageLabel ?? null,
      row_data: { ...lease, managerUserId: ctx.managerUserId },
      updated_at: new Date().toISOString(),
    }));
    if (rows.length === 0) return;
    await must(
      db.from("portal_lease_pipeline_records").upsert(rows, { onConflict: "id" }),
      "portal_lease_pipeline_records",
    );
  }

  async function upsertWorkOrders(workOrders: DemoManagerWorkOrderRow[]) {
    const rows = workOrders.map((wo) => ({
      id: wo.id,
      manager_user_id: ctx.managerUserId,
      resident_email: wo.residentEmail?.toLowerCase() ?? null,
      property_id: wo.propertyId ?? null,
      assigned_property_id: wo.assignedPropertyId ?? wo.propertyId ?? null,
      vendor_user_id:
        wo.vendorId === "demo-vendor-1" || wo.vendorName === CANONICAL_DEMO_VENDOR_NAME ? ctx.vendorUserId : null,
      row_data: {
        ...wo,
        managerUserId: ctx.managerUserId,
        ...(wo.vendorId === "demo-vendor-1" ? { vendorUserId: ctx.vendorUserId } : {}),
      },
      updated_at: new Date().toISOString(),
    }));
    if (rows.length === 0) return;
    await must(db.from("portal_work_order_records").upsert(rows, { onConflict: "id" }), "portal_work_order_records");
  }

  async function upsertVendors(vendors: ManagerVendorRow[]) {
    const rows = vendors.map((vendor) => ({
      id: vendor.id,
      manager_user_id: ctx.managerUserId,
      vendor_user_id: vendor.vendorUserId ?? (vendor.id === "demo-vendor-1" ? ctx.vendorUserId : null),
      row_data: {
        ...vendor,
        managerUserId: ctx.managerUserId,
        ...(vendor.id === "demo-vendor-1" ? { vendorUserId: ctx.vendorUserId, email: ctx.vendorEmail } : {}),
      },
      updated_at: new Date().toISOString(),
    }));
    if (rows.length === 0) return;
    await must(db.from("manager_vendor_records").upsert(rows, { onConflict: "id" }), "manager_vendor_records");
  }

  async function upsertPromotions(promotions: ManagerPromotionRow[]) {
    const rows = promotions.map((promo) => ({
      id: promo.id,
      manager_user_id: ctx.managerUserId,
      row_data: { ...promo, managerUserId: ctx.managerUserId },
      updated_at: new Date().toISOString(),
    }));
    if (rows.length === 0) return;
    await must(db.from("manager_promotion_records").upsert(rows, { onConflict: "id" }), "manager_promotion_records");
  }

  async function upsertServiceRequests(requests: ServiceRequest[]) {
    const rows = requests.map((req) => ({
      id: req.id,
      manager_user_id: ctx.managerUserId,
      resident_email: req.residentEmail?.toLowerCase() ?? null,
      property_id: req.propertyId ?? null,
      row_data: { ...req, managerUserId: ctx.managerUserId },
      updated_at: new Date().toISOString(),
    }));
    if (rows.length === 0) return;
    await must(
      db.from("portal_service_request_records").upsert(rows, { onConflict: "id" }),
      "portal_service_request_records",
    );
  }

  async function upsertInboxThreads(threads: PersistedInboxThread[], scope: string, ownerUserId: string) {
    const now = new Date().toISOString();
    const rows = threads.map((thread) => ({
      id: thread.id,
      scope,
      owner_user_id: ownerUserId,
      participant_email: thread.email?.toLowerCase() ?? null,
      thread_type: "portal_message",
      row_data: { ...thread, scope },
      updated_at: now,
    }));
    if (rows.length === 0) return;
    await must(
      db.from("portal_inbox_thread_records").upsert(rows, { onConflict: "id" }),
      `portal_inbox_thread_records(${scope})`,
    );
  }

  async function upsertSchedule(schedule: ReturnType<typeof remapDemoSnapshotForDb>["schedule"]) {
    const now = new Date().toISOString();
    const records: Array<Record<string, unknown>> = [];

    // The two singleton ids below are ONE row per database, and the live
    // `/api/public/partner-inquiries` route appends real prospect tour requests
    // to `axis_admin_partner_inquiries_v1`. Upserting them with an empty payload
    // would delete that data, so seeding nothing must be a no-op here — only
    // write them when the snapshot actually carries schedule data. Keep this
    // guard if `buildDemoIdleSnapshot()` is ever refilled.
    const hasScheduleSingletonData =
      schedule.plannedEvents.length > 0 || schedule.partnerInquiries.length > 0;

    if (!opts.skipGlobalScheduleSingletons && hasScheduleSingletonData) {
      records.push({
        id: "axis_admin_planned_events_v1",
        manager_user_id: ctx.managerUserId,
        record_type: "axis_admin_planned_events_v1",
        row_data: {
          id: "axis_admin_planned_events_v1",
          recordType: "axis_admin_planned_events_v1",
          managerUserId: ctx.managerUserId,
          payload: schedule.plannedEvents,
        },
        updated_at: now,
      });

      records.push({
        id: "axis_admin_partner_inquiries_v1",
        manager_user_id: ctx.managerUserId,
        record_type: "axis_admin_partner_inquiries_v1",
        row_data: {
          id: "axis_admin_partner_inquiries_v1",
          recordType: "axis_admin_partner_inquiries_v1",
          managerUserId: ctx.managerUserId,
          payload: schedule.partnerInquiries,
        },
        updated_at: now,
      });
    }

    for (const event of schedule.plannedEvents) {
      records.push({
        id: event.id,
        manager_user_id: ctx.managerUserId,
        property_id: event.propertyId ?? null,
        record_type: "planned_event",
        starts_at: event.start,
        ends_at: event.end,
        row_data: { ...event, recordType: "planned_event", managerUserId: ctx.managerUserId },
        updated_at: now,
      });
    }

    for (const inquiry of schedule.partnerInquiries) {
      records.push({
        id: inquiry.id,
        manager_user_id: ctx.managerUserId,
        property_id: inquiry.propertyId ?? null,
        record_type: "partner_inquiry_request",
        starts_at: inquiry.proposedStart ?? inquiry.requestedWindows?.[0]?.start ?? null,
        ends_at: inquiry.proposedEnd ?? inquiry.requestedWindows?.[0]?.end ?? null,
        row_data: {
          id: inquiry.id,
          recordType: "partner_inquiry_request",
          managerUserId: ctx.managerUserId,
          propertyId: inquiry.propertyId,
          payload: inquiry,
        },
        updated_at: now,
      });
    }

    for (const [propertyId, slots] of Object.entries(schedule.availabilityByPropertyId)) {
      const key = `axis_mgr_avail_slots_v2_${ctx.managerUserId}_prop_${propertyId}`;
      records.push({
        id: key,
        manager_user_id: ctx.managerUserId,
        property_id: propertyId,
        record_type: "manager_property_availability",
        row_data: {
          id: key,
          recordType: "manager_property_availability",
          managerUserId: ctx.managerUserId,
          propertyId,
          payload: slots,
        },
        updated_at: now,
      });
    }

    if (records.length === 0) return;
    await must(db.from("portal_schedule_records").upsert(records, { onConflict: "id" }), "portal_schedule_records");
  }

  async function upsertWorkOrderBids(bids: WorkOrderBid[]) {
    const rows = bids.map((bid) => ({
      id: demoStableUuid("b", bid.id),
      work_order_id: bid.workOrderId,
      vendor_user_id: ctx.vendorUserId,
      vendor_directory_id: bid.vendorDirectoryId ?? "demo-vendor-1",
      manager_user_id: ctx.managerUserId,
      amount_cents: bid.amountCents,
      materials_cents: bid.materialsCents ?? 0,
      quote_mode: bid.quoteMode ?? "upfront",
      consultation_visit_at: bid.consultationVisitAt,
      proposed_time: bid.proposedTime,
      note: bid.note,
      status: bid.status,
      created_at: bid.createdAt,
      updated_at: bid.updatedAt,
    }));
    if (rows.length === 0) return;
    await must(db.from("work_order_bids").upsert(rows, { onConflict: "id" }), "work_order_bids");
  }

  async function upsertWorkOrderVendorOffers(workOrders: DemoManagerWorkOrderRow[]) {
    const now = new Date().toISOString();
    const rows = workOrders
      .filter((wo) => wo.biddingOpen && wo.vendorId)
      .map((wo) => ({
        id: demoStableUuid("o", wo.id),
        work_order_id: wo.id,
        vendor_directory_id: wo.vendorId!,
        vendor_user_id: ctx.vendorUserId,
        manager_user_id: ctx.managerUserId,
        status: "sent" as const,
        created_at: now,
        updated_at: now,
      }));
    if (rows.length === 0) return;
    await must(
      db.from("work_order_vendor_offers").upsert(rows, { onConflict: "work_order_id,vendor_directory_id" }),
      "work_order_vendor_offers",
    );
  }

  async function upsertVendorPayouts(payouts: VendorPayout[]) {
    const rows = payouts.map((payout) => ({
      id: demoStableUuid("p", payout.id),
      manager_user_id: ctx.managerUserId,
      vendor_user_id: ctx.vendorUserId,
      work_order_id: payout.workOrderId,
      amount_cents: payout.amountCents,
      stripe_transfer_id: payout.stripeTransferId,
      status: payout.status,
      failure_reason: payout.failureReason,
      created_at: payout.createdAt,
      updated_at: payout.createdAt,
    }));
    if (rows.length === 0) return;
    await must(db.from("vendor_payouts").upsert(rows, { onConflict: "work_order_id" }), "vendor_payouts");
  }

  await upsertProfiles();
  await upsertProperties(snapshot.properties);
  await upsertApplications(snapshot.applications);
  await upsertCharges(snapshot.charges);
  await upsertRentProfiles(snapshot.rentProfiles);
  await upsertLeases(snapshot.leases);
  await upsertVendors(snapshot.vendors);
  await upsertWorkOrders(snapshot.workOrders);
  await upsertWorkOrderVendorOffers(snapshot.workOrders);
  await upsertPromotions(snapshot.promotions);
  await upsertServiceRequests(snapshot.serviceRequests);
  await upsertInboxThreads(snapshot.managerInbox, MANAGER_INBOX_SCOPE, ctx.managerUserId);
  await upsertInboxThreads(snapshot.residentInbox, RESIDENT_INBOX_SCOPE, ctx.residentUserId);
  await upsertInboxThreads(snapshot.vendorInbox, VENDOR_INBOX_SCOPE, ctx.vendorUserId);
  await upsertSchedule(snapshot.schedule);
  await upsertWorkOrderBids(snapshot.workOrderBids);
  await upsertVendorPayouts(snapshot.vendorPayouts);
}
