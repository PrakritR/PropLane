import { describe, expect, it } from "vitest";
import { isSelfThread, resolveCounterpartyName, threadIsOutbound } from "@/lib/record-communication-counterparty";

describe("who a record's Communication pane is with", () => {
  const sentByManager = { folder: "sent", from: "Test Manager", email: "liam@example.com" };
  const inboundFromResident = { folder: "inbox", from: "Liam Foster", email: "liam@example.com" };

  it("the record's contact names the pane, whatever the thread says (the manager's sent notices put the manager in `from`)", () => {
    expect(resolveCounterpartyName({ contactName: "Liam Foster", thread: sentByManager, recordLabel: "Storage locker" })).toBe("Liam Foster");
  });

  it("never falls back to the viewer's own name from an outbound thread", () => {
    expect(resolveCounterpartyName({ thread: sentByManager, recordLabel: "Storage locker" })).toBe("Storage locker");
    expect(resolveCounterpartyName({ thread: { ...sentByManager, folder: "inbox", rootOutbound: true }, recordLabel: "", recipientEmail: "liam@example.com" })).toBe("liam@example.com");
  });

  it("uses the sender of an inbound thread when nothing else names the other side", () => {
    expect(resolveCounterpartyName({ thread: inboundFromResident, recordLabel: "Storage locker" })).toBe("Liam Foster");
  });

  it("recognises an outbound thread", () => {
    expect(threadIsOutbound(sentByManager)).toBe(true);
    expect(threadIsOutbound(inboundFromResident)).toBe(false);
    expect(threadIsOutbound(null)).toBe(false);
  });

  it("a thread addressed to the viewer is a self-thread, even if the contact was misresolved to the viewer", () => {
    expect(isSelfThread({ email: "Manager@Example.com" }, "manager@example.com")).toBe(true);
    expect(isSelfThread({ email: "liam@example.com" }, "manager@example.com")).toBe(false);
    expect(isSelfThread({ email: "manager@example.com" }, undefined)).toBe(false);
  });
});
