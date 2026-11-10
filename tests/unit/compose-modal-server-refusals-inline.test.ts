import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { smsRefusalMessage } from "@/components/portal/pro-communication-compose-modal";

const SOURCE = readFileSync("src/components/portal/pro-communication-compose-modal.tsx", "utf8");
const submit = () => {
  const start = SOURCE.indexOf("const submit = async () => {");
  return SOURCE.slice(start, SOURCE.indexOf("const submitScoped", start) > 0 ? SOURCE.indexOf("const submitScoped", start) : start + 12000);
};

describe("New message: a server refusal shows inside the dialog", () => {
  it("no send outcome is toast-only any more: refusals go through fail()", () => {
    const body = submit();
    expect(body).not.toMatch(/showToast\(lastError\)/);
    expect(body).not.toContain('showToast("Some messages could not be scheduled.")');
    expect(body).toContain("fail(lastError);");
  });

  it("the opted-in refusal names the number and the workspace when known, else keeps the server text", () => {
    const server = "Choose a resident or applicant who has opted in to PropLane texts.";
    expect(smsRefusalMessage(server, "+12065550100", "Ambika Homes")).toBe("Not sent. +12065550100 hasn't opted in to texts from Ambika Homes.");
    expect(smsRefusalMessage(server, "+12065550100", null)).toBe(server);
    expect(smsRefusalMessage("Daily limit reached.", "+12065550100", "Ambika Homes")).toBe("Daily limit reached.");
    expect(smsRefusalMessage(undefined, "+12065550100", "Ambika Homes")).toBeNull();
  });

  it("the form resets only when the modal opens or a draft with new content arrives, and Subject is required for email alone", () => {
    expect(SOURCE).toContain("const justOpened = open && !wasOpenRef.current;");
    expect(SOURCE).toContain("const draftKey = draft ? JSON.stringify(draft) : null;");
    expect(SOURCE).toContain("if (!justOpened && !draftArrived) return;");
    const body = submit();
    expect(body).toContain("if (viaEmail && !s) {");
    // An SMS-only send never reaches the subject check.
    expect(body.indexOf("if (viaPortalDelivery) {")).toBeLessThan(body.indexOf("if (viaEmail && !s) {"));
  });
});
