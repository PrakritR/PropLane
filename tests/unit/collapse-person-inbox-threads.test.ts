import { describe, expect, it } from "vitest";
import {
  collapsePersonInboxThreads,
  inboxThreadRelationshipKey,
  inboxThreadMessages,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import { deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";

function thread(partial: Partial<PersistedInboxThread> & Pick<PersistedInboxThread, "id" | "email">): PersistedInboxThread {
  return {
    folder: "sent",
    from: "Manager",
    subject: "Hello",
    preview: "Hello",
    body: "Hello",
    time: "Jan 1, 10:00 AM",
    unread: false,
    ...partial,
  };
}

describe("collapsePersonInboxThreads", () => {
  it("does not adopt an unknown newest row when delivering a proven property relationship", async () => {
    const unknown = {
      id: "shared-fallback",
      row_data: {
        id: "shared-fallback",
        folder: "inbox",
        email: "resident@example.com",
        subject: "Legacy",
        body: "Unknown legacy history",
        preview: "Unknown legacy history",
        time: "Jan 2, 10:00 AM",
        unread: true,
        messages: [],
      },
      owner_user_id: "manager-a",
      participant_email: "resident@example.com",
      scope: "axis_portal_inbox_resident_v1",
      updated_at: "2026-09-18T10:00:00.000Z",
    };
    const rows = new Map<string, Record<string, unknown>>([[unknown.id, structuredClone(unknown)]]);
    const db = {
      from: (table: string) => {
        const builder: Record<string, unknown> = {};
        const self = () => builder;
        for (const method of ["select", "eq", "order", "limit"]) builder[method] = self;
        builder.then = (resolve: (value: unknown) => unknown) => resolve({
          data: table === "portal_inbox_thread_records" ? [...rows.values()] : [],
          error: null,
        });
        builder.insert = async (row: Record<string, unknown>) => {
          if (rows.has(String(row.id))) return { data: null, error: { code: "23505", message: "duplicate key" } };
          rows.set(String(row.id), structuredClone(row));
          return { data: null, error: null };
        };
        builder.upsert = async (row: Record<string, unknown>) => {
          rows.set(String(row.id), structuredClone(row));
          return { data: null, error: null };
        };
        return builder;
      },
    };
    const delivery = {
      scope: "axis_portal_inbox_resident_v1",
      folder: "inbox" as const,
      ownerUserId: "manager-a",
      participantEmail: "resident@example.com",
      otherPartyEmail: "resident@example.com",
      fallbackId: "shared-fallback",
      fromName: "Manager A",
      subject: "Property A update",
      body: "Proven A history",
      preview: "Proven A history",
      when: "Jan 3, 10:00 AM",
      unread: true,
      outbound: false,
      messageId: "property-a-turn",
      threadIdentity: {
        managerUserId: "manager-a",
        propertyId: "property-a",
        counterpartyRole: "resident",
      },
    };

    const first = await deliverPortalMessageThreadSide(db as never, delivery);
    expect(first).toMatchObject({ action: "create" });
    expect(first.threadId).not.toBe("shared-fallback");
    expect(rows.get("shared-fallback")?.row_data).toEqual(unknown.row_data);
    expect(rows.get(first.threadId)?.row_data).toMatchObject({
      propertyId: "property-a",
      counterpartyRole: "resident",
      body: "Proven A history",
    });

    await expect(deliverPortalMessageThreadSide(db as never, delivery))
      .resolves.toMatchObject({ action: "skipped", threadId: first.threadId });
    expect(rows).toHaveLength(2);
    expect(rows.get("shared-fallback")?.row_data).toEqual(unknown.row_data);
  });

  it("creates a separate relationship record when a same-email thread proves another property", async () => {
    const existing = {
      id: "new-thread",
      row_data: {
        id: "new-thread",
        folder: "inbox",
        email: "resident@example.com",
        subject: "Property A",
        body: "Property A root",
        preview: "Property A root",
        time: "Jan 1, 10:00 AM",
        unread: false,
        messages: [],
        managerUserId: "manager-a",
        propertyId: "property-a",
        smsConversationKey: "manager-a:resident:person-a",
      },
      owner_user_id: "manager-a",
      participant_email: "resident@example.com",
      scope: "axis_portal_inbox_resident_v1",
      updated_at: "2026-09-17T10:00:00.000Z",
    };
    const rows = new Map<string, Record<string, unknown>>([[existing.id, structuredClone(existing)]]);
    const db = {
      from: (table: string) => {
        const builder: Record<string, unknown> = {};
        const self = () => builder;
        for (const method of ["select", "eq", "order", "limit"]) builder[method] = self;
        builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: table === "portal_inbox_thread_records" ? [...rows.values()] : [], error: null });
        builder.upsert = async () => {
          return { data: null, error: null };
        };
        builder.insert = async (row: Record<string, unknown>) => {
          if (rows.has(String(row.id))) return { data: null, error: { code: "23505", message: "duplicate key" } };
          rows.set(String(row.id), structuredClone(row));
          return { data: null, error: null };
        };
        return builder;
      },
    };

    const result = await deliverPortalMessageThreadSide(db as never, {
      scope: "axis_portal_inbox_resident_v1",
      folder: "inbox",
      ownerUserId: "manager-a",
      participantEmail: "resident@example.com",
      otherPartyEmail: "resident@example.com",
      fallbackId: "new-thread",
      fromName: "Manager A",
      subject: "Property B update",
      body: "Property B turn must remain visible",
      preview: "Property B turn must remain visible",
      when: "Jan 2, 10:00 AM",
      unread: true,
      outbound: false,
      messageId: "property-b-turn",
      threadIdentity: {
        managerUserId: "manager-a",
        propertyId: "property-b",
        propertyTitle: "Property B",
        smsConversationKey: "manager-a:resident:person-b",
      },
    } as never);

    expect(result).toMatchObject({ action: "create" });
    expect(result.threadId).not.toBe("new-thread");
    expect(rows.get("new-thread")?.row_data).toMatchObject({
      propertyId: "property-a",
      smsConversationKey: "manager-a:resident:person-a",
      messages: [],
    });
    expect(rows.get(result.threadId)?.row_data).toMatchObject({
      propertyId: "property-b",
      smsConversationKey: "manager-a:resident:person-b",
      rootMessageId: "property-b-turn",
    });

    await expect(deliverPortalMessageThreadSide(db as never, {
      scope: "axis_portal_inbox_resident_v1", folder: "inbox", ownerUserId: "manager-a",
      participantEmail: "resident@example.com", otherPartyEmail: "resident@example.com", fallbackId: "new-thread",
      fromName: "Manager A", subject: "Property B update", body: "Property B turn must remain visible",
      preview: "Property B turn must remain visible", when: "Jan 2, 10:00 AM", unread: true, outbound: false,
      messageId: "property-b-turn", threadIdentity: {
        managerUserId: "manager-a", propertyId: "property-b", propertyTitle: "Property B",
        smsConversationKey: "manager-a:resident:person-b",
      },
    } as never)).resolves.toMatchObject({ action: "skipped", threadId: result.threadId });
    expect(rows).toHaveLength(2);
  });
  it("keeps a bound property history separate from a later contradictory property source", () => {
    const rows = collapsePersonInboxThreads([
      thread({
        id: "property-a-bound",
        email: "resident@example.com",
        managerUserId: "manager-a",
        propertyId: "property-a",
        smsConversationKey: "manager-a:resident:person-a",
        body: "Property A turn",
      }),
      thread({
        id: "property-b-late",
        email: "resident@example.com",
        managerUserId: "manager-a",
        propertyId: "property-b",
        body: "Property B late turn",
        time: "Jan 2, 10:00 AM",
      }),
    ]);

    expect(rows).toHaveLength(2);
    const bound = rows.find((row) => row.id === "property-a-bound");
    const contradictory = rows.find((row) => row.id === "property-b-late");
    expect(inboxThreadMessages(bound!).map((message) => message.body)).toEqual(["Property A turn"]);
    expect(bound).toMatchObject({
      propertyId: "property-a",
      smsConversationKey: "manager-a:resident:person-a",
    });
    expect(inboxThreadMessages(contradictory!).map((message) => message.body)).toEqual(["Property B late turn"]);
    expect(contradictory).toMatchObject({ propertyId: "property-b" });
  });
  it("derives a fold key only for the same proven property relationship", () => {
    const propertyA = thread({ id: "relationship-a", email: "resident@example.com", managerUserId: "manager-a", propertyId: "property-a" });
    const propertyAAgain = thread({ id: "relationship-a-again", email: "resident@example.com", managerUserId: "manager-a", propertyId: "property-a" });
    const propertyB = thread({ id: "relationship-b", email: "resident@example.com", managerUserId: "manager-a", propertyId: "property-b" });
    const unknown = thread({ id: "relationship-unknown", email: "resident@example.com" });

    expect(inboxThreadRelationshipKey(propertyA)).toBe(inboxThreadRelationshipKey(propertyAAgain));
    expect(inboxThreadRelationshipKey(propertyA)).not.toBe(inboxThreadRelationshipKey(propertyB));
    expect(inboxThreadRelationshipKey(unknown)).toBeNull();
  });

  it("preserves conflicting identity evidence when a new binding arrives after the first collapse", () => {
    const first = collapsePersonInboxThreads([
      thread({ id: "first-a", email: "same@example.com", propertyId: "property-a", body: "A" }),
      thread({ id: "first-b", email: "same@example.com", propertyId: "property-b", body: "B", time: "Jan 2, 10:00 AM" }),
    ]);
    const second = collapsePersonInboxThreads([
      ...first,
      thread({
        id: "late-bound-a",
        email: "same@example.com",
        propertyId: "property-a",
        smsConversationKey: "manager-a:resident:person-a",
        body: "A later turn",
        time: "Jan 3, 10:00 AM",
      }),
    ]);

    expect(second).toHaveLength(2);
    const propertyA = second.find((row) => row.propertyId === "property-a");
    const propertyB = second.find((row) => row.propertyId === "property-b");
    expect(inboxThreadMessages(propertyA!).map((message) => message.body)).toEqual(["A", "A later turn"]);
    expect(propertyA?.smsConversationKey).toBe("manager-a:resident:person-a");
    expect(inboxThreadMessages(propertyB!).map((message) => message.body)).toEqual(["B"]);
  });
  it("merges historical notices for one owner's normalized phone and preserves every turn", () => {
    const rows = collapsePersonInboxThreads([
      thread({ id: "claw_lease_1000_a", email: "", ownerUserId: "manager-a", from: "(206) 555-0100", body: "First", folder: "inbox" }),
      thread({ id: "claw_resident_2000_b", email: "", ownerUserId: "manager-a", from: "+12065550100", body: "Second", folder: "inbox", time: "Jan 2, 10:00 AM", unread: true }),
      thread({ id: "claw_lease_3000_c", email: "", ownerUserId: "manager-b", from: "+12065550100", body: "Other manager", folder: "inbox" }),
    ], { mergeFolders: true });
    expect(rows).toHaveLength(2);
    const merged = rows.find((r) => r.ownerUserId === "manager-a")!;
    expect(inboxThreadMessages(merged).map((m) => m.body)).toEqual(["First", "Second"]);
    expect(merged.sourceThreadIds).toEqual(["claw_lease_1000_a", "claw_resident_2000_b"]);
    expect(merged.unread).toBe(true);
    expect(merged.messages?.every((message) => message.outbound === false)).toBe(true);
  });

  it("never guesses phone identity from a message or a display name", () => {
    const rows = collapsePersonInboxThreads([
      thread({ id: "claw_lease_1", email: "", ownerUserId: "a", from: "Dana", body: "+12065550100" }),
      thread({ id: "claw_lease_2", email: "", ownerUserId: "a", from: "Dana", body: "+12065550100" }),
      thread({ id: "claw_lease_3", email: "", from: "+12065550100" }),
      thread({ id: "claw_lease_4", email: "", from: "+12065550100" }),
    ]);
    expect(rows).toHaveLength(4);
  });

  it("merges multiple sent threads for the same resident email", () => {
    const rows = collapsePersonInboxThreads([
      thread({
        id: "payment_sent_mgr_1000_aaaa",
        email: "resident@test.com",
        body: "First reminder",
        time: "Jan 1, 10:00 AM",
      }),
      thread({
        id: "payment_sent_mgr_2000_bbbb",
        email: "resident@test.com",
        body: "Second reminder",
        time: "Jan 2, 10:00 AM",
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("payment_sent_mgr_2000_bbbb");
    const timeline = inboxThreadMessages(rows[0]!);
    expect(timeline.map((m) => m.body)).toEqual(["First reminder", "Second reminder"]);
    expect(new Set(timeline.map((m) => m.id)).size).toBe(timeline.length);
  });

  it("carries older verified relationship metadata when the newest ordinary email omits it", () => {
    const rows = collapsePersonInboxThreads([
      thread({
        id: "verified-manager-notice",
        folder: "inbox",
        email: "manager@example.com",
        managerUserId: "manager-1",
        propertyId: "property-1",
        propertyTitle: "Oak House",
        body: "Verified lifecycle notice",
        time: "Sep 17, 10:00 AM",
      }),
      thread({
        id: "ordinary-manager-email",
        folder: "inbox",
        email: "manager@example.com",
        identityProvenance: [{
          managerUserId: "manager-1",
          propertyId: "property-1",
          propertyTitle: "Oak House",
        }],
        body: "New ordinary message",
        time: "Sep 18, 10:00 AM",
      }),
    ], { mergeFolders: true });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "ordinary-manager-email",
      managerUserId: "manager-1",
      propertyId: "property-1",
      propertyTitle: "Oak House",
    });
  });

  it("keeps conflicting relationship histories separate instead of erasing their evidence", () => {
    const rows = collapsePersonInboxThreads([
      thread({
        id: "manager-a",
        folder: "inbox",
        email: "shared@example.com",
        managerUserId: "manager-a",
        propertyId: "property-a",
      }),
      thread({
        id: "manager-b",
        folder: "inbox",
        email: "shared@example.com",
        managerUserId: "manager-b",
        propertyId: "property-b",
        time: "Sep 18, 10:00 AM",
      }),
    ], { mergeFolders: true });

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "manager-a", managerUserId: "manager-a", propertyId: "property-a" }),
      expect.objectContaining({ id: "manager-b", managerUserId: "manager-b", propertyId: "property-b" }),
    ]));
  });

  it("keeps separate threads for different residents", () => {
    const rows = collapsePersonInboxThreads([
      thread({ id: "t1", email: "a@test.com" }),
      thread({ id: "t2", email: "b@test.com" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("merges inbox and sent rows for the same resident when mergeFolders is set", () => {
    const rows = collapsePersonInboxThreads(
      [
        thread({
          id: "sent_1",
          folder: "sent",
          email: "resident@test.com",
          body: "Reminder",
        }),
        thread({
          id: "inbox_1",
          folder: "inbox",
          email: "resident@test.com",
          body: "Thanks",
          from: "Resident",
        }),
      ],
      { mergeFolders: true },
    );
    expect(rows).toHaveLength(1);
    const timeline = inboxThreadMessages(rows[0]!);
    expect(timeline.map((m) => m.body)).toEqual(["Reminder", "Thanks"]);
    expect(new Set(timeline.map((m) => m.id)).size).toBe(timeline.length);
  });

  it("keeps an emailed-in root FIRST after replies, so the sender stays the thread's face", () => {
    // The inbox row's `time` advanced to the reply; without `rootAt` the root
    // inherited it and sorted after the assistant's answer, which then became
    // the merged thread's `from` — read as the PropLane Assistant conversation.
    const rows = collapsePersonInboxThreads([
      thread({
        id: "assistant-email-abc",
        folder: "inbox",
        email: "prakrit@example.com",
        from: "Prakrit Ramachandran",
        body: "a",
        time: "Sep 15, 1:50 PM",
        messages: [
          { id: "assistant-email-out-abc", from: "PropLane Assistant", body: "Can I help?", at: "Sep 15, 1:49 PM", outbound: true },
          { id: "reply-1", from: "Property manager", body: "hey", at: "Sep 15, 1:50 PM", outbound: true, channel: "email" },
        ],
      }),
      thread({
        id: "msg_mgr_1789505418718_x",
        folder: "sent",
        email: "prakrit@example.com",
        from: "Property manager",
        body: "hey",
        time: "Sep 15, 1:50 PM",
        rootOutbound: true,
      }),
    ], { mergeFolders: true });
    expect(rows).toHaveLength(1);
    const merged = rows[0]!;
    expect(merged.from).toBe("Prakrit Ramachandran");
    expect(merged.rootOutbound).toBe(false);
    // …and the root turn itself says so, so a Sent-folder id cannot flip it.
    expect(inboxThreadMessages(merged)[0]?.outbound).toBe(false);
    // The Sent-copy root is the same send as the appended reply — shown once.
    expect(inboxThreadMessages(merged).map((m) => m.body)).toEqual(["a", "Can I help?", "hey"]);
  });

  it("carries the root's channel and subject onto the merged row, and drops a row a sibling already folded in", () => {
    const inbox = thread({
      id: "assistant-email-abc",
      folder: "inbox",
      email: "prakrit@example.com",
      from: "Prakrit Ramachandran",
      body: "a",
      time: "Sep 15, 2:04 PM",
      rootAt: "Sep 15, 2:04 PM",
      rootChannel: "email",
      rootSubject: "Re: Propert",
    });
    const alreadyMerged = thread({
      id: "msg_mgr_1789506307146_k",
      folder: "sent",
      email: "prakrit@example.com",
      from: "Prakrit Ramachandran",
      body: "a",
      time: "Sep 15, 2:05 PM",
      rootAt: "Sep 15, 2:04 PM",
      rootOutbound: false,
      sourceThreadIds: ["assistant-email-abc", "msg_mgr_1789506307146_k"],
      messages: [{ id: "reply-1", from: "Property manager", body: "hey", at: "Sep 15, 2:05 PM", outbound: true, channel: "email" }],
    });
    const rows = collapsePersonInboxThreads([inbox, alreadyMerged], { mergeFolders: true });
    expect(rows).toHaveLength(1);
    expect(inboxThreadMessages(rows[0]!).map((m) => m.body)).toEqual(["a", "hey"]);

    const fresh = collapsePersonInboxThreads(
      [inbox, thread({ id: "msg_mgr_1789506307147_z", folder: "sent", email: "prakrit@example.com", from: "Property manager", body: "hey", time: "Sep 15, 2:05 PM", rootOutbound: true })],
      { mergeFolders: true },
    );
    expect(fresh[0]).toMatchObject({ rootChannel: "email", rootSubject: "Re: Propert", from: "Prakrit Ramachandran" });
  });

  it("prefers a persisted rootAt over the earliest-append bound", () => {
    const rows = collapsePersonInboxThreads([
      thread({
        id: "inbox-1",
        folder: "inbox",
        email: "p@example.com",
        from: "P",
        body: "root",
        time: "Sep 15, 3:00 PM",
        rootAt: "Sep 15, 1:00 PM",
        messages: [{ id: "r1", from: "Manager", body: "later", at: "Sep 15, 3:00 PM", outbound: true }],
      }),
      thread({ id: "msg_m_1789505418718_y", folder: "sent", email: "p@example.com", from: "Manager", body: "other", time: "Sep 15, 2:00 PM", rootOutbound: true }),
    ], { mergeFolders: true });
    expect(inboxThreadMessages(rows[0]!).map((m) => m.body)).toEqual(["root", "other", "later"]);
  });

  it("re-keys merged tour notification roots so React keys stay unique", () => {
    const rows = collapsePersonInboxThreads(
      [
        thread({
          id: "tour_inbox_1786191721716_46tz",
          folder: "inbox",
          email: "guest@example.com",
          body: "Your tour request was received.",
          from: "PropLane Tours",
        }),
        thread({
          id: "tour_inbox_1786191721717_abcd",
          folder: "inbox",
          email: "guest@example.com",
          body: "Your tour request was removed.",
          from: "PropLane Tours",
        }),
      ],
      { mergeFolders: true },
    );
    expect(rows).toHaveLength(1);
    const timeline = inboxThreadMessages(rows[0]!);
    expect(timeline.map((m) => m.body)).toEqual([
      "Your tour request was received.",
      "Your tour request was removed.",
    ]);
    expect(new Set(timeline.map((m) => m.id)).size).toBe(timeline.length);
  });

  it("deduplicates repeated merged roots from a previously collapsed thread", () => {
    const id = "tour_inbox_1787367693325_nghn";
    const rows = collapsePersonInboxThreads([
      thread({
        id,
        folder: "inbox",
        email: "guest@example.com",
        body: "Your tour request was received.",
        from: "PropLane Tours",
        messages: [
          { id: `merged:${id}-root`, from: "PropLane Tours", body: "Your tour was confirmed.", at: "Jan 2, 10:00 AM" },
          { id: `merged:${id}-root`, from: "PropLane Tours", body: "Your tour was confirmed.", at: "Jan 2, 10:00 AM" },
        ],
      }),
    ]);

    const timeline = inboxThreadMessages(rows[0]!);
    expect(timeline.map((message) => message.body)).toEqual([
      "Your tour request was received.",
      "Your tour was confirmed.",
    ]);
    expect(new Set(timeline.map((message) => message.id)).size).toBe(timeline.length);
  });
});
