import { describe, expect, it } from "vitest";
import {
  formatTourContactPhoneDisplay,
  normalizeTourContactPhone,
  validateTourContactFields,
} from "@/lib/tour-contact-quality";

describe("validateTourContactFields", () => {
  it("requires name, email, and a 10-digit phone", () => {
    expect(validateTourContactFields({ name: "", email: "", phone: "" })).toEqual({
      name: "Name is required.",
      email: "Email is required.",
      phone: "Phone number must be 10 digits.",
    });
  });

  it("accepts E.164 storage values", () => {
    expect(
      validateTourContactFields({
        name: "Lucas",
        email: "lucas@example.com",
        phone: "+12065550100",
      }),
    ).toEqual({});
  });

  it("accepts formatted US numbers", () => {
    expect(
      validateTourContactFields({
        name: "Lucas",
        email: "lucas@example.com",
        phone: "(206) 555-0100",
      }),
    ).toEqual({});
  });

  it("rejects invalid email and short phone", () => {
    expect(
      validateTourContactFields({
        name: "Lucas",
        email: "not-an-email",
        phone: "123",
      }),
    ).toEqual({
      email: "Enter a valid email address (for example name@gmail.com).",
      phone: "Phone number must be 10 digits.",
    });
  });
});

describe("normalizeTourContactPhone", () => {
  it("normalizes a 10-digit US number to E.164", () => {
    expect(normalizeTourContactPhone("(206) 555-0100")).toBe("+12065550100");
  });

  it("returns null for unusable input", () => {
    expect(normalizeTourContactPhone("123")).toBeNull();
  });
});

describe("formatTourContactPhoneDisplay", () => {
  it("formats E.164 storage values for manager display", () => {
    expect(formatTourContactPhoneDisplay("+12065550100")).toBe("(206) 555-0100");
  });
});
