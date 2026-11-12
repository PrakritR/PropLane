import { describe, expect, it } from "vitest";
import {
  pickLandlordLegalName,
  resolveWorkspaceLandlordLegalName,
} from "@/lib/manager-landlord-profile";
import {
  LEASE_PLACEHOLDER_EMAIL_MESSAGE,
  leaseRecipientEmailBlocker,
  leaseRecipientHasRealEmail,
  leaseRecipientIsPlaceholder,
} from "@/lib/lease-send-recipient";
import { leaseSendGateBlockerAmong } from "@/lib/lease-pipeline-storage";

describe("landlord on leases: setting, then the workspace owner's full name, then the placeholder", () => {
  it("the workspace setting wins over the owner's account name", () => {
    expect(pickLandlordLegalName({ setting: "Ambika Holdings LLC", ownerFullName: "Ambika Mago" })).toEqual({
      landlordLegalName: "Ambika Holdings LLC",
      source: "setting",
    });
  });

  it("a blank setting falls back to the owner's full name", () => {
    expect(pickLandlordLegalName({ setting: "  ", ownerFullName: "Ambika Mago" })).toEqual({
      landlordLegalName: "Ambika Mago",
      source: "owner",
    });
  });

  it("with neither, nothing is named (the template placeholder stays and the send gate refuses it)", () => {
    expect(pickLandlordLegalName({ setting: "", ownerFullName: "" })).toEqual({ landlordLegalName: "", source: "none" });
    expect(pickLandlordLegalName({})).toEqual({ landlordLegalName: "", source: "none" });
  });

  // PropLane-managed workspace: the signed-in user is staff, the owner is the client. The resolver is
  // asked for the OWNER's id only, so the staff member's own profile is never read.
  it("on a managed workspace the name is the client's, never the signed-in staff member's", async () => {
    const STAFF = "staff-user";
    const OWNER = "client-owner";
    const profiles: Record<string, string> = { [STAFF]: "Staff Person", [OWNER]: "Ambika Mago" };
    const settings: Record<string, unknown> = {};
    const reads: string[] = [];
    const db = {
      from(table: string) {
        let id = "";
        const q = {
          select: () => q,
          eq: (_col: string, value: string) => {
            id = value;
            return q;
          },
          maybeSingle: async () => {
            reads.push(`${table}:${id}`);
            if (table === "profiles") return { data: { full_name: profiles[id] }, error: null };
            return { data: settings[id] ? { row_data: { landlordProfile: settings[id] } } : null, error: null };
          },
        };
        return q;
      },
    };
    const resolved = await resolveWorkspaceLandlordLegalName(db as never, OWNER);
    expect(resolved).toMatchObject({ landlordLegalName: "Ambika Mago", source: "owner", setting: "" });
    expect(reads.some((r) => r.endsWith(`:${STAFF}`))).toBe(false);

    settings[OWNER] = { landlordLegalName: "Ambika Mago Properties LLC" };
    const withSetting = await resolveWorkspaceLandlordLegalName(db as never, OWNER);
    expect(withSetting).toMatchObject({ landlordLegalName: "Ambika Mago Properties LLC", source: "setting" });
  });
});

describe("sending a lease to a placeholder email", () => {
  const row = (residentEmail: string) =>
    ({
      id: "lease-1",
      residentName: "Prakrit Ramachandran",
      residentEmail,
      unit: "Room 9",
      bucket: "manager",
      status: "Draft",
      generatedHtml: "<html><body>lease</body></html>",
    }) as never;

  it("names an import address as not real", () => {
    expect(leaseRecipientIsPlaceholder({ residentEmail: "prakrit-5257-room9@import.proplane.local" })).toBe(true);
    expect(leaseRecipientHasRealEmail({ residentEmail: "prakrit-5257-room9@import.proplane.local" })).toBe(false);
    expect(leaseRecipientHasRealEmail({ residentEmail: "kchan440@gmail.com" })).toBe(true);
    expect(leaseRecipientEmailBlocker({ residentEmail: "kchan440@gmail.com" })).toBeNull();
    expect(leaseRecipientEmailBlocker({ residentEmail: "x@import.proplane.local" })).toBe(LEASE_PLACEHOLDER_EMAIL_MESSAGE);
  });

  it("the send gate refuses a placeholder address with a clear reason, before anything else", () => {
    const blocker = leaseSendGateBlockerAmong(row("prakrit-5257-room9@import.proplane.local"), []);
    expect(blocker).toBe(LEASE_PLACEHOLDER_EMAIL_MESSAGE);
    expect(blocker).toMatch(/Edit resident/);
    expect(leaseSendGateBlockerAmong(row("kchan440@gmail.com"), [])).not.toBe(LEASE_PLACEHOLDER_EMAIL_MESSAGE);
  });
});
