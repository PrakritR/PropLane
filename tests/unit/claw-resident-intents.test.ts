import { describe, expect, it } from "vitest";
import { classifyResidentSmsIntent, residentHelpMenuText } from "@/lib/claw-resident-intents";
import {
  buildManagerResidentBrief,
  formatPendingChargesForSms,
} from "@/lib/claw-resident-actions.server";
import type { HouseholdCharge } from "@/lib/household-charges";

describe("classifyResidentSmsIntent", () => {
  it("maps toilet repair to maintenance / Services", () => {
    const c = classifyResidentSmsIntent("my toilet is broken can you fix");
    expect(c.intent).toBe("maintenance");
    expect(c.domain).toBe("Services");
    expect(c.managerPath).toContain("work-orders");
    expect(c.skipManagerBrief).toBe(false);
  });

  it("maps parking amenity language to service_request", () => {
    const c = classifyResidentSmsIntent("can I request reserved parking?");
    expect(c.intent).toBe("service_request");
    expect(c.managerPath).toContain("requests");
  });

  it("maps balance and pay asks", () => {
    expect(classifyResidentSmsIntent("how much do I owe?").intent).toBe("balance");
    expect(classifyResidentSmsIntent("I want to pay rent").intent).toBe("pay");
    expect(classifyResidentSmsIntent("rent").intent).toBe("pay");
  });

  it("maps maintenance keywords and repair language", () => {
    expect(classifyResidentSmsIntent("maintenance").intent).toBe("maintenance");
    expect(classifyResidentSmsIntent("work order").intent).toBe("maintenance");
    expect(classifyResidentSmsIntent("my toilet is broken can you fix").intent).toBe("maintenance");
  });

  it("maps 'I already paid' messages", () => {
    expect(classifyResidentSmsIntent("I just paid").intent).toBe("i_paid");
    expect(classifyResidentSmsIntent("we sent the rent over").intent).toBe("i_paid");
  });

  it("maps lease / applications / move-in", () => {
    expect(classifyResidentSmsIntent("where do I sign my lease?").intent).toBe("lease");
    expect(classifyResidentSmsIntent("application status?").intent).toBe("applications");
    expect(classifyResidentSmsIntent("when do I get my keys for move-in?").intent).toBe("move_in");
  });

  it("skips manager brief for help and greeting", () => {
    expect(classifyResidentSmsIntent("help").skipManagerBrief).toBe(true);
    expect(classifyResidentSmsIntent("hi").skipManagerBrief).toBe(true);
    const help = residentHelpMenuText();
    expect(help.toLowerCase()).toContain("text me");
    expect(help).not.toMatch(/PAY \/ BALANCE/);
    expect(help).not.toMatch(/PropLane resident menu/i);
  });

  it("falls back to inbox/unknown for freeform chat", () => {
    const c = classifyResidentSmsIntent("thanks for everything yesterday");
    expect(c.intent).toBe("unknown");
    expect(c.domain).toBe("Inbox");
    expect(c.skipManagerBrief).toBe(false);
  });
});

describe("buildManagerResidentBrief", () => {
  it("leads with Property, Resident, Said, and Reply; link only when auto-filed", () => {
    const brief = buildManagerResidentBrief({
      residentName: "Test Resident",
      residentEmail: "resident@test.proplane.local",
      residentPhone: "+15105794001",
      said: "my toilet is broken",
      wants: "file a maintenance work order",
      domain: "Services",
      managerPath: "/portal/services/work-orders",
      autoFiledNote: "PropLane auto-filed work order REQ-1 (Toilet issue).",
      propertyLabel: "The Pioneer",
      reply: "Got it — I filed a work order.",
    });
    expect(brief).toContain("Property: The Pioneer");
    expect(brief).toContain("Resident: Test Resident (+15105794001)");
    expect(brief).toContain("Said: my toilet is broken");
    expect(brief).toContain("Reply: Got it — I filed a work order.");
    expect(brief).toContain("REQ-1");
    expect(brief).toContain("/portal/services/work-orders");
    expect(brief).not.toContain("Wants:");
  });

  it("omits the portal link when nothing was auto-filed", () => {
    const brief = buildManagerResidentBrief({
      residentName: "Test Resident",
      residentEmail: null,
      residentPhone: "+15105794001",
      said: "Ok",
      wants: "manager attention / reply",
      domain: "Inbox",
      managerPath: "/portal/communication/inbox/unopened",
      propertyLabel: "The Pioneer",
      reply: "Got it — your property manager will see this.",
    });
    expect(brief).toBe(
      [
        "Property: The Pioneer",
        "Resident: Test Resident (+15105794001)",
        "Said: Ok",
        "Reply: Got it — your property manager will see this.",
      ].join("\n"),
    );
  });
});

describe("formatPendingChargesForSms", () => {
  it("lists charges and pay link", () => {
    const charges = [
      {
        id: "c1",
        title: "Rent — July",
        amountLabel: "$1,200.00",
        balanceLabel: "$1,200.00",
        dueDateLabel: "Jul 1",
        status: "pending",
      },
    ] as HouseholdCharge[];
    const text = formatPendingChargesForSms(charges);
    expect(text).toContain("Rent — July");
    expect(text).toContain("$1,200.00");
    expect(text).toContain("/resident/payments/pending");
  });

  it("handles empty list", () => {
    expect(formatPendingChargesForSms([])).toMatch(/caught up|nothing due/i);
  });
});
