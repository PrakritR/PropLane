// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { mergeInboxScopedContacts } from "@/lib/manager-inbox-contacts";
import { consumeManagerComposePrefill, stageManagerComposePrefill } from "@/lib/manager-compose-prefill";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";

/**
 * Vendor texting, manager side (Oct 6): a roster vendor is a valid text
 * recipient at THEIR OWN saved phone; the Vendors list row and the vendor record
 * get a Text action that opens New message on that vendor; the "I work with this
 * vendor" box appears only when the server says the first text still needs it.
 */
const modal = readFileSync("src/components/portal/pro-communication-compose-modal.tsx", "utf8");
const vendorsPanel = readFileSync("src/components/portal/pro-vendors-panel.tsx", "utf8");

const vendor = (over: Partial<InboxScopedContact> = {}): InboxScopedContact => ({
  id: "ven-1",
  name: "Mike's Plumbing",
  email: "mike@plumbing.test",
  role: "vendor",
  ...over,
});

describe("the recipient list", () => {
  it("keeps a roster vendor that has a phone but no email (text only), keyed by id", () => {
    const merged = mergeInboxScopedContacts([vendor({ id: "ven-2", email: "", phone: "(425) 555-0199", textOnly: true })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "ven-2", email: "", phone: "(425) 555-0199", textOnly: true });
  });

  it("still drops an email-less contact that is not a text-only vendor", () => {
    expect(mergeInboxScopedContacts([vendor({ email: "" })])).toEqual([]);
  });

  it("fills a linked vendor's saved phone from the local roster copy when the server's list lacks it", () => {
    const fromApi = [vendor()];
    const local = [vendor({ phone: "(425) 555-0199" })];
    expect(mergeInboxScopedContacts(fromApi, local)).toEqual([expect.objectContaining({ id: "ven-1", phone: "(425) 555-0199" })]);
  });

  it("does not let a duplicate overwrite a phone the first copy already has", () => {
    const merged = mergeInboxScopedContacts([vendor({ phone: "+14255550199" })], [vendor({ phone: "+19999999999" })]);
    expect(merged[0]!.phone).toBe("+14255550199");
  });
});

describe("opening New message from a vendor's Text", () => {
  beforeEach(() => sessionStorage.clear());

  it("stages the vendor alone: no drafted subject or body is required", () => {
    stageManagerComposePrefill({ subject: "", body: "", vendorRecordId: "ven-1" });
    expect(consumeManagerComposePrefill()).toEqual({ subject: "", body: "", vendorRecordId: "ven-1" });
    expect(consumeManagerComposePrefill()).toBeNull();
  });

  it("a prefill with neither a vendor nor a drafted message is still ignored", () => {
    stageManagerComposePrefill({ subject: "", body: "" });
    expect(consumeManagerComposePrefill()).toBeNull();
  });
});

describe("the New message modal texts a vendor at its own phone", () => {
  it("resolves a vendor's text target from the vendor's saved phone, never a resident name match", () => {
    expect(modal).toMatch(/contact\.role === "vendor"[\s\S]{0,260}add\(contact\.phone, null, id\.replace\(\/\^ven-\/, ""\)\)/);
  });

  it("sends the roster id and the attestation with each vendor text", () => {
    expect(modal).toContain("vendorRecordId: target.vendorRecordId, attestVendorRelationship: attestVendor");
  });

  it("asks the server whether the first text still needs the attestation, and shows the box only then", () => {
    expect(modal).toContain("/api/manager/vendor-text-consent?vendorRecordId=");
    expect(modal).toMatch(/viaSms && attestationVendors\.length > 0/);
    expect(modal).toContain("I work with this vendor");
  });

  it("refuses to send the first text without the box ticked, and never schedules a vendor text", () => {
    expect(modal).toContain("Confirm you work with this vendor to send the first text.");
    expect(modal).toContain("A text to a vendor sends now.");
  });

  it("an opted-out vendor is refused before the request", () => {
    expect(modal).toContain("That number has opted out of texts.");
  });

  it("does not flag a roster vendor as 'This is a vendor' again", () => {
    expect(modal).toContain("markVendor && !target.residentUserId && !target.vendorRecordId");
  });
});

describe("the entry points", () => {
  it("the Vendors list row's ⋯ menu and the vendor record header carry Text, only with a phone and the SMS UI on", () => {
    expect(vendorsPanel).toContain('data-attr="vendor-row-text"');
    expect(vendorsPanel).toMatch(/smsUiEnabled && phone/);
    expect(vendorsPanel).toMatch(/smsUiEnabled && Boolean\(routeVendor\.phone\.trim\(\)\)/);
    expect(vendorsPanel).toContain('actionId === "text"');
  });
});

describe("the vendor's Communication", () => {
  const inboxPanel = readFileSync("src/components/portal/vendor-inbox-panel.tsx", "utf8");
  const communication = readFileSync("src/components/portal/vendor-communication.tsx", "utf8");
  const onboarding = readFileSync("src/components/portal/vendor-onboarding.tsx", "utf8");
  const settings = readFileSync("src/components/portal/vendor-settings-panel.tsx", "utf8");

  it("a text-only conversation replies by text to that manager's work number, and offers no archive/delete on a derived row", () => {
    expect(inboxPanel).toContain("activeThread.smsOnly");
    expect(inboxPanel).toContain("sms:${activeThread.counterparty.workPhone}");
    expect(inboxPanel).toContain("if (thread?.smsOnly) return undefined;");
  });

  it("linked texts live inside each manager's conversation row, so the standalone Text messages row is only a fallback", () => {
    expect(communication).toContain("body.conversations.length > 0");
  });

  it("verifying the phone is in Settings > Messaging and in vendor onboarding", () => {
    expect(settings).toContain('title="Verify your phone"');
    expect(onboarding).toContain("PortalTextNotificationsBlock");
    expect(onboarding).toContain('data-attr="vendor-onboarding-verify-phone"');
  });
});
