import { describe, expect, it } from "vitest";
import {
  ACTION_EVENT_CATALOG,
  applicationEventForTransition,
  leaseEventForTransition,
  renderApplicationActionEvent,
  renderLeaseActionEvent,
  renderServiceRequestActionEvent,
  serviceRequestEventForTransition,
} from "@/lib/domain-action-events.server";
import {
  DEFAULT_MANAGER_NOTIFICATION_DESTINATION,
  resolveManagerNotificationRoute,
} from "@/lib/manager-notification-preferences";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@/lib/notification-preferences";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

/**
 * Every lifecycle moment where one party acts and ANOTHER party is left
 * waiting has to reach that other party. Two whole classes of it reached
 * nobody: the one-sided lease signature steps, and the applicant's own side of
 * their application.
 */
const lease = (patch: Partial<LeasePipelineRow> = {}): LeasePipelineRow => ({
  id: "lease-1",
  residentName: "Sam Resident",
  residentEmail: "sam@example.com",
  unit: "Unit 2A",
  stageLabel: "Review",
  updated: "Today",
  bucket: "manager",
  pdfVersion: 1,
  notes: "",
  updatedAtIso: "2026-09-04T12:00:00.000Z",
  thread: [],
  ...patch,
});

const residentSigned = (at = "2026-09-05T10:00:00.000Z") => ({
  residentSignature: { name: "Sam Resident", signedAtIso: at, role: "resident" as const },
});
const managerSigned = (at = "2026-09-05T11:00:00.000Z") => ({
  managerSignature: { name: "Dana Manager", signedAtIso: at, role: "manager" as const },
});

describe("lease signature steps notify the party being waited on", () => {
  it("fires when the resident signs and the lease is not yet executed", () => {
    expect(leaseEventForTransition(lease(), lease({ ...residentSigned() }))).toBe(
      "lease_signed_by_resident",
    );
  });

  it("fires when the manager countersigns first", () => {
    expect(leaseEventForTransition(lease(), lease({ ...managerSigned() }))).toBe(
      "lease_countersigned",
    );
  });

  it("full execution outranks either half", () => {
    // One save can carry the second signature AND fullySignedAt. "It is waiting
    // on the other party" would then be untrue for both of them.
    expect(
      leaseEventForTransition(
        lease({ ...residentSigned() }),
        lease({ ...residentSigned(), ...managerSigned(), fullySignedAt: "2026-09-05T11:00:00.000Z" }),
      ),
    ).toBe("lease_signed");
  });

  it("does not re-fire on an unrelated save after signing", () => {
    const signed = lease({ ...residentSigned() });
    expect(leaseEventForTransition(signed, lease({ ...residentSigned(), notes: "edited" }))).toBeNull();
  });

  it("recognises the legacy signature fields as a resident signature", () => {
    // Older rows stored signatureName/signedAtIso rather than residentSignature.
    expect(
      leaseEventForTransition(
        lease(),
        lease({ signatureName: "Sam Resident", signedAtIso: "2026-09-05T10:00:00.000Z" }),
      ),
    ).toBe("lease_signed_by_resident");
  });

  it("tells each side who is now waiting on whom", () => {
    const facts = { residentName: "Sam Resident", propertyLabel: "Unit 2A" };
    expect(renderLeaseActionEvent("lease_signed_by_resident", "manager", facts)?.text).toContain(
      "waiting on your countersignature",
    );
    expect(renderLeaseActionEvent("lease_signed_by_resident", "resident", facts)?.text).toContain(
      "goes to your property manager",
    );
    expect(renderLeaseActionEvent("lease_countersigned", "resident", facts)?.text).toContain(
      "waiting on your signature",
    );
  });
});

describe("application lifecycle reaches the applicant", () => {
  const app = (patch: Record<string, unknown> = {}) => ({
    id: "app-1",
    name: "Sam Resident",
    email: "sam@example.com",
    property: "Unit 2A",
    bucket: "pending",
    ...patch,
  });

  it("is on the shared catalog rather than a parallel bus", () => {
    expect(ACTION_EVENT_CATALOG.application).toEqual(
      expect.arrayContaining([
        "application_submitted",
        "application_approved",
        "application_declined",
        "application_withdrawn",
      ]),
    );
  });

  it("maps submit, approve and decline", () => {
    expect(applicationEventForTransition(null, app())).toBe("application_submitted");
    expect(applicationEventForTransition(app(), app({ bucket: "approved" }))).toBe(
      "application_approved",
    );
    expect(applicationEventForTransition(app(), app({ bucket: "rejected" }))).toBe(
      "application_declined",
    );
    expect(applicationEventForTransition(app(), app())).toBeNull();
  });

  it("treats withdrawal as its own event and then goes quiet", () => {
    // Withdrawal is reversible and keeps the bucket, so a bucket comparison
    // across that boundary is not a decision anyone made.
    expect(
      applicationEventForTransition(app(), app({ withdrawnAt: "2026-09-05T09:00:00.000Z" })),
    ).toBe("application_withdrawn");
    expect(
      applicationEventForTransition(
        app({ withdrawnAt: "2026-09-05T09:00:00.000Z" }),
        app({ withdrawnAt: "2026-09-05T09:00:00.000Z", bucket: "approved" }),
      ),
    ).toBeNull();
  });

  it("never automates a decline reason", () => {
    // Adverse-action reasoning is a regulated disclosure a manager sends
    // deliberately. The automated line says the outcome and points at a person.
    const declined = renderApplicationActionEvent("application_declined", "resident", {
      applicantName: "Sam Resident",
      propertyLabel: "Unit 2A",
    });
    expect(declined?.text).toContain("was not approved");
    expect(declined?.text).toContain("property manager can tell you more");
    expect(declined?.text).not.toMatch(/because|credit|score|income|background/i);
  });

  it("confirms receipt to the applicant on submit", () => {
    expect(
      renderApplicationActionEvent("application_submitted", "resident", {
        applicantName: "Sam Resident",
      })?.text,
    ).toContain("We received your application");
  });
});

