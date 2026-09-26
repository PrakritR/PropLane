"use client";

/**
 * The home page's lifecycle rows (`site/lifecycle-rows.tsx`) drive their
 * `/demo` iframes with scripted "beats" over `postMessage` — same-origin,
 * demo-only, never a real write. This module is the RECEIVING side, mounted
 * once inside `/demo` itself (`DemoManagerShell`): it listens for those
 * messages and applies each beat as a real mutation to the same local
 * (sessionStorage-backed) demo stores every panel already reads, through the
 * SAME `write`/`seedDemo*` functions the real UI actions call — so the
 * change is genuinely visible in the panel, not a fake overlay, and never
 * touches a real row (every store below is demo-scoped already).
 *
 * Captain: "have ui auto update" — this is the mechanism, not just rotating
 * which perspective tab is showing.
 */
import { DEMO_MANAGER_USER_ID } from "@/lib/demo/demo-session";
import { readHouseholdCharges, seedDemoHouseholdCharges } from "@/lib/household-charges";
import { readLeasePipeline, seedDemoLeasePipeline } from "@/lib/lease-pipeline-storage";
import { readManagerApplicationRows, seedDemoManagerApplicationRows } from "@/lib/manager-applications-storage";
import { readManagerWorkOrderRows, seedDemoManagerWorkOrderRows } from "@/lib/manager-work-orders-storage";

export const LIFECYCLE_BEAT_MESSAGE_SOURCE = "proplane-lifecycle";

export type LifecycleBeatMessage = {
  source: typeof LIFECYCLE_BEAT_MESSAGE_SOURCE;
  scenario: string;
  beat: number;
};

const TOAST_EVENT = "proplane-demo-toast";

/** A small corner toast — `demo-lifecycle-toast-listener.tsx` renders it. */
function toast(text: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(TOAST_EVENT, { detail: text }));
}

