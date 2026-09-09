import { describe, expect, it } from "vitest";
import {
  appendResidentPropertyManagerInboxMessage,
  appendManagerPropertyLeadInboxMessage,
  deliverResidentPropertyManagerChatMessage,
  propertyManagerConversationThreadId,
  propertyManagerConversationSideThreadId,
  propertyManagerSendMessageIds,
  propertyManagerThreadLabel,
} from "@/lib/property-manager-inbox-thread.server";

type InboxRow = {
  id: string;
  scope: string;
  owner_user_id: string | null;
  participant_email: string | null;
  thread_type: string;
  row_data: Record<string, unknown>;
  updated_at?: string;
};

function globalPrimaryKeyDb(
  seed: InboxRow[] = [],
  beforeInsert?: (row: InboxRow, rows: Map<string, InboxRow>) => { code: string; message: string } | void,
) {
  const rows = new Map(seed.map((row) => [row.id, structuredClone(row)]));
  const from = (table: string) => {
    if (table === "profiles") {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: { id: "resident-user" }, error: null }),
      };
      return query;
    }
    if (table !== "portal_inbox_thread_records") throw new Error(`unexpected table ${table}`);
    const filters: Array<[string, unknown]> = [];
    const matched = () => [...rows.values()].filter((row) =>
      filters.every(([column, value]) => {
        const actual = column === "row_data->>email"
          ? row.row_data.email
          : (row as unknown as Record<string, unknown>)[column];
        return actual === value;
      }),
    );
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      },
      order: () => query,
      limit: async (count: number) => ({ data: matched().slice(0, count), error: null }),
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      upsert: async (row: InboxRow) => {
        rows.set(row.id, structuredClone(row));
        return { error: null };
      },
      insert: async (row: InboxRow) => {
        const injectedError = beforeInsert?.(row, rows);
        if (injectedError) return { error: injectedError };
        if (rows.has(row.id)) return { error: { code: "23505", message: "duplicate key" } };
        rows.set(row.id, structuredClone(row));
        return { error: null };
      },
    };
    return query;
  };
  return { db: { from }, rows };
}

describe("propertyManagerConversationThreadId", () => {
  it("is stable for the same resident, manager, and property", () => {
    const input = {
      residentEmail: "guest@example.com",
      managerUserId: "mgr-1",
      propertyId: "prop-oak",
    };
    expect(propertyManagerConversationThreadId(input)).toBe(propertyManagerConversationThreadId(input));
  });

  it("differs when the property changes", () => {
    const base = {
      residentEmail: "guest@example.com",
      managerUserId: "mgr-1",
    };
    expect(propertyManagerConversationThreadId({ ...base, propertyId: "prop-a" })).not.toBe(
      propertyManagerConversationThreadId({ ...base, propertyId: "prop-b" }),
    );
  });

  it("uses distinct global primary keys for the resident and manager views", () => {
    const input = { residentEmail: "guest@example.com", managerUserId: "mgr-1", propertyId: "prop-a" };
    expect(propertyManagerConversationSideThreadId(input, "resident")).not.toBe(
      propertyManagerConversationSideThreadId(input, "manager"),
    );
  });

  it("normalizes email case when deriving the stable identity", () => {
    const base = { managerUserId: "mgr-1", propertyId: "prop-a" };
    expect(propertyManagerConversationThreadId({ ...base, residentEmail: "Guest@Example.COM" })).toBe(
      propertyManagerConversationThreadId({ ...base, residentEmail: "guest@example.com" }),
    );
  });
});

