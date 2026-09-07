import { describe, expect, it } from "vitest";

import { RESIDENT_AGENT_THREAD_TYPE } from "@/lib/agent/resident-inbox-agent.server";
import {
  collapseAssistantInboxThreads,
  collapsePersonInboxThreads,
  inboxThreadMessages,
  normalizePersistedInboxThread,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

/**
 * `InboxThreadMessage` declares `body: string`, but every message reaching these
 * helpers was read back out of a `row_data` JSON blob — the type describes what
 * writers intend, not what storage guarantees.
 *
 * One stored message with no `body` threw "Cannot read properties of undefined
 * (reading 'trim')" out of the collapse pass, and because the resident
 * nav-count poll hits `GET /api/portal-inbox-threads` on EVERY page, that one
 * row 500'd the entire resident portal. It was reported as a separate console
 * error on ten different screens (PRP-235…PRP-250).
 */
function threadWithMalformedMessage(id: string): PersistedInboxThread {
  return {
    id,
    folder: "inbox",
    from: "Property manager",
    email: "manager@test.proplane.local",
    subject: "Message from your property manager",
    preview: "hey",
    body: "hey",
    time: "Sep 4, 4:37 AM",
    unread: false,
    messages: [
      // No `body` at all — the shape that took the portal down.
      { id: "msg-1", from: "Property manager", at: "Sep 4, 4:37 AM" },
      // And a fully absent `from` / `at`, which the same pass also dereferences.
      { id: "msg-2", body: "real text" },
    ] as PersistedInboxThread["messages"],
  };
}

describe("inbox thread messages survive rows that storage did not validate", () => {
  it("does not throw on a message with no body", () => {
    expect(() => inboxThreadMessages(threadWithMalformedMessage("t1"))).not.toThrow();
  });

  it("normalizes the missing fields to empty strings rather than dropping the message", () => {
    const messages = inboxThreadMessages(threadWithMalformedMessage("t1"));
    const one = messages.find((m) => m.id === "msg-1");
    expect(one).toBeDefined();
    expect(one?.body).toBe("");
    const two = messages.find((m) => m.id === "msg-2");
    expect(two?.body).toBe("real text");
    expect(two?.from).toBe("");
    expect(two?.at).toBe("");
  });

  it("normalizes a thread whose own root body is missing", () => {
    const thread = { ...threadWithMalformedMessage("t2"), body: undefined } as PersistedInboxThread;
    const [root] = inboxThreadMessages(thread);
    expect(root?.body).toBe("");
  });

  it("collapses assistant threads without throwing", () => {
    const assistant = (id: string): PersistedInboxThread => ({
      ...threadWithMalformedMessage(id),
      from: "PropLane Assistant",
      email: "",
      subject: "Ask PropLane",
      threadType: RESIDENT_AGENT_THREAD_TYPE,
      boundManagerUserId: "552b562f-e9cb-443b-84ec-48018fc0fa19",
    });
    // Two threads in one group is what forces the merge path that dereferenced body.
    expect(() => collapseAssistantInboxThreads([assistant("a1"), assistant("a2")])).not.toThrow();
  });

  it("collapses person threads without throwing", () => {
    expect(() =>
      collapsePersonInboxThreads([threadWithMalformedMessage("p1"), threadWithMalformedMessage("p2")]),
    ).not.toThrow();
  });

  it("coerces a JSON-number email so an existing account can still open Communication", () => {
    const thread = normalizePersistedInboxThread({
      ...threadWithMalformedMessage("n1"),
      email: 18559168031 as unknown as string,
      from: 18559168031 as unknown as string,
    });
    expect(thread.email).toBe("18559168031");
    expect(thread.from).toBe("18559168031");
    expect(thread.email.trim()).toBe("18559168031");
  });
});
