import { describe, expect, it } from "vitest";
import { parseCommunicationThreadId } from "@/lib/portal-communication-nav";

describe("parseCommunicationThreadId", () => {
  it("reads thread ids from manager, resident, and vendor communication paths", () => {
    expect(parseCommunicationThreadId("/portal/communication/active/thread-1", "/portal/communication")).toBe(
      "thread-1",
    );
    expect(parseCommunicationThreadId("/portal/communication/unread/thread-2", "/portal/communication")).toBe(
      "thread-2",
    );
    expect(parseCommunicationThreadId("/resident/communication/archived/a%2Fb", "/resident/communication")).toBe(
      "a/b",
    );
    expect(parseCommunicationThreadId("/vendor/communication/active", "/vendor/communication")).toBeUndefined();
  });
});
