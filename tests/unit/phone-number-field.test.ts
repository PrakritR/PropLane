import { describe, expect, it } from "vitest";
import {
  composePhoneE164,
  DEFAULT_PHONE_COUNTRY_ISO,
  formatNationalPhoneDigits,
  isCompletePhoneNumber,
  parsePhoneFieldValue,
} from "@/lib/phone-number-field";
import { coercePhoneInput, normalizeE164 } from "@/lib/phone-e164";

describe("phone number field model", () => {
  it("defaults empty values to the US +1 country", () => {
    expect(parsePhoneFieldValue("")).toEqual({
      iso: DEFAULT_PHONE_COUNTRY_ISO,
      nationalDigits: "",
    });
    expect(parsePhoneFieldValue(null)).toEqual({
      iso: DEFAULT_PHONE_COUNTRY_ISO,
      nationalDigits: "",
    });
  });

  it("reads a JSON number the way Communication used to crash on", () => {
    expect(coercePhoneInput(18559168031)).toBe("18559168031");
    expect(parsePhoneFieldValue(18559168031)).toEqual({
      iso: "US",
      nationalDigits: "8559168031",
    });
    expect(normalizeE164(18559168031)).toBe("+18559168031");
    expect(composePhoneE164("US", "8559168031")).toBe("+18559168031");
  });

  it("auto-formats the US national number", () => {
    expect(formatNationalPhoneDigits("206", "US")).toBe("206");
    expect(formatNationalPhoneDigits("206555", "US")).toBe("(206) 555");
    expect(formatNationalPhoneDigits("2065550123", "US")).toBe("(206) 555-0123");
  });

  it("composes E.164 from the selected country, always as a string", () => {
    expect(composePhoneE164("US", "2065550123")).toBe("+12065550123");
    expect(composePhoneE164("GB", "2079460958")).toBe("+442079460958");
    expect(typeof composePhoneE164("US", "206")).toBe("string");
  });

  it("rejects mid-entry +1 numbers as incomplete", () => {
    expect(isCompletePhoneNumber("+1206555")).toBe(false);
    expect(isCompletePhoneNumber("+12065550123")).toBe(true);
    expect(isCompletePhoneNumber("+44207946")).toBe(false);
    expect(isCompletePhoneNumber("+442079460958")).toBe(true);
  });
});
