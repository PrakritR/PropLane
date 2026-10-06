import { describe, expect, it } from "vitest";
import { getMoveInInfoTool } from "@/lib/tools/domains/resident/lease";
import { emptyHouseInfo, setHouseInfoValue } from "@/lib/house-info";
import { makeResidentToolCtx, type FakeRow } from "./fake-resident-ctx";

const RESIDENT = { id: "resident_a", email: "resa@axis.test" };

function houseTables(): Record<string, FakeRow[]> {
  let houseInfo = setHouseInfoValue(emptyHouseInfo(), "access", "doorCode", "DOORCODE-7788");
  houseInfo = setHouseInfoValue(houseInfo, "wifi", "network", "NET-OPEN-SESAME");
  houseInfo = setHouseInfoValue(houseInfo, "wifi", "password", "WIFIPASS-9911");
  return {
    manager_application_records: [
      {
        id: "APP-A",
        manager_user_id: "manager_1",
        resident_email: RESIDENT.email,
        updated_at: "2026-06-01T00:00:00.000Z",
        row_data: {
          id: "APP-A",
          email: RESIDENT.email,
          bucket: "approved",
          stage: "Approved",
          property: "Maple House",
          assignedPropertyId: "prop_1",
        },
      },
    ],
    manager_property_records: [
      {
        id: "prop_1",
        manager_user_id: "manager_1",
        row_data: {},
        property_data: {
          id: "prop_1",
          title: "Maple House",
          buildingName: "Maple House",
          address: "1 Maple St, Seattle, WA",
          listingSubmission: {
            v: 1,
            buildingName: "Maple House",
            address: "1 Maple St, Seattle, WA",
            zip: "98115",
            houseRulesText: "RULES-QUIET-HOURS",
            generalHouseInfo: "GENERAL-GATE-CODE-4455",
            moveInInstructions: "INSTRUCTIONS-LOCKBOX-1234",
            rooms: [],
            bathrooms: [],
            sharedSpaces: [],
            quickFacts: [],
            bundles: [],
            housePhotoDataUrls: [],
            houseInfo,
          },
        },
      },
    ],
    resident_move_in_forms: [
      { id: "FORM-1", resident_email: RESIDENT.email, status: "sent", snapshot: { name: "Move-in checklist" }, form_name: "Move-in checklist" },
    ],
  };
}

const SECRETS = ["DOORCODE-7788", "WIFIPASS-9911", "NET-OPEN-SESAME", "RULES-QUIET-HOURS", "GENERAL-GATE-CODE-4455", "INSTRUCTIONS-LOCKBOX-1234"];

describe("get_move_in_info while a move-in-details-blocking form is unsubmitted", () => {
  it("is the control: unlocked, an approved resident gets the details", async () => {
    const { ctx } = makeResidentToolCtx(houseTables(), { moveInDetailsLocked: false });
    const json = JSON.stringify(await getMoveInInfoTool.handler(ctx, {}));
    expect(json).toContain("WIFIPASS-9911");
    expect(json).toContain("DOORCODE-7788");
    expect(json).not.toContain("lockedNotice");
  });

  it("withholds Wi-Fi, door codes, instructions and rules and names the form to finish", async () => {
    const { ctx } = makeResidentToolCtx(houseTables(), { moveInDetailsLocked: true, moveInDetailsLockFormId: "FORM-1" });
    const res = (await getMoveInInfoTool.handler(ctx, {})) as {
      moveInDetailsLocked?: boolean;
      lockedNotice?: string;
      moveIn: { addressLine: string; wifiPassword: unknown; houseDetails: unknown[]; amenities: unknown[]; instructions: unknown; houseRules: unknown };
    };
    const json = JSON.stringify(res);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    expect(res.moveInDetailsLocked).toBe(true);
    expect(res.lockedNotice).toContain("Move-in checklist");
    expect(res.moveIn.wifiPassword).toBeNull();
    expect(res.moveIn.houseDetails).toEqual([]);
    expect(res.moveIn.amenities).toEqual([]);
    expect(res.moveIn.instructions).toBeNull();
    expect(res.moveIn.houseRules).toBeNull();
    // Placement is not locked content.
    expect(res.moveIn.addressLine).toContain("Maple");
  });

  it("a failed forms read locks too, with a retry message that names no form", async () => {
    const { ctx } = makeResidentToolCtx(houseTables(), { moveInDetailsLocked: true, moveInDetailsLockFormId: null, moveInDetailsLockReadFailed: true });
    const res = (await getMoveInInfoTool.handler(ctx, {})) as { lockedNotice?: string };
    const json = JSON.stringify(res);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    expect(res.lockedNotice).toMatch(/could not check/i);
  });

  it("fails closed when a context carries no flag at all", async () => {
    const { ctx } = makeResidentToolCtx(houseTables(), { moveInDetailsLocked: undefined as unknown as boolean });
    const json = JSON.stringify(await getMoveInInfoTool.handler(ctx, {}));
    for (const secret of SECRETS) expect(json).not.toContain(secret);
  });
});

