/**
 * What a share link may hand to someone who is merely holding a URL.
 *
 * A share link authorizes nothing — possession of the URL IS the whole credential, it is
 * unauthenticated, and it stays live for up to 90 days. The application document behind it is the
 * same one the manager downloads while screening, and that document carries the applicant's full
 * date of birth and driver's-licence number.
 *
 * SSN was already masked to last-4 everywhere. But full name + DOB + licence number + SSN last-4
 * is enough to open credit in someone's name, so the two unmasked fields are withheld on the
 * public path specifically. The manager's own copy is deliberately unchanged: they are already
 * authorized to read the application they are screening.
 *
 * These tests pin BOTH directions. A test that only asserted the redaction would still pass if
 * someone redacted the manager's copy too and quietly broke screening.
 */
import { describe, expect, it } from "vitest";
import { buildApplicationHtml } from "@/lib/manager-application-html";

const DOB = "1991-04-17";
const LICENCE = "WDL-A4471299";

const row = {
  id: "AXIS-1",
  application: {
    fullLegalName: "Ahalya Bindhu Rajesh",
    dateOfBirth: DOB,
    driversLicense: LICENCE,
    ssn: "123-45-6789",
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

  it("masks the SSN, as it always did", () => {
    expect(html).not.toContain("123-45-6789");
    expect(html).toContain("6789");
  });
});

describe("the public share copy", () => {
  const html = buildApplicationHtml(row, { redactIdentityDocuments: true });

  it("withholds the date of birth and the licence number", () => {
    expect(html).not.toContain(DOB);
    expect(html).not.toContain(LICENCE);
  });

  it("says the field was withheld rather than leaving it blank", () => {
    // A blank row reads as "the applicant did not answer", which is a different and misleading
    // claim about the application.
    expect(html).toContain("Withheld");
  });

  it("keeps the SSN masked rather than reintroducing it", () => {
    expect(html).not.toContain("123-45-6789");
  });

  it("withholds a co-signer's identity documents too", () => {
    // A co-signer never consented to an unauthenticated audience either.
    const withCosigner = buildApplicationHtml(row, {
      redactIdentityDocuments: true,
      cosignerSubmissions: COSIGNER,
    });
    expect(withCosigner).not.toContain("1962-02-02");
    expect(withCosigner).not.toContain("WDL-C0099");
  });

  it("does not redact a co-signer on the manager's copy", () => {
    const managerCopy = buildApplicationHtml(row, { cosignerSubmissions: COSIGNER });
    expect(managerCopy).toContain("1962-02-02");
    expect(managerCopy).toContain("WDL-C0099");
  });
});

describe("an application that answered nothing", () => {
  it("stays blank rather than claiming a value was withheld", () => {
    // "Withheld" would assert the applicant supplied something they never did.
    const html = buildApplicationHtml({ id: "AXIS-2", application: {} } as never, {
      redactIdentityDocuments: true,
    });
    expect(html).not.toContain("Withheld");
  });
});
