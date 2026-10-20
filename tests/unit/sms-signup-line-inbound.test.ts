// A sign-up ask from a known account holder on the PropLane line is left to the sign-up flow (sign-in link), not answered as status.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const member = vi.hoisted(() => vi.fn(async () => ({ handled: true as const, reply: "STATUS", actorUserId: "u1" })));
const resident = vi.hoisted(() => vi.fn(async () => ({ handled: false as const })));
vi.mock("@/lib/one-number/line-member-status.server", () => ({ handleLineMemberText: member }));
vi.mock("@/lib/one-number/line-resident.server", () => ({ handleLineResidentText: resident }));
vi.mock("@/lib/service/service-catalog.server", () => ({ isPropLaneServiceLine: vi.fn(async () => true) }));

import { answerPropLaneLineText } from "@/lib/one-number/line-inbound.server";

const ask = (body: string) => answerPropLaneLineText({} as never, { lineOwnerUserId: "owner", toPhone: "+12066781909", fromPhone: "+12065550142", body, messageSid: "SM1" });

describe("answerPropLaneLineText and sign-up asks", () => {
  it("a sign-up ask is not answered here (the sign-up flow tells an account holder and sends a link)", async () => {
    expect(await ask("Hey I want to sign up as a manager")).toBeNull();
    expect(member).not.toHaveBeenCalled();
  });

  it("a status question from the same person still is", async () => {
    expect(await ask("how are my houses doing")).toMatchObject({ kind: "member", reply: "STATUS" });
  });
});
