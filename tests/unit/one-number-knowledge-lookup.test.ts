import { describe, expect, it } from "vitest";
import { lookupPropertyKnowledgeResidentTool, lookupPropertyKnowledgeTool } from "@/lib/tools/domains/knowledge";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { knowledgeFakeDb, type Row } from "../helpers/knowledge-fake-db";

const WS_A = "ws-a";
const WS_B = "ws-b";
const NOW = "2026-10-01T00:00:00Z";

function entry(over: Row): Row {
  return {
    id: "e",
    workspace_id: WS_A,
    property_id: null,
    topic: "other",
    question: "",
    answer: "",
    status: "approved",
    source: "manual",
    audience: "residents",
    use_count: 0,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

const HOUSE_INFO = { wifi: { network: "Maple5259", password: "tea-kettle-42" }, trash: { day: "Tuesday" } };

function seed(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    portal_workspaces: [
      { id: WS_A, owner_user_id: "ownerA", is_default: true },
      { id: WS_B, owner_user_id: "ownerB", is_default: true },
    ],
    manager_property_records: [
      { id: "p1", manager_user_id: "ownerA", workspace_id: WS_A, property_data: { title: "5259 Brooklyn", listingSubmission: { houseInfo: HOUSE_INFO } }, row_data: {} },
      { id: "p2", manager_user_id: "ownerB", workspace_id: WS_B, property_data: { title: "9 Pine", listingSubmission: { houseInfo: { wifi: { password: "other-team-secret" } } } }, row_data: {} },
    ],
    property_knowledge_entries: [
      entry({ id: "a-trash", property_id: "p1", question: "What day is trash pickup?", answer: "Trash is picked up Tuesday morning." }),
      entry({ id: "a-pets", question: "Are pets allowed?", answer: "Small dogs under 30 lbs with a pet deposit.", audience: "all" }),
      entry({ id: "a-owner", property_id: "p1", question: "When should we call the owner?", answer: "Owner prefers calls after 6 PM.", audience: "team" }),
      entry({ id: "a-suggested", property_id: "p1", question: "Where is the spare key?", answer: "Under the blue pot.", status: "suggested" }),
      entry({ id: "a-rejected", question: "Can we smoke?", answer: "Yes anywhere.", status: "rejected" }),
      entry({ id: "b-trash", workspace_id: WS_B, property_id: "p2", question: "What day is trash pickup?", answer: "Trash is picked up Friday.", audience: "all" }),
    ],
    ...extra,
  };
}

const text = (value: unknown) => JSON.stringify(value);

/** What the lookup tools answer with. The tools return `unknown`, so the test names the fields it reads. */
type KnowledgeLookup = {
  found: boolean;
  answers: { answer: string }[];
  houseDetails: { house: string; section: string }[];
  mustEscalate: string | null;
  guidance?: string;
  note?: string;
};

function managerCtx(db: never, over: Partial<AgentContext> = {}): AgentContext {
  return {
    landlordId: "ownerA", userId: "ownerA", email: "", roles: ["manager"], isAdmin: false, db,
    workspace: { id: WS_A, name: "A", isDefault: true, narrowing: false, propertyIds: ["p1"] },
    ...over,
  } as AgentContext;
}

function prospectCtx(db: never, over: Partial<AgentContext> = {}): AgentContext {
  return {
    landlordId: "ownerA", userId: "ownerA", email: "", roles: ["leasing_sms_agent"], isAdmin: false, db,
    leasingScope: { sessionId: "s", prospectPhoneE164: "+12065550123", channel: "sms", workNumber: null, currentInboundText: "q" },
    ...over,
  } as AgentContext;
}

describe("lookup_property_knowledge: manager", () => {
  it("answers from this workspace's approved entries and house details, nothing else", async () => {
    const fake = knowledgeFakeDb(seed());
    const result = (await lookupPropertyKnowledgeTool.handler(managerCtx(fake.db), { question: "what day is trash?" })) as KnowledgeLookup;
    expect(result.found).toBe(true);
    expect(result.answers.map((a) => a.answer)).toEqual(["Trash is picked up Tuesday morning."]);
    expect(text(result)).not.toContain("Friday");
    expect(text(result)).not.toContain("Under the blue pot");
    expect(text(result)).not.toContain("Yes anywhere");
  });

  it("hears team-only and resident answers, and sees house details", async () => {
    const fake = knowledgeFakeDb(seed());
    const owner = (await lookupPropertyKnowledgeTool.handler(managerCtx(fake.db), { question: "when to call the owner" })) as KnowledgeLookup;
    expect(owner.answers[0].answer).toContain("after 6 PM");
    const wifi = (await lookupPropertyKnowledgeTool.handler(managerCtx(fake.db), { question: "wifi password at 5259" })) as KnowledgeLookup;
    expect(wifi.houseDetails[0]).toMatchObject({ house: "5259 Brooklyn", section: expect.stringMatching(/wi-?fi/i) });
    expect(text(wifi)).toContain("tea-kettle-42");
  });

  it("team A never sees team B's entries or house details, and B never sees A's", async () => {
    const fake = knowledgeFakeDb(seed());
    const asA = text(await lookupPropertyKnowledgeTool.handler(managerCtx(fake.db), { question: "trash wifi password pets owner" }));
    expect(asA).not.toContain("Friday");
    expect(asA).not.toContain("other-team-secret");
    const ctxB = managerCtx(fake.db, {
      landlordId: "ownerB", userId: "ownerB",
      workspace: { id: WS_B, name: "B", isDefault: true, narrowing: false, propertyIds: ["p2"] },
    });
    const asB = text(await lookupPropertyKnowledgeTool.handler(ctxB, { question: "trash wifi password pets owner Tuesday" }));
    expect(asB).toContain("Friday");
    expect(asB).toContain("other-team-secret");
    expect(asB).not.toContain("Tuesday morning");
    expect(asB).not.toContain("tea-kettle-42");
    expect(asB).not.toContain("after 6 PM");
  });

  it("a house id from outside the workspace is ignored, not trusted", async () => {
    const fake = knowledgeFakeDb(seed());
    const out = text(await lookupPropertyKnowledgeTool.handler(managerCtx(fake.db), { question: "trash", propertyId: "p2" }));
    expect(out).not.toContain("Friday");
  });

  it("a co-manager assigned only some houses sees only those houses' entries", async () => {
    const fake = knowledgeFakeDb(seed({
      property_knowledge_entries: [
        entry({ id: "h1", property_id: "p1", question: "trash day house one", answer: "Tuesday" }),
        entry({ id: "h3", property_id: "p3", question: "trash day house three", answer: "Thursday" }),
      ],
    }));
    const ctx = managerCtx(fake.db, {
      userId: "co", managerSmsAccess: { mode: "delegated", workNumberOwnerId: "ownerA", actorUserId: "co", dataOwnerIds: ["ownerA"], assignedPropertyIds: ["p1"] } as never,
      workspace: { id: WS_A, name: "A", isDefault: true, narrowing: true, propertyIds: ["p1"] },
    });
    const out = text(await lookupPropertyKnowledgeTool.handler(ctx, { question: "trash day" }));
    expect(out).toContain("Tuesday");
    expect(out).not.toContain("Thursday");
  });

  it("an unresolved workspace reads nothing", async () => {
    const fake = knowledgeFakeDb(seed());
    const ctx = managerCtx(fake.db, { workspace: { id: "", name: "", isDefault: false, narrowing: true, propertyIds: [] } });
    const out = (await lookupPropertyKnowledgeTool.handler(ctx, { question: "trash" })) as KnowledgeLookup;
    expect(out.found).toBe(false);
    expect(out.answers).toEqual([]);
  });

  it("counts a use, and flags always-escalate topics", async () => {
    const fake = knowledgeFakeDb(seed());
    await lookupPropertyKnowledgeTool.handler(managerCtx(fake.db), { question: "what day is trash?" });
    expect(fake.rows.property_knowledge_entries!.find((e) => e.id === "a-trash")!.use_count).toBe(1);
    const refund = (await lookupPropertyKnowledgeTool.handler(managerCtx(fake.db), { question: "tenant wants a refund" })) as KnowledgeLookup;
    expect(refund.mustEscalate).toBe("money");
    expect(refund.guidance).toMatch(/team/);
  });

  it("says nothing is on file instead of guessing", async () => {
    const fake = knowledgeFakeDb(seed());
    const out = (await lookupPropertyKnowledgeTool.handler(managerCtx(fake.db), { question: "kayak storage" })) as KnowledgeLookup;
    expect(out.found).toBe(false);
    expect(out.guidance).toContain("Let me check with the team");
  });

  it("reads as empty when the tables do not exist yet", async () => {
    const fake = knowledgeFakeDb(seed(), { broken: ["property_knowledge_entries"] });
    const out = (await lookupPropertyKnowledgeTool.handler(managerCtx(fake.db), { question: "trash" })) as KnowledgeLookup;
    expect(out.answers).toEqual([]);
  });
});

describe("lookup_property_knowledge: prospect", () => {
  it("hears only entries marked for everyone and never house details", async () => {
    const fake = knowledgeFakeDb(seed());
    const out = text(await lookupPropertyKnowledgeTool.handler(prospectCtx(fake.db), { question: "are pets allowed, trash day, wifi password", propertyId: "p1" }));
    expect(out).toContain("Small dogs");
    expect(out).not.toContain("Tuesday");
    expect(out).not.toContain("tea-kettle-42");
    expect(out).not.toContain("after 6 PM");
    expect(out).not.toContain("Friday");
  });

  it("ignores a house that belongs to another team", async () => {
    const fake = knowledgeFakeDb(seed());
    const out = text(await lookupPropertyKnowledgeTool.handler(prospectCtx(fake.db), { question: "trash pickup", propertyId: "p2" }));
    expect(out).not.toContain("Friday");
  });

  it("reads nothing on the shared catalog line, which fronts every manager", async () => {
    const fake = knowledgeFakeDb(seed());
    const ctx = prospectCtx(fake.db, { leasingScope: { sessionId: "s", prospectPhoneE164: "+1", channel: "sms", workNumber: null, currentInboundText: "q", crossCatalog: true } as never });
    const out = (await lookupPropertyKnowledgeTool.handler(ctx, { question: "pets" })) as KnowledgeLookup;
    expect(out.found).toBe(false);
  });

  it("asks which house when the owner runs several workspaces and none is named", async () => {
    const fake = knowledgeFakeDb(seed({
      portal_workspaces: [
        { id: WS_A, owner_user_id: "ownerA", is_default: true },
        { id: "ws-a2", owner_user_id: "ownerA", is_default: false },
      ],
    }));
    const out = (await lookupPropertyKnowledgeTool.handler(prospectCtx(fake.db), { question: "pets" })) as KnowledgeLookup;
    expect(out.found).toBe(false);
    expect(out.note).toMatch(/which house/i);
  });
});

describe("lookup_property_knowledge: vendor", () => {
  it("hears only entries marked for everyone about the job's own house", async () => {
    const fake = knowledgeFakeDb(seed({
      portal_work_order_records: [{ id: "wo1", manager_user_id: "ownerA", row_data: { propertyId: "p1" } }],
      property_knowledge_entries: [
        entry({ id: "v-all", property_id: "p1", question: "Where does the dumpster go?", answer: "Behind the garage.", audience: "all" }),
        entry({ id: "v-res", property_id: "p1", question: "Where does the dumpster key go?", answer: "Resident-only dumpster note.", audience: "residents" }),
        entry({ id: "v-other", property_id: "p9", question: "Where does the dumpster go elsewhere?", answer: "Other house.", audience: "all" }),
      ],
    }));
    const ctx = { landlordId: "ownerA", userId: "v", email: "", roles: ["vendor_agent"], isAdmin: false, db: fake.db, vendorScope: { sessionId: "s", vendorDirectoryId: "vd", vendorUserId: "v", workOrderId: "wo1" } } as AgentContext;
    const out = text(await lookupPropertyKnowledgeTool.handler(ctx, { question: "where does the dumpster go" }));
    expect(out).toContain("Behind the garage");
    expect(out).not.toContain("Resident-only");
    expect(out).not.toContain("Other house");
  });
});

describe("lookup_property_knowledge: resident", () => {
  function residentCtx(db: never, over: Partial<ResidentAgentContext> = {}): ResidentAgentContext {
    return {
      kind: "resident", userId: "r1", email: "r@example.com", managerIds: ["ownerA"], activeManagerId: "ownerA", channel: "sms",
      phase: "approved", managerTier: "pro", moveInDetailsLocked: false, landlordId: "r1", db, ...over,
    } as ResidentAgentContext;
  }
  const lease = {
    portal_lease_pipeline_records: [{ manager_user_id: "ownerA", resident_email: "r@example.com", row_data: { propertyId: "p1", status: "Active" } }],
    // The check-in reveal reads the resident's tenancy row: an approved resident with no move-in date on file is already in.
    manager_application_records: [{ id: "app-r", manager_user_id: "ownerA", resident_email: "r@example.com", row_data: { bucket: "approved", stage: "Approved", name: "R", propertyId: "p1", assignedPropertyId: "p1" } }],
  };

  it("hears residents' answers and the house's details once move-in is unlocked", async () => {
    const fake = knowledgeFakeDb(seed(lease));
    const out = text(await lookupPropertyKnowledgeResidentTool.handler(residentCtx(fake.db), { question: "wifi password and trash day" }));
    expect(out).toContain("Tuesday");
    expect(out).toContain("tea-kettle-42");
    expect(out).not.toContain("after 6 PM");
    expect(out).not.toContain("Friday");
  });

  it("before the check-in reveal the codes wait; the rest of the house brief still answers", async () => {
    // Move-in is months out, so `checkInReveal` is closed - the same split `get_move_in_info` makes:
    // the Wi-Fi password and the codes are withheld, the network name and trash day are not.
    const fake = knowledgeFakeDb(seed({
      ...lease,
      manager_application_records: [
        {
          id: "app-r",
          manager_user_id: "ownerA",
          resident_email: "r@example.com",
          row_data: {
            bucket: "approved",
            stage: "Approved",
            name: "R",
            propertyId: "p1",
            assignedPropertyId: "p1",
            manualResidentDetails: { moveInDate: "2099-06-01" },
          },
        },
      ],
    }));
    const out = (await lookupPropertyKnowledgeResidentTool.handler(residentCtx(fake.db), {
      question: "wifi password and trash day",
    })) as KnowledgeLookup;
    expect(text(out)).not.toContain("tea-kettle-42");
    expect(out.houseDetails.map((hit) => hit.section)).toContain("Trash & cleaning");
  });

  it("withholds house details while the move-in lock holds, but still answers approved entries", async () => {
    const fake = knowledgeFakeDb(seed(lease));
    const out = text(await lookupPropertyKnowledgeResidentTool.handler(residentCtx(fake.db, { moveInDetailsLocked: true }), { question: "wifi password and trash day" }));
    expect(out).not.toContain("tea-kettle-42");
    expect(out).toContain("Tuesday");
  });

  it("an applicant hears only entries marked for everyone and no house details", async () => {
    const fake = knowledgeFakeDb(seed(lease));
    const out = text(await lookupPropertyKnowledgeResidentTool.handler(residentCtx(fake.db, { phase: "application" }), { question: "wifi password trash pets" }));
    expect(out).toContain("Small dogs");
    expect(out).not.toContain("tea-kettle-42");
    expect(out).not.toContain("Tuesday");
  });

  it("a portal resident with several managers gets no team's knowledge", async () => {
    const fake = knowledgeFakeDb(seed(lease));
    const out = (await lookupPropertyKnowledgeResidentTool.handler(residentCtx(fake.db, { activeManagerId: undefined, managerIds: ["ownerA", "ownerB"] }), { question: "trash" })) as KnowledgeLookup;
    expect(out.found).toBe(false);
  });
});
