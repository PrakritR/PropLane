import { describe, expect, it } from "vitest";
import { parseVendorDispatchReply } from "@/lib/vendor-dispatch/reply-parse";
import { parseVendorProposedTime } from "@/lib/vendor-dispatch/time";
import { managedReadOnlyInboxThreadAllowed } from "@/lib/auth/managed-read-only-policy";
import { managerAgentNoticeThreadId } from "@/lib/communication-manager-assistant-thread";

describe("a vendor reply whose first word is NO or BUSY but which takes the job", () => {
  it("is not recorded as a decline or a busy window", () => {
    // Either reading is a guess, and both are costly: a decline hands the job to the next vendor and BUSY
    // parks this one for two hours. The reply falls through to the agents instead.
    expect(parseVendorDispatchReply("No problem, I can do 3pm")).toBeNull();
    expect(parseVendorDispatchReply("Booked it for 2pm")).toBeNull();
    expect(parseVendorDispatchReply("No can do for $240")).toBeNull();
  });

  it("still reads a plain decline, a job-numbered decline and a plain BUSY window", () => {
    expect(parseVendorDispatchReply("NO")).toEqual({ kind: "no", handle: null });
    expect(parseVendorDispatchReply("no 7")).toEqual({ kind: "no", handle: 7 });
    expect(parseVendorDispatchReply("pass")).toEqual({ kind: "no", handle: null });
    expect(parseVendorDispatchReply("BUSY 2h")).toEqual({ kind: "busy", handle: null, minutes: 120 });
    expect(parseVendorDispatchReply("busy 30m")).toMatchObject({ kind: "busy", minutes: 30 });
  });

  it("leaves an acceptance alone", () => {
    expect(parseVendorDispatchReply("YES 3pm $240")).toMatchObject({ kind: "yes", priceCents: 24_000 });
  });
});

describe("a bare hour with no am/pm is the working afternoon", () => {
  // Thursday 2026-10-15, 10:00 Pacific.
  const now = new Date("2026-10-15T17:00:00.000Z");
  const pacificHour = (at: Date | null) =>
    at && Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(at)) % 24;

  it("reads \"at 3\" as 3 PM, never 3 AM", () => {
    expect(pacificHour(parseVendorProposedTime("at 3", now))).toBe(15);
    expect(pacificHour(parseVendorProposedTime("at 3:30", now))).toBe(15);
    expect(pacificHour(parseVendorProposedTime("tomorrow at 2", now))).toBe(14);
  });

  it("leaves an explicit meridiem and a 24-hour reading alone", () => {
    expect(pacificHour(parseVendorProposedTime("3am", now))).toBe(3);
    expect(pacificHour(parseVendorProposedTime("at 15:00", now))).toBe(15);
    expect(pacificHour(parseVendorProposedTime("at 9", now))).toBe(9);
  });

  it("still refuses a bare small number that is not obviously a time", () => {
    expect(parseVendorProposedTime("2h", now)).toBeNull();
    expect(parseVendorProposedTime("7", now)).toBeNull();
  });
});

describe("a locked client's inbox writes reach only their OWN Assistant thread", () => {
  const WS = "ws-1";

  it("allows their own Assistant thread, in the default and a named workspace", () => {
    expect(managedReadOnlyInboxThreadAllowed(managerAgentNoticeThreadId("client"), WS, "svc-owner", "client")).toBe(true);
    expect(managedReadOnlyInboxThreadAllowed(managerAgentNoticeThreadId("client", WS), WS, "svc-owner", "client")).toBe(true);
  });

  it("refuses a staff member's Assistant thread, which the bare prefix used to allow", () => {
    expect(managedReadOnlyInboxThreadAllowed("agent_notice_staff", WS, "svc-owner", "client")).toBe(false);
    expect(managedReadOnlyInboxThreadAllowed(`agent_notice_staff__${WS}`, WS, "svc-owner", "client")).toBe(false);
    expect(managedReadOnlyInboxThreadAllowed("agent_notice_", WS, "svc-owner", "client")).toBe(false);
  });

  it("still allows this workspace's Team chat and nothing else", () => {
    expect(managedReadOnlyInboxThreadAllowed(`team-thread:svc-owner:ws:${WS}`, WS, "svc-owner", "client")).toBe(true);
    expect(managedReadOnlyInboxThreadAllowed("team-thread:svc-owner:ws:other", WS, "svc-owner", "client")).toBe(false);
    expect(managedReadOnlyInboxThreadAllowed("resident-thread-1", WS, "svc-owner", "client")).toBe(false);
    expect(managedReadOnlyInboxThreadAllowed("", WS, "svc-owner", "client")).toBe(false);
  });
});
