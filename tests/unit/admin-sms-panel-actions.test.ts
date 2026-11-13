/**
 * The admin Communication thread mounts the manager SMS panel on `/api/admin/sms-conversations`. Manager-scoped
 * writes (contact rename, email "as Property manager", scheduling) are not offered there, and a failed open keeps
 * the row and says "Conversation not found." in place.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("src/components/portal/pro-sms-panel.tsx", "utf8");
const unified = readFileSync("src/components/portal/pro-unified-inbox.tsx", "utf8");

describe("admin SMS thread panel", () => {
  it("recognises the admin endpoint", () => {
    expect(panel).toContain('const isAdminEndpoint = endpoint.startsWith("/api/admin/");');
  });
  it("hides contact rename, email send and scheduling on the admin endpoint", () => {
    expect(panel).toMatch(/const canEditContact = !isAdminEndpoint &&/);
    expect(panel).toMatch(/const activeEmailAvailable = !isAdminEndpoint &&/);
    expect(panel).toMatch(/const activeCanSchedule = !isAdminEndpoint &&/);
    expect(panel).toContain("if (replyViaEmail && !isAdminEndpoint) {");
  });
  it("never drops the row or closes the thread on an admin 403/404", () => {
    expect(panel).toMatch(/if \(!isAdminEndpoint && \(response\.status === 403 \|\| response\.status === 404\)/);
    expect(panel).toContain('response.status === 404 ? "Conversation not found."');
  });
  it("every other manager-scoped fetch in the panel is gated or goes through the oversight client", () => {
    const managerFetches = [...panel.matchAll(/fetch\(\s*"(\/api\/(?:manager|portal)\/[^"]+)"/g)].map((m) => m[1]);
    expect(managerFetches.sort()).toEqual([
      "/api/manager/sms-contacts",
      "/api/manager/sms-contacts",
      "/api/portal/scheduled-inbox-messages",
      "/api/portal/send-inbox-message",
    ]);
  });
});

describe("admin list row place line", () => {
  it("shows the house when the thread names one, else the workspace, else Unassigned", () => {
    expect(unified).toMatch(/resident\.propertyLabel\?\.trim\(\) \|\|\s+resident\.houses\?\.\[0\]\?\.label\?\.trim\(\) \|\|\s+resident\.workspaceName\?\.trim\(\) \|\|\s+ADMIN_UNASSIGNED_WORKSPACE_LABEL/);
  });
});

describe("staff scope gap", () => {
  it("every projection reader pre-filters owners through communicationCandidateOwnerIds, never scope.ownerIds", () => {
    const src = readFileSync("src/lib/sms/sms-projection-inbox.server.ts", "utf8");
    expect(src).not.toMatch(/scope\.ownerIds/);
    expect(src.match(/communicationCandidateOwnerIds\(scope\)/g)?.length).toBe(4);
  });
});
