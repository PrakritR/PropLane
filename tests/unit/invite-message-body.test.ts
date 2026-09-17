import { describe, expect, it } from "vitest";
import { formatInviteMessageBody, formatInviteMessageSubject } from "@/lib/invite-message-body";

describe("formatInviteMessageBody", () => {
  it("includes every collected workspace fact", () => {
    const body = formatInviteMessageBody({
      kind: "workspace",
      inviterName: "Ambika",
      workspaceName: "Seattle houses",
      propertyLabels: ["5257 Brooklyn", "5259 Brooklyn"],
      inviteUrl: "https://example.test/invite/tok",
      proplaneCode: "PROPLANE-1A2B",
      phone: "+12065551212",
      email: "join@example.test",
    });
    expect(body).toContain("Ambika invited you to Seattle houses on PropLane.");
    expect(body).toContain("Houses: 5257 Brooklyn, 5259 Brooklyn");
    expect(body).toContain("PropLane ID: PROPLANE-1A2B");
    expect(body).toContain("Phone: +12065551212");
    expect(body).toContain("Email: join@example.test");
    expect(body).toContain("Join: https://example.test/invite/tok");
  });

  it("says no houses yet when the workspace has none", () => {
    const body = formatInviteMessageBody({
      kind: "workspace",
      inviterName: "Ambika",
      workspaceName: "Empty",
      propertyLabels: [],
    });
    expect(body).toContain("Houses: no houses yet");
  });

  it("includes every collected vendor fact", () => {
    const body = formatInviteMessageBody({
      kind: "vendor",
      inviterName: "Ambika",
      vendorName: "Apex Plumbing",
      trade: "Plumbing",
      phone: "+12065550000",
      inviteUrl: "https://example.test/invite/vendor",
    });
    expect(body).toContain("Ambika invited Apex Plumbing to join the vendor directory on PropLane.");
    expect(body).toContain("Trade: Plumbing");
    expect(body).toContain("Phone: +12065550000");
    expect(body).toContain("Join: https://example.test/invite/vendor");
  });
});

describe("formatInviteMessageSubject", () => {
  it("names the workspace", () => {
    expect(formatInviteMessageSubject({ kind: "workspace", inviterName: "Ambika", workspaceName: "North" })).toBe(
      "Ambika invited you to North",
    );
  });
});
