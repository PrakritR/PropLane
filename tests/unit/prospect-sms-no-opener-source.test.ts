import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildTourCanceledTenantBody,
  buildTourConfirmedTenantBody,
  buildTourNotificationContext,
  buildTourRequestManagerSms,
  buildTourRequestRemovedTenantBody,
  buildTourRequestTenantBody,
} from "@/lib/tour-notifications";

describe("prospect-facing SMS sources carry no PropLane opener and no STOP footer", () => {
  it("sms-relay direct-line intro", () => {
    const src = readFileSync("src/lib/sms-relay.server.ts", "utf8");
    const intro = src.slice(src.indexOf('"intro_counterparty",\n'), src.indexOf('"intro_manager",\n'));
    expect(intro).toContain("direct line");
    expect(intro).not.toMatch(/PropLane:|Reply STOP|HELP for help/);
  });

  // docs/agents/sms-system.md: a prospect hears from the home, not from the platform — the "PropLane:" opener and the
  // STOP/HELP footer belong to PropLane's own alert to the manager. Wrong behaviour this rejects: a guest notice that
  // opens "PropLane:" or carries a compliance footer meant for the staff alert.
  it("the tour texts: the manager's alert opens with PropLane, the guest's copy never does", () => {
    const ctx = buildTourNotificationContext({
      origin: "https://proplane.ai",
      guestName: "QA Test Prospect",
      guestEmail: "qa@example.com",
      propertyId: "prop-5257",
      propertyTitle: "5257 Brooklyn",
      tourStartIso: "2026-11-21T22:00:00.000Z",
      tourEndIso: "2026-11-21T22:30:00.000Z",
      tourInquiryId: "inq-1",
    });
    const managerAlert = buildTourRequestManagerSms(ctx);
    expect(managerAlert.startsWith("PropLane: ")).toBe(true);
    expect(managerAlert).not.toMatch(/Reply STOP|HELP for help/);
    for (const guestCopy of [
      buildTourRequestTenantBody(ctx),
      buildTourConfirmedTenantBody(ctx),
      buildTourCanceledTenantBody(ctx, "The host is away"),
      buildTourRequestRemovedTenantBody(ctx),
    ]) {
      expect(guestCopy.startsWith("PropLane:")).toBe(false);
      expect(guestCopy).not.toMatch(/PropLane: |Reply STOP|HELP for help/);
    }
  });
});