describe("add-on service requests reach both sides", () => {
  it("stays a separate model from maintenance work orders", () => {
    // Same reason they keep separate tables and tabs: parking and storage are
    // resident-purchasable offerings, not repairs.
    expect(ACTION_EVENT_CATALOG.service_request).toEqual(
      expect.arrayContaining([
        "service_request_submitted",
        "service_request_approved",
        "service_request_denied",
        "service_request_returned",
      ]),
    );
    expect(ACTION_EVENT_CATALOG.service_request).not.toEqual(ACTION_EVENT_CATALOG.work_order);
  });

  it("maps submission and every status change after it", () => {
    expect(serviceRequestEventForTransition(null, "pending")).toBe("service_request_submitted");
    expect(serviceRequestEventForTransition("pending", "pending")).toBeNull();
    expect(serviceRequestEventForTransition("pending", "approved")).toBe("service_request_approved");
    expect(serviceRequestEventForTransition("pending", "denied")).toBe("service_request_denied");
    expect(serviceRequestEventForTransition("approved", "returned")).toBe("service_request_returned");
  });

  it("acknowledges the resident's own submission", () => {
    // The manager was told; the resident who filed it heard nothing at all.
    expect(
      renderServiceRequestActionEvent("service_request_submitted", "resident", {
        offerName: "Parking spot 4",
        residentName: "Sam Resident",
        priceLabel: "$75/mo",
      })?.text,
    ).toContain("We received your request");
  });

  it("points a denial at a person rather than inventing a reason", () => {
    expect(
      renderServiceRequestActionEvent("service_request_denied", "resident", {
        offerName: "Storage unit B",
        residentName: "Sam Resident",
      })?.text,
    ).toContain("property manager can tell you more");
  });
});

describe("an automated notice defaults to all three channels", () => {
  it("residents and vendors get PropLane, email and SMS on every category", () => {
    for (const [category, channels] of Object.entries(DEFAULT_NOTIFICATION_PREFERENCES)) {
      expect(channels, `${category} must default to every channel`).toEqual({
        inbox: true,
        email: true,
        sms: true,
      });
    }
  });

  it("managers default to PropLane plus a text, not PropLane alone", () => {
    expect(DEFAULT_MANAGER_NOTIFICATION_DESTINATION).toBe("both");
    const route = resolveManagerNotificationRoute({
      destination: DEFAULT_MANAGER_NOTIFICATION_DESTINATION,
      categoryEnabled: true,
      personalPhoneReady: true,
      workNumberReady: true,
    });
    expect(route).toEqual({ assistant: true, sms: true, fellBackToAssistant: false });
  });

  it("but never texts a manager who is not actually set up for it", () => {
    // The default turns SMS ON as a preference; it does not bypass a single
    // hard gate. No verified cell, or no work number to send from, means no text.
    const base = { destination: DEFAULT_MANAGER_NOTIFICATION_DESTINATION, categoryEnabled: true };
    expect(
      resolveManagerNotificationRoute({ ...base, personalPhoneReady: false, workNumberReady: true }).sms,
    ).toBe(false);
    expect(
      resolveManagerNotificationRoute({ ...base, personalPhoneReady: true, workNumberReady: false }).sms,
    ).toBe(false);
    expect(
      resolveManagerNotificationRoute({
        ...base,
        categoryEnabled: false,
        personalPhoneReady: true,
        workNumberReady: true,
      }).sms,
    ).toBe(false);
    // And a manager who chose "none" still gets nothing.
    expect(
      resolveManagerNotificationRoute({
        destination: "none",
        categoryEnabled: true,
        personalPhoneReady: true,
        workNumberReady: true,
      }),
    ).toEqual({ assistant: false, sms: false, fellBackToAssistant: false });
  });
});
