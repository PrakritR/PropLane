/**
 * What a share link may hand to someone who is merely holding a URL.
 *
 * A share link authorizes nothing — possession of the URL IS the whole credential, it is
 * unauthenticated, and it stays live for up to 90 days. The manager's own copy of the same
 * application is the screening document, carrying full date of birth, driver's-licence number,
 * employment, references and disclosures.
 *
 * The public path therefore renders an ALLOWLISTED summary (`publicShare`) rather than the
 * screening document with fields subtracted. That direction matters: a denylist ships every field
 * nobody remembered to name, and this document gains fields over time.
 *
 * These tests pin BOTH directions. A test that only asserted the omission would still pass if
 * someone stripped the manager's copy too and quietly broke screening — and an earlier version of
 * this file guarded a redaction option that no surface actually called, which read as share-path
 * coverage it did not provide.
 */
import { describe, expect, it } from "vitest";
import { buildApplicationHtml } from "@/lib/manager-application-html";

const DOB = "1991-04-17";
const LICENCE = "WDL-A4471299";
const SSN = "123-45-6789";

const row = {
  id: "AXIS-1",
  application: {
    fullLegalName: "Ahalya Bindhu Rajesh",
    dateOfBirth: DOB,
    driversLicense: LICENCE,
    ssn: SSN,
    monthlyIncome: 4200,
    bankruptcyHistory: true,
  },
} as never;

const COSIGNER = [
  { fullLegalName: "Priya Rajesh", dob: "1962-02-02", dlNumber: "WDL-C0099", ssn: "987-65-4321" },
] as never;

describe("the manager's own copy", () => {
  const html = buildApplicationHtml(row);

  it("still shows the identity documents they are screening against", () => {
    expect(html).toContain(DOB);
    expect(html).toContain(LICENCE);
  });

  it("masks the SSN to last-4, as it always did", () => {
    expect(html).not.toContain(SSN);
    expect(html).toContain("6789");
  });

  it("still shows a co-signer's details", () => {
    const withCosigner = buildApplicationHtml(row, { cosignerSubmissions: COSIGNER });
    expect(withCosigner).toContain("1962-02-02");
    expect(withCosigner).toContain("WDL-C0099");
  });
});

describe("the public share copy", () => {
  const html = buildApplicationHtml(row, { publicShare: true });

  it("omits the date of birth and the licence number entirely", () => {
    // Full name + DOB + licence number is enough to open credit in someone's name.
    expect(html).not.toContain(DOB);
    expect(html).not.toContain(LICENCE);
  });

  it("carries no SSN digits at all, not even the masked last-4", () => {
    expect(html).not.toContain(SSN);
    expect(html).not.toContain("6789");
  });

  it("omits the disclosure answers", () => {
    // Bankruptcy, eviction and criminal answers are the most damaging fields in the document and
    // the least necessary to whoever a link was shared with.
    expect(html.toLowerCase()).not.toContain("bankruptcy");
  });

  it("omits a co-signer's identity documents", () => {
    // A co-signer never consented to an unauthenticated audience either.
    const withCosigner = buildApplicationHtml(row, {
      publicShare: true,
      cosignerSubmissions: COSIGNER,
    });
    expect(withCosigner).not.toContain("1962-02-02");
    expect(withCosigner).not.toContain("WDL-C0099");
  });

  it("still identifies the applicant, or the page says nothing at all", () => {
    // The allowlist has to stay useful — a share that names nobody is not worth sending.
    expect(html).toContain("Ahalya Bindhu Rajesh");
  });
});
