import { describe, expect, it } from "vitest";
import { assertVerifiedSignupControl, residentApplicationDestination } from "../helpers/signup-ui-contract";

const origin = "http://localhost:3000";
const propertyId = "11111111-1111-4111-8111-111111111111";
const application = `/resident/applications/apply?propertyId=${propertyId}&listingRoomId=room-1`;
const gate = (next: string) => `${origin}/auth/verify-phone?next=${encodeURIComponent(next)}`;

describe("observed signup UI identity", () => {
  it("requires the actual readonly input and exact mailbox, without leaking either mailbox", () => {
    const control = { isInput: true, readOnly: true, value: "owned@example.invalid" };
    expect(() => assertVerifiedSignupControl(control, control.value)).not.toThrow();
    for (const invalid of [{ ...control, isInput: false }, { ...control, readOnly: false }, { ...control, value: "foreign@example.invalid" }]) {
      expect(() => assertVerifiedSignupControl(invalid, control.value)).toThrow("Verified email control did not match the synthetic mailbox.");
    }
  });
  it("carries the resident listing and room through the actual phone gate", () => {
    expect(residentApplicationDestination(gate(application), origin, propertyId)).toBe(application);
  });
  it.each([
    `${origin}/portal`, `${origin}/auth/create-account`,
    gate("/resident/applications"), gate("/portal/dashboard"),
    gate("https://foreign.invalid/resident/applications/apply?propertyId=" + propertyId),
    gate(application.replace(propertyId, "foreign")),
    gate(application + "&propertyId=foreign"),
    gate(application).replace(origin, "https://foreign.invalid"),
  ])("refuses a manager continuation or changed resident destination %#", (url) => {
    expect(() => residentApplicationDestination(url, origin, propertyId)).toThrow();
  });
});
