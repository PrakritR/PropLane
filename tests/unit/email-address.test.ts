import { describe, expect, it } from "vitest";
import { isLegitimateEmail } from "@/lib/email-address";

describe("isLegitimateEmail", () => {
  it("accepts normal addresses", () => {
    expect(isLegitimateEmail("user@gmail.com")).toBe(true);
    expect(isLegitimateEmail("a@b.co")).toBe(true);
    expect(isLegitimateEmail("user@mail.co.uk")).toBe(true);
  });

  it("rejects truncated or incomplete domains", () => {
    expect(isLegitimateEmail("jaarav071@gmail.c")).toBe(false);
    expect(isLegitimateEmail("user@domain.")).toBe(false);
    expect(isLegitimateEmail("user@domain")).toBe(false);
    expect(isLegitimateEmail("not-an-email")).toBe(false);
    expect(isLegitimateEmail("")).toBe(false);
  });
});
