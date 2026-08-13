import { describe, expect, it } from "vitest";
import {
  isDigitsOnlyLabel,
  isValidZipInput,
  parseSanitizedMoneyNumber,
  sanitizeMoneyInput,
  sanitizeCityInput,
  sanitizeNeighborhoodInput,
  sanitizePlaceNameInput,
  sanitizeStateInput,
  sanitizeZipInput,
} from "@/lib/listing-form-inputs";

describe("listing-form-inputs", () => {
  it("strips letters from money input", () => {
    expect(sanitizeMoneyInput("12ab3.4x5")).toBe("123.45");
    expect(sanitizeMoneyInput("$1,200")).toBe("1200");
  });

  it("parses sanitized money", () => {
    expect(parseSanitizedMoneyNumber("850")).toBe(850);
    expect(parseSanitizedMoneyNumber("")).toBe(0);
  });

  it("formats zip codes", () => {
    expect(sanitizeZipInput("9810a3")).toBe("98103");
    expect(sanitizeZipInput("981031234")).toBe("98103-1234");
    expect(isValidZipInput("98103")).toBe(true);
    expect(isValidZipInput("98103-1234")).toBe(true);
    expect(isValidZipInput("981")).toBe(false);
  });

  it("uppercases and caps state abbreviations", () => {
    expect(sanitizeStateInput("wa")).toBe("WA");
    expect(sanitizeStateInput("washington")).toBe("WA");
  });

  it("blocks digits in city names", () => {
    expect(sanitizeCityInput("Seattle 981")).toBe("Seattle ");
  });

  it("blocks digits in neighborhood names", () => {
    expect(sanitizeNeighborhoodInput("Capitol Hill 123")).toBe("Capitol Hill ");
  });

  it("allows room-style names with numbers", () => {
    expect(sanitizePlaceNameInput("Room 12A")).toBe("Room 12A");
    expect(isDigitsOnlyLabel("123")).toBe(true);
    expect(isDigitsOnlyLabel("Room 12A")).toBe(false);
  });
});
