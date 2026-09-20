import { describe, expect, it } from "vitest";
import { manualResidentSignedLeasePdf } from "@/lib/existing-resident-onboarding";
import {
  buildManualResidentRow,
  buildProspectRow,
  emptyAddPersonForm,
  paymentSchedulePreview,
  thingsToFinish,
  type AddPersonForm,
} from "@/components/portal/resident-wizard/state";

const ctx = {
  userId: "mgr-1",
  propertyLabelFor: (id: string) => (id === "prop-1" ? "Alder Row" : undefined),
  now: () => new Date("2026-09-16T17:00:00.000Z"),
  idSuffix: () => "TEST0001",
};

function filled(overrides: Partial<AddPersonForm> = {}): AddPersonForm {
  return {
    ...emptyAddPersonForm("resident"),
    name: "Maya Chen",
    email: "maya.chen@proton.me",
    phone: "+12065550142",
    propertyId: "prop-1",
    leaseTerm: "12 months",
    leaseTermCustomMode: true,
    moveInDate: "2026-06-01",
    moveOutDate: "2027-05-31",
    rent: "875",
    utilities: "175",
    moveInFee: "200",
    securityDeposit: "875",
    notes: "Migrated from paper",
    ...overrides,
  };
}

describe("buildManualResidentRow — parity with the old modal", () => {
  it("writes the same row the modal wrote for the same inputs", () => {
    const result = buildManualResidentRow(filled(), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.row;
    expect(row.id).toBe("PROPLANE-TEST0001");
    expect(row.name).toBe("Maya Chen");
    expect(row.email).toBe("maya.chen@proton.me");
    expect(row.property).toBe("Alder Row");
    expect(row.manuallyAdded).toBe(true);
    expect(row.managerUserId).toBe("mgr-1");
    expect(row.assignedPropertyId).toBe("prop-1");
    expect(row.signedMonthlyRent).toBe(875);
    expect(row.bucket).toBe("approved");
    expect(row.manualResidentDetails).toMatchObject({
      phone: "+12065550142",
      moveInDate: "2026-06-01",
      moveOutDate: "2027-05-31",
      monthlyUtilities: 175,
      moveInFee: 200,
      securityDeposit: 875,
      leaseTerm: "12 months",
      notes: "Migrated from paper",
    });
    // No PDF attached → no off-platform filing, whatever the document pick says.
    expect(row.manualResidentDetails?.externallySignedLease).toBeUndefined();
    expect(row.manualResidentDetails?.signedLeaseDataUrl).toBeUndefined();
    expect(row.application).toMatchObject({
      propertyId: "prop-1",
      // The shared normalizer maps the manager's free text onto the listing vocabulary.
      leaseTerm: "12-Month",
      rentalType: "standard",
      leaseStart: "2026-06-01",
      leaseEnd: "2027-05-31",
      fullLegalName: "Maya Chen",
      email: "maya.chen@proton.me",
      phone: "+12065550142",
    });
  });

  it("refuses without a name or email, exactly as before", () => {
    expect(buildManualResidentRow(filled({ name: " " }), ctx)).toEqual({ ok: false, error: "Enter the resident's name." });
    expect(buildManualResidentRow(filled({ email: "" }), ctx)).toEqual({ ok: false, error: "Enter the resident's email." });
  });

  it("files a signed PDF as executed and a draft PDF as nothing on the row", () => {
    const signed = buildManualResidentRow(filled({ leaseDocument: "signed", leaseDataUrl: "data:application/pdf;base64,AAAA", leaseFileName: "lease.pdf" }), ctx);
    const draft = buildManualResidentRow(filled({ leaseDocument: "draft", leaseDataUrl: "data:application/pdf;base64,AAAA", leaseFileName: "lease.pdf" }), ctx);
    expect(signed.ok && draft.ok).toBe(true);
    if (!signed.ok || !draft.ok) return;
    expect(signed.row.manualResidentDetails?.externallySignedLease).toBe(true);
    expect(manualResidentSignedLeasePdf(signed.row)).not.toBeNull();
    expect(draft.row.manualResidentDetails?.externallySignedLease).toBeUndefined();
    expect(manualResidentSignedLeasePdf(draft.row)).toBeNull();
  });

  it("writes the application answers in the applicant's own keys, only when filled", () => {
    const result = buildManualResidentRow(
      filled({
        application: {
          employer: "Puget Sound Energy",
          monthlyIncome: "5400",
          currentStreet: "1180 Harrison St",
          currentCity: "Seattle",
          currentState: "WA",
          currentZip: "98109",
          occupancyCount: "1",
          pets: "1 cat",
          evictionHistory: "No",
          dateOfBirth: "",
        },
        vehicles: 1,
        preferredContact: "sms",
      }),
      ctx,
      [{ key: "smoke", label: "Do you smoke or vape?", type: "select", section: "additional" }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.row.application as unknown as Record<string, unknown>;
    expect(app.employer).toBe("Puget Sound Energy");
    expect(app.monthlyIncome).toBe("5400");
    expect(app.currentZip).toBe("98109");
    expect(app.pets).toBe("1 cat");
    expect(app.evictionHistory).toBe("No");
    expect("dateOfBirth" in app).toBe(false);
    expect("ssn" in app).toBe(false);
    expect(app.customFieldAnswers).toBeUndefined();
    expect(result.row.manualResidentDetails?.vehicles).toBe(1);
    expect(result.row.manualResidentDetails?.preferredContact).toBe("sms");
  });

  it("carries custom question answers with their label and section", () => {
    const result = buildManualResidentRow(
      filled({ customAnswers: { smoke: "No" } }),
      ctx,
      [{ key: "smoke", label: "Do you smoke or vape?", type: "select", section: "additional" }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.row.application as unknown as { customFieldAnswers?: unknown[] };
    expect(app.customFieldAnswers).toEqual([{ key: "smoke", label: "Do you smoke or vape?", type: "select", section: "additional", value: "No" }]);
  });
});

describe("buildProspectRow", () => {
  it("lands in Potential as a pending, manager-added row with no application fee exposure", () => {
    const result = buildProspectRow(
      { ...emptyAddPersonForm("prospect"), name: "Dev Patel", phone: "+12065550199", propertyId: "prop-1", wantedMoveIn: "2026-10-01", budget: "900" },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.bucket).toBe("pending");
    expect(result.row.manuallyAdded).toBe(true);
    expect(result.row.manualResidentDetails?.prospect).toEqual({ wantedMoveIn: "2026-10-01", budget: "900" });
    expect(result.row.manualResidentDetails?.phone).toBe("+12065550199");
  });

  it("needs a name and one way to reach them", () => {
    expect(buildProspectRow({ ...emptyAddPersonForm("prospect"), name: "Dev" }, ctx).ok).toBe(false);
  });
});

describe("thingsToFinish", () => {
  it("lists contact, home and lease fields on an empty resident form — not a PDF", () => {
    const labels = thingsToFinish(emptyAddPersonForm("resident")).map((t) => t.label);
    expect(labels).toEqual(["Resident's name", "Resident's email", "Property", "Lease term", "Move-in date", "Monthly rent"]);
    expect(emptyAddPersonForm("resident").leaseDocument).toBe("later");
  });

  it("is empty once the resident form is filled", () => {
    expect(thingsToFinish(filled())).toEqual([]);
  });

  it("asks for the signed PDF only when the manager said the lease is already signed", () => {
    expect(thingsToFinish(filled({ leaseDocument: "signed" })).map((t) => t.label)).toEqual(["The signed lease PDF"]);
    expect(thingsToFinish(filled({ leaseDocument: "signed", leaseDataUrl: "data:application/pdf;base64,AAAA" }))).toEqual([]);
  });

  it("does not ask for a PDF when the lease will be generated later", () => {
    expect(thingsToFinish(filled({ leaseDocument: "later" }))).toEqual([]);
  });

  it("asks a prospect only for a name, a way to reach them, and the tour time when a tour is planned", () => {
    expect(thingsToFinish(emptyAddPersonForm("prospect")).map((t) => t.label)).toEqual(["Prospect's name", "An email or phone", "Tour date and time"]);
    expect(thingsToFinish({ ...emptyAddPersonForm("prospect"), name: "Dev", phone: "1", tourFormat: "none" })).toEqual([]);
  });
});

describe("paymentSchedulePreview", () => {
  const today = new Date(2026, 8, 16);

  it("lists every month from move-in through today with rent + utilities", () => {
    const rows = paymentSchedulePreview(filled(), today);
    expect(rows.map((r) => r.monthKey)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(rows[0]!.total).toBe(1050);
    expect(rows[3]!.isCurrent).toBe(true);
    expect(rows[1]!.dueOn).toBe("2026-07-01");
  });

  it("prorates a mid-month move-in by days", () => {
    const rows = paymentSchedulePreview(filled({ moveInDate: "2026-06-18" }), today);
    expect(rows[0]!.prorated).toBe(true);
    // 13 of 30 days
    expect(rows[0]!.rentAmount).toBe(379.17);
    expect(rows[0]!.dueOn).toBe("2026-06-18");
    expect(rows[1]!.prorated).toBe(false);
  });

  it("emits nothing for a future move-in, an airbnb stay, or no rent", () => {
    expect(paymentSchedulePreview(filled({ moveInDate: "2026-11-01" }), today)).toEqual([]);
    expect(paymentSchedulePreview(filled({ rent: "", utilities: "" }), today)).toEqual([]);
  });

  it("stops at the move-out month", () => {
    const rows = paymentSchedulePreview(filled({ moveOutDate: "2026-07-31" }), today);
    expect(rows.map((r) => r.monthKey)).toEqual(["2026-06", "2026-07"]);
  });
});
