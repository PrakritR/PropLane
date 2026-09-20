import { describe, expect, it } from "vitest";
import { isPrimaryAdminEmail, PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";

describe("primary admin email", () => {
  it("is the Axis Seattle founder mailbox", () => {
    expect(PRIMARY_ADMIN_EMAIL).toBe("founders@axis-seattle-housing.com");
  });

  it("does not treat Prakrit's personal Gmail as admin", () => {
    expect(isPrimaryAdminEmail("prakritramachandran@gmail.com")).toBe(false);
    expect(isPrimaryAdminEmail("PrakritRamachandran@gmail.com")).toBe(false);
  });

  it("matches the founder address case-insensitively", () => {
    expect(isPrimaryAdminEmail("founders@axis-seattle-housing.com")).toBe(true);
    expect(isPrimaryAdminEmail("Founders@Axis-Seattle-Housing.com")).toBe(true);
  });
});