describe("moveInDetailsLockFromBlocking (what the context builders derive from the access state's own read)", () => {
  it("locks on a pending block, names the form, and locks with no form when the read failed or is absent", async () => {
    const { moveInDetailsLockFromBlocking } = await import("@/lib/tools/resident-context");
    expect(moveInDetailsLockFromBlocking({ moveInDetails: false, leaseSigning: false, approval: false })).toEqual({
      moveInDetailsLocked: false,
      moveInDetailsLockFormId: null,
      moveInDetailsLockReadFailed: false,
    });
    expect(
      moveInDetailsLockFromBlocking({ moveInDetails: true, leaseSigning: false, approval: false, formIds: { moveInDetails: "F1" } }),
    ).toEqual({ moveInDetailsLocked: true, moveInDetailsLockFormId: "F1", moveInDetailsLockReadFailed: false });
    expect(moveInDetailsLockFromBlocking({ moveInDetails: true, leaseSigning: true, approval: true, readFailed: true })).toEqual({
      moveInDetailsLocked: true,
      moveInDetailsLockFormId: null,
      moveInDetailsLockReadFailed: true,
    });
    // An access state that never computed it (`emptyAccessState`) must lock, not open.
    expect(moveInDetailsLockFromBlocking(undefined)).toEqual({
      moveInDetailsLocked: true,
      moveInDetailsLockFormId: null,
      moveInDetailsLockReadFailed: true,
    });
  });
});

describe("loadMoveInDetailsLock (the SMS test harness, the one builder with no access state to read)", () => {
  it("locks on a sent default-blocking form, unlocks when it is submitted, and locks on a failed read", async () => {
    const { loadMoveInDetailsLock } = await import("@/lib/tools/resident-context");
    const sentRows = [{ id: "F1", form_id: null, status: "sent", sent_at: "2026-06-01", resident_user_id: null, snapshot_kind: "intake", snapshot_blocks: null }];
    const dbWith = (result: unknown) => ({
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "neq"]) q[m] = () => q;
        q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
        return q;
      },
    });
    const locked = await loadMoveInDetailsLock(dbWith({ data: sentRows, error: null }) as never, { email: "a@b.test", userId: "u1" });
    expect(locked).toMatchObject({ moveInDetailsLocked: true, moveInDetailsLockFormId: "F1", moveInDetailsLockReadFailed: false });
    const open = await loadMoveInDetailsLock(dbWith({ data: [{ ...sentRows[0], status: "submitted" }], error: null }) as never, { email: "a@b.test", userId: "u1" });
    expect(open.moveInDetailsLocked).toBe(false);
    const failed = await loadMoveInDetailsLock(dbWith({ data: null, error: { code: "500", message: "boom" } }) as never, { email: "a@b.test" });
    expect(failed).toMatchObject({ moveInDetailsLocked: true, moveInDetailsLockFormId: null, moveInDetailsLockReadFailed: true });
    const thrown = await loadMoveInDetailsLock({ from: () => { throw new Error("x"); } } as never, { email: "a@b.test" });
    expect(thrown.moveInDetailsLocked).toBe(true);
  });
});


/**
 * EVIDENCE HARNESS. The resident assistant's answer IS the end-user surface here, so a reviewer should
 * be able to read what the agent was handed in each state rather than infer it from assertions above.
 * Writes the transcript when `EVIDENCE_DIR` asks for it; the assertions run either way.
 */
describe("resident assistant transcript — asking the agent for the move-in details", () => {
  it("prints what get_move_in_info returns while the form blocks it, after a failed read, and once it is open", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const lines: string[] = [];
    const say = (text = "") => lines.push(text);
    const show = async (label: string, overrides: Record<string, unknown>) => {
      const { ctx } = makeResidentToolCtx(houseTables(), overrides as never);
      const res = (await getMoveInInfoTool.handler(ctx, {})) as Record<string, unknown>;
      say(label);
      say(`    tool: get_move_in_info   (ctx: ${JSON.stringify(overrides)})`);
      say(
        JSON.stringify(res, null, 2)
          .split("\n")
          .map((l) => `    <- ${l}`)
          .join("\n"),
      );
      const leaked = SECRETS.filter((secret) => JSON.stringify(res).includes(secret));
      say(`    secrets present in the answer: ${leaked.length === 0 ? "none" : leaked.join(", ")}`);
      say();
      return { res, leaked };
    };

    say("=".repeat(96));
    say("resident assistant — get_move_in_info, real handler, real redactMoveInDetails");
    say("=".repeat(96));
    say();
    say("The house carries: door code DOORCODE-7788, Wi-Fi NET-OPEN-SESAME / WIFIPASS-9911,");
    say("house rules RULES-QUIET-HOURS, general info GENERAL-GATE-CODE-4455, instructions INSTRUCTIONS-LOCKBOX-1234.");
    say('A form named "Move-in checklist" was sent to this resident and is still unsubmitted.');
    say();

    say('  resident: "what\'s the wifi password and the door code?"');
    const locked = await show("  [1] a form that blocks Move-in details is unsubmitted", {
      moveInDetailsLocked: true,
      moveInDetailsLockFormId: "FORM-1",
    });
    expect(locked.leaked).toEqual([]);

    const failed = await show("  [2] the forms read itself failed (fail closed, names no form)", {
      moveInDetailsLocked: true,
      moveInDetailsLockFormId: null,
      moveInDetailsLockReadFailed: true,
    });
    expect(failed.leaked).toEqual([]);

    const absent = await show("  [3] a context built without the flag at all", { moveInDetailsLocked: undefined });
    expect(absent.leaked).toEqual([]);

    const open = await show("  [4] control: the form is submitted, the lock is open", { moveInDetailsLocked: false });
    expect(open.leaked).toContain("DOORCODE-7788");
    expect(open.leaked).toContain("WIFIPASS-9911");
    expect(open.leaked).toContain("RULES-QUIET-HOURS");
    say("=".repeat(96));

    const dir = process.env.EVIDENCE_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "resident-assistant-move-in-lock-transcript.txt"), `${lines.join("\n")}\n`, "utf8");
    }
    console.log(lines.join("\n"));
  });
});