describe("canonical resident-manager thread writes", () => {
  const input = {
    residentEmail: "resident@example.com",
    residentUserId: "resident-user",
    residentName: "Veenu Jain",
    managerUserId: "manager-user",
    managerEmail: "ogambik2@gmail.com",
    propertyId: "property-a",
    propertyTitle: "Pine House",
    subject: "Thanks",
    message: "Thank you.",
  };
  const operationTarget = {
    managerUserId: input.managerUserId,
    propertyId: input.propertyId,
    recipientEmail: input.managerEmail,
  };

  it("stores tour lifecycle messages once under the scoped manager label", async () => {
    const { db, rows } = globalPrimaryKeyDb();
    const notice = {
      participantEmail: input.residentEmail, managerUserId: input.managerUserId,
      propertyId: input.propertyId, propertyTitle: input.propertyTitle,
      subject: "Tour confirmed", body: "Your tour is confirmed.",
      counterpartyEmail: input.managerEmail, managerName: "Jordan Lee", fromName: "Jordan Lee",
      messageId: "tour:one:confirmed:window",
    };
    await appendResidentPropertyManagerInboxMessage(db as never, notice);
    await appendResidentPropertyManagerInboxMessage(db as never, notice);
    const row = rows.get(propertyManagerConversationSideThreadId(input, "resident"))!;
    expect(row.row_data).toMatchObject({ from: "Jordan Lee", managerUserId: "manager-user" });
    expect(row.row_data.rootMessageId).toBe("tour:one:confirmed:window");
  });

  it("preserves explicit manager-side direction and SMS identity metadata without creating an SMS row", async () => {
    const { db, rows } = globalPrimaryKeyDb([{
      id: "existing-prospect",
      scope: "axis_portal_inbox_manager_v1",
      owner_user_id: input.managerUserId,
      participant_email: input.residentEmail,
      thread_type: "portal_message",
      row_data: {
        folder: "inbox", email: input.residentEmail, managerUserId: input.managerUserId,
        propertyId: input.propertyId, counterpartyRole: "prospect",
        messages: [{ id: "prior", from: "Veenu Jain", body: "Can I tour?", at: "Sep 8, 1:00 PM", outbound: false }],
      },
    }]);
    await appendManagerPropertyLeadInboxMessage(db as never, input.managerUserId, {
      propertyId: input.propertyId, propertyTitle: input.propertyTitle,
      prospectName: input.residentName, prospectEmail: input.residentEmail,
      topic: "Tour update", subject: "Tour update", body: "I moved your tour.",
      outbound: true, counterpartyRole: "prospect", smsConversationKey: "manager-user:prospect:+12065550100",
    });
    expect([...rows.values()]).toHaveLength(1);
    expect(rows.get("existing-prospect")?.row_data).toMatchObject({
      counterpartyRole: "prospect", smsConversationKey: "manager-user:prospect:+12065550100",
    });
    expect(rows.get("existing-prospect")?.row_data.messages).toEqual([
      expect.objectContaining({ id: "prior", outbound: false }),
      expect.objectContaining({ body: "I moved your tour.", outbound: true }),
    ]);
  });

  it("keeps both portal sides when ids are globally unique", async () => {
    const { db, rows } = globalPrimaryKeyDb();

    await deliverResidentPropertyManagerChatMessage(db as never, input);

    expect(rows.size).toBe(2);
    expect([...rows.values()].map((row) => row.scope).sort()).toEqual([
      "axis_portal_inbox_manager_v1",
      "axis_portal_inbox_resident_v1",
    ]);
    expect([...rows.keys()].sort()).toEqual([
      propertyManagerConversationSideThreadId(input, "manager"),
      propertyManagerConversationSideThreadId(input, "resident"),
    ].sort());
  });

  it("reuses compatible generic person threads and stamps property identity", async () => {
    const { db, rows } = globalPrimaryKeyDb([
      {
        id: "resident-generic",
        scope: "axis_portal_inbox_resident_v1",
        owner_user_id: "resident-user",
        participant_email: null,
        thread_type: "portal_message",
        row_data: { folder: "sent", email: "ogambik2@gmail.com", subject: "Earlier", body: "Hello" },
      },
      {
        id: "manager-generic",
        scope: "axis_portal_inbox_manager_v1",
        owner_user_id: "manager-user",
        participant_email: null,
        thread_type: "portal_message",
        row_data: { folder: "sent", email: "resident@example.com", subject: "Earlier", body: "Welcome" },
      },
    ]);

    const result = await deliverResidentPropertyManagerChatMessage(db as never, input);

    expect(result.threadId).toBe("resident-generic");
    expect(rows.size).toBe(2);
    expect(rows.get("resident-generic")?.row_data).toMatchObject({
      managerUserId: "manager-user",
      propertyId: "property-a",
      counterpartyRole: "manager",
    });
    expect(rows.get("manager-generic")?.row_data).toMatchObject({
      managerUserId: "manager-user",
      propertyId: "property-a",
      counterpartyRole: "resident",
    });
  });

  it("does not reuse a same-email thread bound to another property", async () => {
    const incompatible: InboxRow = {
      id: "other-property",
      scope: "axis_portal_inbox_resident_v1",
      owner_user_id: "resident-user",
      participant_email: null,
      thread_type: "portal_message",
      row_data: {
        folder: "sent",
        email: "ogambik2@gmail.com",
        managerUserId: "manager-user",
        propertyId: "property-b",
      },
    };
    const { db, rows } = globalPrimaryKeyDb([incompatible]);

    await deliverResidentPropertyManagerChatMessage(db as never, input);

    expect(rows.has("other-property")).toBe(true);
    expect(rows.has(propertyManagerConversationSideThreadId(input, "resident"))).toBe(true);
  });

  it("does not reuse the same counterparty under another owner or role", async () => {
    const { db, rows } = globalPrimaryKeyDb([
      {
        id: "wrong-owner",
        scope: "axis_portal_inbox_resident_v1",
        owner_user_id: "another-resident",
        participant_email: null,
        thread_type: "portal_message",
        row_data: { email: "ogambik2@gmail.com", counterpartyRole: "vendor" },
      },
    ]);

    const result = await deliverResidentPropertyManagerChatMessage(db as never, input);

    expect(result.threadId).not.toBe("wrong-owner");
    expect(rows.get("wrong-owner")?.row_data).toEqual({
      email: "ogambik2@gmail.com",
      counterpartyRole: "vendor",
    });
  });

  it("does not overwrite an incompatible row occupying the legacy global id", async () => {
    const residentId = propertyManagerConversationSideThreadId(input, "resident");
    const collision: InboxRow = {
      id: residentId,
      scope: "axis_portal_inbox_manager_v1",
      owner_user_id: "another-manager",
      participant_email: null,
      thread_type: "portal_message",
      row_data: { email: "someone-else@example.com", body: "Keep me" },
    };
    const { db, rows } = globalPrimaryKeyDb([collision]);

    const result = await deliverResidentPropertyManagerChatMessage(db as never, input);

    expect(result.threadId).toBe(`${residentId}:resident`);
    expect(rows.get(residentId)).toEqual(collision);
    expect(rows.get(`${residentId}:resident`)?.scope).toBe("axis_portal_inbox_resident_v1");
  });

  it("does not treat manager and property metadata as proof over a conflicting email", async () => {
    const residentId = propertyManagerConversationSideThreadId(input, "resident");
    const collision: InboxRow = {
      id: residentId,
      scope: "axis_portal_inbox_resident_v1",
      owner_user_id: "resident-user",
      participant_email: "resident@example.com",
      thread_type: "portal_message",
      row_data: {
        email: "different-manager@example.com",
        managerUserId: "manager-user",
        propertyId: "property-a",
      },
    };
    const { db, rows } = globalPrimaryKeyDb([collision]);

    const result = await deliverResidentPropertyManagerChatMessage(db as never, input);

    expect(result.threadId).toBe(`${residentId}:resident`);
    expect(rows.get(residentId)?.row_data.email).toBe("different-manager@example.com");
  });

  it("fails closed without writing when a canonical read fails", async () => {
    let writes = 0;
    const chain = {
      maybeSingle: async () => ({ data: null, error: { message: "unavailable" } }),
    };
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: chain.maybeSingle,
          }),
        }),
        upsert: async () => {
          writes += 1;
          return { error: null };
        },
        insert: async () => {
          writes += 1;
          return { error: null };
        },
      }),
    };

    await expect(deliverResidentPropertyManagerChatMessage(db as never, input)).rejects.toThrow(
      "Could not verify the canonical property manager thread.",
    );
    expect(writes).toBe(0);
  });

  it("rejects a concurrent global-id collision without overwriting its row", async () => {
    const residentId = propertyManagerConversationSideThreadId(input, "resident");
    const raced: InboxRow = {
      id: residentId,
      scope: "axis_portal_inbox_manager_v1",
      owner_user_id: "other-manager",
      participant_email: null,
      thread_type: "portal_message",
      row_data: { email: "other@example.com", body: "Concurrent row" },
    };
    let injected = false;
    const { db, rows } = globalPrimaryKeyDb([], (row, store) => {
      if (!injected && row.id === residentId) {
        injected = true;
        store.set(residentId, structuredClone(raced));
      }
    });

    await expect(deliverResidentPropertyManagerChatMessage(db as never, input)).rejects.toThrow(
      "Could not create the resident property manager thread.",
    );
    expect(rows.get(residentId)).toEqual(raced);
    expect([...rows.values()]).toHaveLength(1);
  });

  it("prefers an exact property thread over a newer compatible generic thread", async () => {
    const seed = (id: string, propertyId?: string): InboxRow => ({
      id,
      scope: "axis_portal_inbox_resident_v1",
      owner_user_id: "resident-user",
      participant_email: null,
      thread_type: "portal_message",
      row_data: {
        folder: "sent",
        email: "ogambik2@gmail.com",
        managerUserId: "manager-user",
        ...(propertyId ? { propertyId } : {}),
      },
    });
    const { db, rows } = globalPrimaryKeyDb([seed("newer-generic"), seed("property-exact", "property-a")]);

    const result = await deliverResidentPropertyManagerChatMessage(db as never, input);

    expect(result.threadId).toBe("property-exact");
    expect(rows.get("newer-generic")?.row_data).not.toHaveProperty("messages");
  });

  it("deduplicates a partial two-sided failure on retry and accepts a new operation", async () => {
    let failManagerOnce = true;
    const { db, rows } = globalPrimaryKeyDb([], (row) => {
      if (row.scope === "axis_portal_inbox_manager_v1" && failManagerOnce) {
        failManagerOnce = false;
        return { code: "500", message: "manager insert failed" };
      }
    });
    const firstIds = propertyManagerSendMessageIds("resident-user", "5b2937e8-b21c-4aa8-8ed3-e411fa317875", operationTarget);

    await expect(deliverResidentPropertyManagerChatMessage(db as never, { ...input, messageIds: firstIds }))
      .rejects.toThrow("Could not create the manager property thread.");
    await deliverResidentPropertyManagerChatMessage(db as never, { ...input, messageIds: firstIds });

    const resident = [...rows.values()].find((row) => row.scope === "axis_portal_inbox_resident_v1")!;
    const manager = [...rows.values()].find((row) => row.scope === "axis_portal_inbox_manager_v1")!;
    expect(resident.row_data.rootMessageId).toBe(firstIds.resident);
    expect(resident.row_data.messages).toBeUndefined();
    expect(manager.row_data.rootMessageId).toBe(firstIds.manager);

    const secondIds = propertyManagerSendMessageIds("resident-user", "f866d650-c8ed-448c-a9e5-203c40dbed16", operationTarget);
    await deliverResidentPropertyManagerChatMessage(db as never, {
      ...input,
      message: "One more question.",
      messageIds: secondIds,
    });
    expect(resident.row_data.messages).toBeUndefined();
    expect((rows.get(resident.id)?.row_data.messages as unknown[])).toHaveLength(1);
    expect((rows.get(manager.id)?.row_data.messages as unknown[])).toHaveLength(1);
  });

  it("rejects changed content under an already-recorded operation id", async () => {
    const { db } = globalPrimaryKeyDb();
    const messageIds = propertyManagerSendMessageIds("resident-user", "5b2937e8-b21c-4aa8-8ed3-e411fa317875", operationTarget);
    await deliverResidentPropertyManagerChatMessage(db as never, { ...input, messageIds });

    await expect(deliverResidentPropertyManagerChatMessage(db as never, {
      ...input,
      message: "Changed after failure",
      messageIds,
    })).rejects.toThrow("already used for different message content");
  });

  it("changes deterministic message ids when the server-resolved destination changes", () => {
    const operationId = "5b2937e8-b21c-4aa8-8ed3-e411fa317875";
    const original = propertyManagerSendMessageIds("resident-user", operationId, operationTarget);
    expect(propertyManagerSendMessageIds("resident-user", operationId, {
      ...operationTarget,
      managerUserId: "co-manager-user",
    })).not.toEqual(original);
    expect(propertyManagerSendMessageIds("resident-user", operationId, {
      ...operationTarget,
      propertyId: "property-b",
    })).not.toEqual(original);
    expect(propertyManagerSendMessageIds("resident-user", operationId, {
      ...operationTarget,
      recipientEmail: "different-manager@example.com",
    })).not.toEqual(original);
  });
});

