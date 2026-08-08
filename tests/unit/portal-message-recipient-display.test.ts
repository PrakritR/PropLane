import { describe, expect, it } from "vitest";
import { portalMessageRecipientDisplay } from "@/components/portal/portal-message-compose-fields";

describe("portalMessageRecipientDisplay", () => {
  it("shows email and phone when both channels are selected", () => {
    expect(
      portalMessageRecipientDisplay({
        email: "guest@example.com",
        phone: "(555) 555-0100",
        viaEmail: true,
        viaSms: true,
      }),
    ).toBe("guest@example.com · (555) 555-0100");
  });

  it("omits phone when SMS is not selected", () => {
    expect(
      portalMessageRecipientDisplay({
        email: "guest@example.com",
        phone: "(555) 555-0100",
        viaEmail: true,
        viaSms: false,
      }),
    ).toBe("guest@example.com");
  });

  it("omits email when email is not selected", () => {
    expect(
      portalMessageRecipientDisplay({
        email: "guest@example.com",
        phone: "(555) 555-0100",
        viaEmail: false,
        viaSms: true,
      }),
    ).toBe("(555) 555-0100");
  });
});
