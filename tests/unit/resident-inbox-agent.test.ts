/**
 * The resident's assistant thread.
 *
 * Two invariants matter here. The thread id encodes the manager it is bound to,
 * because that binding is what scopes every tool call the assistant makes — so
 * parsing it has to be exact. And attribution has to be by the stored sender
 * name, so the transcript handed to the model says who actually said what.
 */
import { describe, expect, it } from "vitest";
import {
  RESIDENT_AGENT_FROM_NAME,
  managerUserIdFromAgentThreadId,
  residentAgentThreadId,
  threadHistory,
} from "@/lib/agent/resident-inbox-agent.server";

const RESIDENT = "d1b42a92-0784-4ccc-b857-41db374547e1";
const MANAGER = "552b562f-e9cb-443b-84ec-48018fc0fa19";

describe("thread identity", () => {
  it("is stable for one resident regardless of manager argument", () => {
    expect(residentAgentThreadId(RESIDENT, MANAGER)).toBe(`resident-agent-${RESIDENT}`);
    expect(residentAgentThreadId(RESIDENT)).toBe(residentAgentThreadId(RESIDENT, MANAGER));
  });

  it("round-trips the manager from a legacy thread id", () => {
    const legacyId = `resident-agent-${RESIDENT}-${MANAGER}`;
    expect(managerUserIdFromAgentThreadId(legacyId, RESIDENT)).toBe(MANAGER);
  });

  it("reads boundManagerUserId from row data on canonical ids", () => {
    const canonicalId = residentAgentThreadId(RESIDENT);
    expect(
      managerUserIdFromAgentThreadId(canonicalId, RESIDENT, { boundManagerUserId: MANAGER }),
    ).toBe(MANAGER);
  });

  it("refuses to read a manager out of a thread that is not this resident's", () => {
    const legacyId = `resident-agent-${RESIDENT}-${MANAGER}`;
    expect(managerUserIdFromAgentThreadId(legacyId, "someone-else")).toBeNull();
    expect(managerUserIdFromAgentThreadId("portal-message-123", RESIDENT)).toBeNull();
    expect(managerUserIdFromAgentThreadId(`resident-agent-${RESIDENT}-`, RESIDENT)).toBeNull();
  });
});

describe("threadHistory", () => {
  it("resolves only the resident's structured photo attachments into filing references", () => {
    const ownPath = `${RESIDENT}/upload/photo.jpg`;
    const foreignPath = `${MANAGER}/upload/photo.jpg`;
    const url = (path: string) => `/api/portal/inbox-attachments?path=${encodeURIComponent(path)}`;
    const history = threadHistory({ messages: [{ from: "Resident", body: "My door photo", attachments: [
      { url: url(ownPath) }, { url: url(foreignPath) },
      { url: `https://evil.test${url(ownPath)}` }, { url: url(`${RESIDENT}/upload/document.pdf`) },
    ] }] }, RESIDENT);
    expect(history[0].body).toContain(ownPath);
    expect(history[0].body).not.toContain(foreignPath);
    expect(history[0].body).not.toContain("evil.test");
    expect(history[0].body).not.toContain("document.pdf");
    expect(history[0].body).toContain("file_inspection_photo");
  });

  it("does not mint attachment context from assistant turns or quoted source URLs", () => {
    const url = `/api/portal/inbox-attachments?path=${encodeURIComponent(`${RESIDENT}/upload/photo.jpg`)}`;
    const history = threadHistory({ messages: [
      { from: RESIDENT_AGENT_FROM_NAME, body: "Assistant reply", attachments: [{ url }] },
      { from: "Resident", body: `The message mentioned ${url}` },
    ] }, RESIDENT);
    expect(history[0].body).toBe("Assistant reply");
    expect(history[1].body).toBe(`The message mentioned ${url}`);
  });

  it("attributes by sender name, not by position", () => {
    const history = threadHistory({
      messages: [
        { from: RESIDENT_AGENT_FROM_NAME, body: "how can I help?" },
        { from: "PropLane Portal", body: "when is rent due?" },
        { from: RESIDENT_AGENT_FROM_NAME, body: "the 1st" },
      ],
    });
    expect(history).toEqual([
      { from: "manager", body: "how can I help?" },
      { from: "resident", body: "when is rent due?" },
      { from: "manager", body: "the 1st" },
    ]);
  });

  it("drops blank bodies rather than sending empty turns to the model", () => {
    const history = threadHistory({
      messages: [{ from: "PropLane Portal", body: "   " }, { from: "PropLane Portal", body: "real" }],
    });
    expect(history).toEqual([{ from: "resident", body: "real" }]);
  });

  it("returns nothing for a thread with no messages or a malformed row", () => {
    expect(threadHistory({ messages: [] })).toEqual([]);
    expect(threadHistory({})).toEqual([]);
    expect(threadHistory(null)).toEqual([]);
    expect(threadHistory(undefined)).toEqual([]);
    expect(threadHistory({ messages: "not-an-array" })).toEqual([]);
  });

  it("survives entries missing from/body without throwing", () => {
    expect(threadHistory({ messages: [{}, { from: 1, body: 2 }, { body: "kept" }] })).toEqual([
      { from: "resident", body: "kept" },
    ]);
  });
});