describe("propertyManagerThreadLabel", () => {
  it("labels the thread with the house name", () => {
    expect(propertyManagerThreadLabel("Oak House")).toBe("Property manager (Oak House)");
  });
});

describe("appendResidentPropertyManagerInboxMessage", () => {
  it("reuses one thread id for repeated messages about the same property", async () => {
    const { db, rows } = globalPrimaryKeyDb();

    const base = {
      participantEmail: "guest@example.com",
      managerUserId: "mgr-1",
      propertyId: "prop-oak",
      propertyTitle: "Oak House",
      counterpartyEmail: "manager@example.com",
    };

    await appendResidentPropertyManagerInboxMessage(db as never, {
      ...base,
      subject: "We received your message — Availability",
      body: "Thanks for reaching out about Oak House.",
      residentMessage: "Is this still available?",
      residentName: "Alex",
    });
    await appendResidentPropertyManagerInboxMessage(db as never, {
      ...base,
      subject: "We received your message — Parking",
      body: "Thanks for reaching out about Oak House.",
      residentMessage: "Is parking included?",
      residentName: "Alex",
    });

    expect(rows.size).toBe(1);
    const row = [...rows.values()][0];
    expect(row.row_data.from).toBe("Property manager (Oak House)");
    expect(row.row_data.messages).toHaveLength(3);
  });
});

describe("deliverResidentPropertyManagerChatMessage", () => {
  it("writes resident outbound and manager inbound on the property thread id", async () => {
    const { db, rows } = globalPrimaryKeyDb();
    const result = await deliverResidentPropertyManagerChatMessage(db as never, {
      residentEmail: "resident@test.proplane.local",
      residentUserId: "user-1",
      residentName: "Test Resident",
      managerUserId: "mgr-1",
      managerEmail: "manager@test.proplane.local",
      propertyId: "prop-oak",
      propertyTitle: "Oak House",
      subject: "Question about my tour",
      message: "Can we reschedule?",
    });

    expect(result.threadId).toBe(
      propertyManagerConversationThreadId({
        residentEmail: "resident@test.proplane.local",
        managerUserId: "mgr-1",
        propertyId: "prop-oak",
      }),
    );
    expect(rows.size).toBe(2);
    expect(rows.get(result.threadId)?.row_data).toMatchObject({
      body: "Can we reschedule?",
      rootOutbound: true,
    });
  });
});
