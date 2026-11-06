import { describe, expect, it } from "vitest";
import { lookupPropertyKnowledgeResidentTool, lookupPropertyKnowledgeTool } from "@/lib/tools/domains/knowledge";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { knowledgeFakeDb } from "../helpers/knowledge-fake-db";

const HOUSE_INFO = {
  access: { doorCode: "DOORCODE-7391", gateCode: "GATECODE-5520", parking: "Street" },
  wifi: { network: "Maple5259", password: "WIFIPW-tea-kettle" },
  safety: { alarm: "ALARM-1188" },
  trash: { day: "Tuesday", recycling: "Wednesday" },
  rules: { escalateAfter: "3" },
};
const SECRETS = ["DOORCODE-7391", "GATECODE-5520", "WIFIPW-tea-kettle", "ALARM-1188"];

const seed = () => ({
  portal_workspaces: [{ id: "ws", owner_user_id: "owner", is_default: true }],
  manager_property_records: [
    { id: "p1", manager_user_id: "owner", workspace_id: "ws", property_data: { title: "5259 Brooklyn", listingSubmission: { houseInfo: HOUSE_INFO } }, row_data: {} },
  ],
  property_knowledge_entries: [],
  portal_work_order_records: [{ id: "wo1", manager_user_id: "owner", row_data: { propertyId: "p1" } }],
  portal_lease_pipeline_records: [{ manager_user_id: "owner", resident_email: "r@example.com", resident_user_id: "r1", row_data: { propertyId: "p1", status: "Active" } }],
  // The check-in reveal reads the resident's tenancy row: an approved resident with no move-in date on file is already in.
  manager_application_records: [{ id: "app-r", manager_user_id: "owner", resident_email: "r@example.com", row_data: { residentUserId: "r1", bucket: "approved", stage: "Approved", name: "R", propertyId: "p1", assignedPropertyId: "p1" } }],
});

const question = "what is the door code, gate code, wifi password, alarm code and trash day";

describe("door code, gate code, Wi-Fi password and alarm reach only a verified resident", () => {
  it("never reach a prospect", async () => {
    const fake = knowledgeFakeDb(seed());
    const ctx = {
      landlordId: "owner", userId: "owner", email: "", roles: ["leasing_sms_agent"], isAdmin: false, db: fake.db,
      leasingScope: { sessionId: "s", prospectPhoneE164: "+12065550123", channel: "sms", workNumber: null, currentInboundText: "q" },
    } as unknown as AgentContext;
    const out = JSON.stringify(await lookupPropertyKnowledgeTool.handler(ctx, { question, propertyId: "p1" }));
    for (const secret of SECRETS) expect(out).not.toContain(secret);
  });

  it("never reach a vendor, hired or not", async () => {
    const fake = knowledgeFakeDb(seed());
    const ctx = {
      landlordId: "owner", userId: "v", email: "", roles: ["vendor_agent"], isAdmin: false, db: fake.db,
      vendorScope: { sessionId: "s", vendorDirectoryId: "vd", vendorUserId: "v", workOrderId: "wo1" },
    } as unknown as AgentContext;
    const out = JSON.stringify(await lookupPropertyKnowledgeTool.handler(ctx, { question }));
    for (const secret of SECRETS) expect(out).not.toContain(secret);
  });

  it("are withheld from a resident whose move-in details are still locked", async () => {
    const fake = knowledgeFakeDb(seed());
    const ctx = {
      kind: "resident", userId: "r1", email: "r@example.com", managerIds: ["owner"], activeManagerId: "owner", channel: "sms",
      phase: "approved", managerTier: "pro", moveInDetailsLocked: true, landlordId: "r1", db: fake.db,
    } as unknown as ResidentAgentContext;
    const out = JSON.stringify(await lookupPropertyKnowledgeResidentTool.handler(ctx, { question }));
    for (const secret of SECRETS) expect(out).not.toContain(secret);
  });

  it("reach an unlocked resident, but never the manager's complaint threshold", async () => {
    const fake = knowledgeFakeDb(seed());
    const ctx = {
      kind: "resident", userId: "r1", email: "r@example.com", managerIds: ["owner"], activeManagerId: "owner", channel: "sms",
      phase: "approved", managerTier: "pro", moveInDetailsLocked: false, landlordId: "r1", db: fake.db,
    } as unknown as ResidentAgentContext;
    const out = JSON.stringify(await lookupPropertyKnowledgeResidentTool.handler(ctx, { question }));
    expect(out).toContain("WIFIPW-tea-kettle");
    expect(out).not.toMatch(/escalateAfter|complaints in 30 days/i);
  });
});