export function subscribeLifecycleToast(listener: (text: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => listener((e as CustomEvent<string>).detail);
  window.addEventListener(TOAST_EVENT, handler);
  return () => window.removeEventListener(TOAST_EVENT, handler);
}

/** Tours: no pending-request queue is seeded (the three tours are already
 * confirmed on the calendar) — the beat script is the reminder confirmation. */
function toursBeat(beat: number) {
  if (beat === 3) toast("Reminder set for Friday");
}

/** Applications: Maple Duplex's application moves Screening → Approved. */
function applicationsBeat(beat: number) {
  const rows = readManagerApplicationRows();
  // The seeded id `demo-app-maple` gets normalized to an uppercase axis id by
  // the read pipeline — match on the seeded email instead of guessing that shape.
  const idx = rows.findIndex((r) => r.email === "sample.applicant@example.com");
  if (idx === -1) return;
  const row = rows[idx]!;
  if (beat === 1) rows[idx] = { ...row, stage: "Documents complete", bucket: "pending" };
  if (beat >= 2) rows[idx] = { ...row, stage: "Approved", bucket: "approved" };
  seedDemoManagerApplicationRows(rows, DEMO_MANAGER_USER_ID);
  if (beat === 2) toast("Application approved — Maple Duplex");
}

/** Leasing: Alder House's lease goes resident-signed → fully executed. */
function leasingBeat(beat: number) {
  const rows = readLeasePipeline(DEMO_MANAGER_USER_ID);
  const idx = rows.findIndex((r) => r.id === "demo-lease-demo-prop-alder");
  if (idx === -1) return;
  const row = rows[idx]!;
  const now = new Date().toISOString();
  if (beat === 1) {
    rows[idx] = {
      ...row,
      residentSignature: { name: row.residentName, signedAtIso: now, role: "resident" },
      status: "Manager Signature Pending",
      bucket: "signed",
    };
  }
  if (beat >= 2) {
    rows[idx] = {
      ...rows[idx]!,
      managerSignature: { name: "Test Manager", signedAtIso: now, role: "manager" },
      status: "Fully Signed",
      fullySignedAt: now,
      signedAtIso: now,
    };
  }
  seedDemoLeasePipeline(rows, DEMO_MANAGER_USER_ID);
  if (beat === 2) toast("Lease executed — deposit charge sent");
}

/** Payments: Alder's overdue rent charge is paid; Pacific Plumbing's job pays out (toast only — the payout ledger isn't part of this bundle yet). */
function paymentsBeat(beat: number) {
  const charges = readHouseholdCharges();
  const idx = charges.findIndex((c) => c.id === "demo-charge-demo-prop-alder-current");
  if (idx !== -1 && beat >= 2) {
    const row = charges[idx]!;
    charges[idx] = {
      ...row,
      status: "paid",
      balanceLabel: "$0.00",
      paidAmountCents: 320_000,
      paidAt: new Date().toISOString(),
      paidMethod: "bank",
    };
    seedDemoHouseholdCharges(charges);
  }
  if (beat === 2) toast("$3,200 paid — Test Resident");
  if (beat === 3) toast("$220 paid to Pacific Plumbing");
}

/** Maintenance: Maple's open "No hot water" job is dispatched, scheduled, then a $90 change order is approved. */
function maintenanceBeat(beat: number) {
  const rows = readManagerWorkOrderRows();
  const idx = rows.findIndex((r) => r.id === "demo-wo-maple-heat");
  if (idx === -1) return;
  const row = rows[idx]!;
  if (beat === 1) {
    rows[idx] = { ...row, status: "Dispatched", bucket: "open", vendorName: "Pacific Plumbing" };
  }
  if (beat === 2) {
    rows[idx] = {
      ...rows[idx]!,
      status: "Scheduled",
      bucket: "scheduled",
      scheduled: "Thu 10:00 AM – 12:00 PM",
      scheduledAtIso: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      cost: "$90.00",
    };
  }
  if (beat >= 3) {
    rows[idx] = { ...rows[idx]!, status: "Completed", bucket: "completed" };
  }
  seedDemoManagerWorkOrderRows(rows);
  if (beat === 3) toast("Change order approved — $90");
}

const HANDLERS: Record<string, (beat: number) => void> = {
  tours: toursBeat,
  applications: applicationsBeat,
  leasing: leasingBeat,
  payments: paymentsBeat,
  maintenance: maintenanceBeat,
};

/** Reset a scenario back to its beat-0 baseline (Replay). Re-seeds the whole
 * idle snapshot's slice for that scenario's store rather than trying to
 * invert each mutation individually. */
export async function resetLifecycleScenario(scenario: string): Promise<void> {
  const { buildDemoIdleSnapshot } = await import("@/lib/demo/demo-guided-data");
  const snapshot = buildDemoIdleSnapshot();
  if (scenario === "applications") seedDemoManagerApplicationRows(snapshot.applications, DEMO_MANAGER_USER_ID);
  if (scenario === "leasing") seedDemoLeasePipeline(snapshot.leases, DEMO_MANAGER_USER_ID);
  if (scenario === "payments") seedDemoHouseholdCharges(snapshot.charges, snapshot.rentProfiles);
  if (scenario === "maintenance") seedDemoManagerWorkOrderRows(snapshot.workOrders);
}

export function applyLifecycleBeat(scenario: string, beat: number): void {
  if (beat === 0) {
    // Beat 0 is always "baseline" — reset before replaying from the top so a
    // paused-then-replayed row doesn't compound a prior loop's mutations.
    void resetLifecycleScenario(scenario);
    return;
  }
  HANDLERS[scenario]?.(beat);
}

/** Mounted once inside `/demo` (`DemoManagerShell`). */
export function installLifecycleBeatListener(): () => void {
  if (typeof window === "undefined") return () => {};
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as Partial<LifecycleBeatMessage> | undefined;
    if (!data || data.source !== LIFECYCLE_BEAT_MESSAGE_SOURCE) return;
    if (typeof data.scenario !== "string" || typeof data.beat !== "number") return;
    applyLifecycleBeat(data.scenario, data.beat);
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
