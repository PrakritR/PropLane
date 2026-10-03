import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deliverViaWithSenders,
  resolveWorkspaceSendIdentity,
  senderForChannel,
} from "@/lib/workspace-send-identity";

/**
 * Captain, Oct 3: once a workspace has a work number, every outbound message
 * leaves through the workspace work identity — SMS from the work number, email
 * from the work email, in-app as the workspace/manager — and no path may pick a
 * personal sender. Before a work number exists nothing changes.
 */

const withNumber = resolveWorkspaceSendIdentity({
  workNumber: "+18559168031",
  workNumberCanSend: true,
  workEmail: "assist-abc@prop-lane.space",
});

describe("workspace send identity", () => {
  it("uses the work number, work email and workspace manager once they exist", () => {
    expect(withNumber.hasWorkNumber).toBe(true);
    expect(withNumber.sms).toEqual({ kind: "work_number", from: "+18559168031" });
    expect(withNumber.email).toEqual({ kind: "work_email", address: "assist-abc@prop-lane.space" });
    expect(withNumber.inApp).toEqual({ kind: "workspace_manager" });
  });

  it("deliver-via resolves every enabled channel to the work identity", () => {
    const result = deliverViaWithSenders({ viaEmail: true, viaSms: true, viaInbox: true }, withNumber);
    expect(result.senders.sms).toEqual({ kind: "work_number", from: "+18559168031" });
    expect(result.senders.email).toEqual({ kind: "work_email", address: "assist-abc@prop-lane.space" });
    expect(result.senders.inApp).toEqual({ kind: "workspace_manager" });
    expect(result.viaSms).toBe(true);
  });

  it("a request for a personal sender is ignored once a work number exists", () => {
    for (const channel of ["sms", "email", "inApp"] as const) {
      expect(senderForChannel(withNumber, channel as never, "personal")).toEqual(
        senderForChannel(withNumber, channel as never, "work"),
      );
      expect(senderForChannel(withNumber, channel as never, "personal")).toEqual(
        senderForChannel(withNumber, channel as never),
      );
    }
    const viaPersonal = deliverViaWithSenders({ viaEmail: true, viaSms: true }, withNumber, "personal");
    expect(viaPersonal.senders.sms).toEqual({ kind: "work_number", from: "+18559168031" });
    expect(viaPersonal.senders.email).toEqual({ kind: "work_email", address: "assist-abc@prop-lane.space" });
  });

  it("no identity, with or without a work number, ever yields a personal sender", () => {
    const identities = [
      resolveWorkspaceSendIdentity({}),
      resolveWorkspaceSendIdentity({ workNumber: "+18559168031", workNumberCanSend: false }),
      resolveWorkspaceSendIdentity({ workEmail: "assist-abc@prop-lane.space" }),
      withNumber,
    ];
    for (const identity of identities) {
      for (const requested of ["personal", "work", null, undefined] as const) {
        expect(JSON.stringify(senderForChannel(identity, "sms", requested))).not.toContain("personal");
        expect(JSON.stringify(senderForChannel(identity, "email", requested))).not.toContain("personal");
        expect(JSON.stringify(senderForChannel(identity, "inApp", requested))).not.toContain("personal");
      }
    }
  });

  it("keeps today's behaviour before a work number exists", () => {
    const none = resolveWorkspaceSendIdentity({});
    expect(none.hasWorkNumber).toBe(false);
    expect(none.sms).toEqual({ kind: "unavailable" });
    expect(none.email).toEqual({ kind: "shared_sender" });
    const result = deliverViaWithSenders({ viaEmail: true, viaSms: true, viaInbox: true }, none);
    // SMS is switched off, not rerouted to anything else.
    expect(result.viaSms).toBe(false);
    expect(result.senders.sms).toBeNull();
    expect(result.senders.email).toEqual({ kind: "shared_sender" });
  });

  it("a number still registering counts as set up but cannot carry SMS yet", () => {
    const registering = resolveWorkspaceSendIdentity({ workNumber: "+18559168031", workNumberCanSend: false });
    expect(registering.hasWorkNumber).toBe(true);
    expect(registering.sms).toEqual({ kind: "unavailable" });
  });

  it("a disabled channel resolves no sender", () => {
    const result = deliverViaWithSenders({ viaEmail: false, viaSms: false, viaInbox: false }, withNumber);
    expect(result.senders).toEqual({ sms: null, email: null, inApp: null });
  });
});

/**
 * Source guard: the shared PropLane sender (`RESEND_FROM`) is for platform mail
 * only — auth, alerts TO a manager, and applicant account mail that precedes
 * any manager relationship. A manager-originated sender that reads it directly
 * would skip the work email, so a NEW file naming it must be classified here.
 */
describe("direct shared-sender (RESEND_FROM) references are classified", () => {
  const PLATFORM_MAIL = new Set([
    // Auth / account recovery.
    "src/app/api/auth/password-reset/route.ts",
    "src/app/api/auth/resident-setup-link/route.ts",
    "src/app/api/auth/vendor-register/route.ts",
    "src/lib/auth/account-recovery.server.ts",
    "src/lib/test-workspaces/deliver-auth-invite.server.ts",
    // Alerts and receipts TO the manager / the user themself.
    "src/app/api/manager/app-download-email/route.ts",
    "src/lib/cosigner-notification.server.ts",
    "src/lib/application-submitted-notification.server.ts",
    "src/lib/property-lead-notification.server.ts",
    "src/lib/sms-inbox-notice.server.ts",
    "src/lib/voice/voice-summary-email.server.ts",
    "src/lib/manager-default-tasks.server.ts",
    // Applicant account/resume mail sent before any manager relationship exists.
    "src/app/api/portal/send-application-started/route.ts",
    "src/app/api/portal/send-application-submitted/route.ts",
    "src/app/api/stripe/application-fee-verify/route.ts",
    // The one definition.
    "src/lib/manager-outbound-identity.server.ts",
  ]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it("only classified files read RESEND_FROM", () => {
    const hits = walk("src")
      .filter((file) => readFileSync(file, "utf8").includes("RESEND_FROM"))
      .map((file) => file.replace(/\\/g, "/"))
      .sort();
    const unclassified = hits.filter((file) => !PLATFORM_MAIL.has(file));
    expect(unclassified).toEqual([]);
  });

  it("manager-initiated application email resolves the workspace From header", () => {
    const route = readFileSync("src/app/api/portal/send-manager-application-started/route.ts", "utf8");
    expect(route).toContain("managerOutboundFromHeader");
    expect(route).not.toContain("RESEND_FROM");
  });

  it("the interactive send route never trusts a request-body sender address", () => {
    const route = readFileSync("src/app/api/portal/send-inbox-message/route.ts", "utf8");
    expect(route).not.toMatch(/body\.fromEmail\s*\?\?/);
    expect(route).not.toMatch(/body\.(fromNumber|fromAddress|from)\b/);
  });
});
