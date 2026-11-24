// Which hat is a verified sender wearing on a text? The pure decision (`sender-context.ts`), plus the registry an
// admin by text actually gets. The first case is the production incident of Nov 24: a reply to Assistant notices
// about three PropLane-managed homes was answered from the sender's own workspace.
import { describe, expect, it } from "vitest";
import {
  decideSenderContext,
  senderQuestionText,
  type SenderContext,
  type SenderContextInput,
  type SenderHome,
  type SenderTarget,
} from "@/lib/sms/sender-context";

const NOW = Date.parse("2026-11-24T06:06:00Z");
const hours = (n: number) => n * 60 * 60 * 1000;

const mine: SenderContext = { kind: "manager", key: "manager:ws-mine", workspaceId: "ws-mine", ownerUserId: "u1", name: "My workspace", isDefault: true, isService: false, basis: "owner", viewerSeat: false };
const seattle: SenderContext = { kind: "manager", key: "manager:ws-sea", workspaceId: "ws-sea", ownerUserId: "u1", name: "PropLane Seattle", isDefault: false, isService: false, basis: "owner", viewerSeat: false };
const admin: SenderContext = {
  kind: "admin",
  key: "admin",
  workspaces: [
    { id: "ws-amb", name: "1. Ambika", ownerUserId: "svc", isDefault: true },
    { id: "ws-vin", name: "2. Vinod", ownerUserId: "svc2", isDefault: true },
  ],
};
const resident: SenderContext = { kind: "resident", key: "resident:ws-res", workspaceId: "ws-res", ownerUserId: "u9", propertyId: "p9", label: "88 Pine St" };

const home = (id: string, address: string, target: SenderTarget): SenderHome => ({ id, address, title: "", buildingName: "", neighborhood: "", target });
const HOMES: SenderHome[] = [
  home("h1", "5257 Brooklyn Ave NE, Seattle", { key: "admin", workspaceId: "ws-amb" }),
  home("h2", "5259 Brooklyn Ave NE, Seattle", { key: "admin", workspaceId: "ws-amb" }),
  home("h3", "4709A 8th Ave NE, Seattle", { key: "admin", workspaceId: "ws-amb" }),
  home("h4", "300 Cedar Way, Seattle", { key: "admin", workspaceId: "ws-vin" }),
  home("h5", "12 Elm St, Louisville", { key: "manager:ws-mine" }),
  home("h6", "88 Pine St, Seattle", { key: "resident:ws-res" }),
];

const base = (over: Partial<SenderContextInput>): SenderContextInput => ({
  body: "hello",
  messageSid: "SM1",
  contexts: [mine, seattle, admin, resident],
  sticky: null,
  pending: null,
  numberDefault: null,
  now: NOW,
  loadHomes: async () => HOMES,
  loadNotice: async () => null,
  ...over,
});

describe("sender context: one decision per text", () => {
  it("the incident: three homes of a staffed service workspace go to admin over THAT workspace, not the sender's own", async () => {
    const d = await decideSenderContext(
      base({
        body: "Which rooms are available and what are the status for tomorrow for check-ins etc … 4709A 5259 5257",
        numberDefault: { key: "manager:ws-mine" },
        loadNotice: async () => ({ workspaceId: "ws-mine", at: NOW - 1000 }),
      }),
    );
    expect(d).toMatchObject({ kind: "run", source: "named", target: { key: "admin", workspaceId: "ws-amb" }, tag: "Admin · 1. Ambika:" });
  });

  it("homes across several workspaces they staff are the admin context (the workspace is then asked, never guessed)", async () => {
    const d = await decideSenderContext(base({ body: "status on 5257 Brooklyn and 300 Cedar" }));
    expect(d).toMatchObject({ kind: "run", target: { key: "admin" } });
    expect((d as { target: SenderTarget }).target.workspaceId).toBeUndefined();
  });

  it("a home they rent AND a home they run in one text is mixed: asked, not guessed", async () => {
    const d = await decideSenderContext(base({ body: "compare 88 Pine St and 5257 Brooklyn" }));
    expect(d.kind).toBe("reply");
  });

  it("a home in their own workspace resolves to that workspace", async () => {
    const d = await decideSenderContext(base({ body: "who is behind on 12 Elm St", sticky: { target: { key: "resident:ws-res" }, at: NOW - 1000 } }));
    expect(d).toMatchObject({ kind: "run", target: { key: "manager:ws-mine" }, source: "named" });
  });

  it("an ambiguous text is ONE question that lists only the roles they hold, and holds the text", async () => {
    const d = await decideSenderContext(base({ contexts: [mine, resident, admin], body: "what is going on today?", messageSid: "SM7" }));
    expect(d.kind).toBe("reply");
    if (d.kind !== "reply") return;
    expect(d.text).toBe("Is this about your manager workspace, your home as a resident, or PropLane admin? Reply 1 Manager · 2 Resident · 3 Admin");
    expect(d.pending).toMatchObject({ body: "what is going on today?", messageSid: "SM7" });
    expect(d.pending?.options.map((o) => o.key)).toEqual(["manager:ws-mine", "resident:ws-res", "admin"]);
  });

  it("the question names the workspaces when they hold several, and never offers a role they lack", () => {
    expect(senderQuestionText([mine, seattle, resident])).toBe(
      "Is this about one of your manager workspaces, or your home as a resident? Reply 1 Manager (My workspace) · 2 Manager (PropLane Seattle) · 3 Resident",
    );
    expect(senderQuestionText([mine, resident])).not.toMatch(/admin/i);
  });

  it('"2" answers the question: the held text runs as the resident, tagged', async () => {
    const contexts = [mine, resident, admin];
    const asked = await decideSenderContext(base({ contexts, body: "when is trash day?" }));
    if (asked.kind !== "reply" || !asked.pending) throw new Error("expected a question");
    const d = await decideSenderContext(base({ contexts, body: "2", messageSid: "SM2", pending: { ...asked.pending, at: NOW - 1000 } }));
    expect(d).toMatchObject({ kind: "run", source: "answer", target: { key: "resident:ws-res" }, body: "when is trash day?", tag: "Resident · 88 Pine St:" });
  });

  it("a role word or a workspace name answers the question too; a digit past the list is not an answer", async () => {
    const pending = { options: [{ key: "manager:ws-mine" }, { key: "manager:ws-sea" }, { key: "admin" }], body: "rent status", messageSid: "SM1", at: NOW - 1000 };
    expect(await decideSenderContext(base({ body: "admin", pending }))).toMatchObject({ kind: "run", target: { key: "admin" }, body: "rent status" });
    expect(await decideSenderContext(base({ body: "PropLane Seattle", pending }))).toMatchObject({ kind: "run", target: { key: "manager:ws-sea" } });
    // Half a name is not an answer: the question stands rather than guessing a workspace.
    expect(await decideSenderContext(base({ body: "Seattle", pending }))).not.toMatchObject({ source: "answer" });
    const out = await decideSenderContext(base({ body: "9", pending }));
    expect(out).not.toMatchObject({ source: "answer" });
  });

  it("an unanswered question goes stale after 30 minutes", async () => {
    const pending = { options: [{ key: "resident:ws-res" }, { key: "admin" }], body: "x", messageSid: "SM1", at: NOW - hours(1) };
    expect(await decideSenderContext(base({ body: "1", pending }))).not.toMatchObject({ source: "answer" });
  });

  it('"as manager" is explicit and sticky: the next plain text keeps the pick, untagged', async () => {
    const contexts = [mine, resident];
    const switched = await decideSenderContext(base({ contexts, body: "as manager" }));
    expect(switched).toMatchObject({ kind: "reply", sticky: { key: "manager:ws-mine" } });
    const withText = await decideSenderContext(base({ contexts, body: "manager: how is rent looking" }));
    expect(withText).toMatchObject({ kind: "run", source: "switch", target: { key: "manager:ws-mine" }, body: "how is rent looking", tag: "Manager:" });
    const next = await decideSenderContext(base({ contexts, body: "and the repairs?", sticky: { target: { key: "manager:ws-mine" }, at: NOW - hours(2) } }));
    expect(next).toMatchObject({ kind: "run", source: "sticky", tag: null, body: "and the repairs?" });
  });

  it('"as resident" with a trailing role, "resident:" prefixes and "switch to <workspace>" all switch', async () => {
    expect(await decideSenderContext(base({ body: "is my deposit back, as resident" }))).toMatchObject({ kind: "run", target: { key: "resident:ws-res" }, body: "is my deposit back" });
    expect(await decideSenderContext(base({ body: "switch to Ambika" }))).toMatchObject({ kind: "reply", sticky: { key: "admin", workspaceId: "ws-amb" } });
    expect(await decideSenderContext(base({ body: "switch to PropLane Seattle" }))).toMatchObject({ kind: "reply", sticky: { key: "manager:ws-sea" } });
    // A switch target that names no workspace of theirs falls through to the numbered question, never a guess.
    const unknownTarget = await decideSenderContext(base({ body: "switch to Seattle" }));
    expect(unknownTarget.kind).toBe("reply");
    if (unknownTarget.kind === "reply") expect(unknownTarget.pending?.body).toBe("switch to Seattle");
  });

  it('"as manager" with several manager workspaces asks which, holding the text; naming one settles it', async () => {
    const d = await decideSenderContext(base({ contexts: [mine, seattle, resident], body: "as manager: any vacancies?" }));
    expect(d.kind).toBe("reply");
    if (d.kind !== "reply") return;
    expect(d.pending?.options.map((o) => o.key)).toEqual(["manager:ws-mine", "manager:ws-sea"]);
    expect(d.pending?.body).toBe("any vacancies?");
    const named = await decideSenderContext(base({ contexts: [mine, seattle, resident], body: "manager: PropLane Seattle any vacancies?" }));
    expect(named).toMatchObject({ kind: "run", target: { key: "manager:ws-sea" } });
  });

  it("a platform admin who runs no workspace of their own is the manager of managed ones: \"as manager\" reaches admin", async () => {
    const d = await decideSenderContext(base({ contexts: [admin, resident], body: "as manager 5257 Brooklyn status" }));
    expect(d).toMatchObject({ kind: "run", target: { key: "admin", workspaceId: "ws-amb" } });
  });

  it("asking for a role they do not hold is refused with the menu of the roles they do", async () => {
    const d = await decideSenderContext(base({ contexts: [mine, resident], body: "as admin" }));
    expect(d.kind).toBe("reply");
    if (d.kind !== "reply") return;
    expect(d.text).toMatch(/do not see a admin account/);
    expect(d.text).not.toMatch(/3 Admin/);
  });

  it('"switch" shows the menu; its answer only switches (nothing is held)', async () => {
    const menu = await decideSenderContext(base({ contexts: [mine, resident, admin], body: "switch" }));
    expect(menu).toMatchObject({ kind: "reply", pending: { body: "" } });
    if (menu.kind !== "reply" || !menu.pending) throw new Error("expected a menu");
    const picked = await decideSenderContext(base({ contexts: [mine, resident, admin], body: "3", pending: { ...menu.pending, at: NOW - 100 } }));
    expect(picked).toMatchObject({ kind: "reply", sticky: { key: "admin" } });
  });

  // A text to a workspace's OWN work number is about that workspace: it is the one whose conversation records it and
  // whose wallet pays. An unrelated notice from the house they RENT (their landlord's rent reminder) must not move the
  // turn to that landlord's workspace, and neither must a stale pick.
  it("the workspace whose own number was texted outranks an unrelated notice and the last pick", async () => {
    const landlordNotice = { workspaceId: "ws-res", at: NOW - 60_000 };
    const onOwnNumber = await decideSenderContext(base({
      body: "how many open rooms do I have?",
      numberDefault: { key: "manager:ws-mine" },
      loadNotice: async () => landlordNotice,
    }));
    expect(onOwnNumber).toMatchObject({ kind: "run", source: "number", target: { key: "manager:ws-mine" } });

    const stickyElsewhere = await decideSenderContext(base({
      body: "how many open rooms do I have?",
      numberDefault: { key: "manager:ws-mine" },
      sticky: { target: { key: "resident:ws-res" }, at: NOW - 60_000 },
    }));
    expect(stickyElsewhere).toMatchObject({ kind: "run", source: "number", target: { key: "manager:ws-mine" } });

    // On the shared PropLane line no number names a workspace, so the notice still decides.
    const onSharedLine = await decideSenderContext(base({
      body: "how many open rooms do I have?",
      numberDefault: null,
      loadNotice: async () => landlordNotice,
    }));
    expect(onSharedLine).toMatchObject({ kind: "run", source: "notice", target: { key: "resident:ws-res" } });
  });

  it("an explicit switch, a named home and an answered question still outrank the number", async () => {
    const onOwn = { numberDefault: { key: "manager:ws-mine" } as const };
    expect(await decideSenderContext(base({ ...onOwn, body: "resident: when is my rent due" })))
      .toMatchObject({ kind: "run", source: "switch", target: { key: "resident:ws-res" }, body: "when is my rent due" });
    expect(await decideSenderContext(base({ ...onOwn, body: "status on 88 Pine St" })))
      .toMatchObject({ kind: "run", source: "named", target: { key: "resident:ws-res" } });
    const pending = { options: [{ key: "manager:ws-mine" }, { key: "resident:ws-res" }], body: "rent status", messageSid: "SM1", at: NOW - 1000 };
    expect(await decideSenderContext(base({ ...onOwn, body: "2", pending })))
      .toMatchObject({ kind: "run", source: "answer", target: { key: "resident:ws-res" }, body: "rent status" });
  });

  it("a reply to a notice inherits the notice's workspace when it is newer than the last pick", async () => {
    const notice = { workspaceId: "ws-vin", at: NOW - 60_000 };
    const fresh = await decideSenderContext(base({ body: "ok what should we do", loadNotice: async () => notice, sticky: { target: { key: "manager:ws-mine" }, at: NOW - hours(3) } }));
    expect(fresh).toMatchObject({ kind: "run", source: "notice", target: { key: "admin", workspaceId: "ws-vin" } });
    const older = await decideSenderContext(base({ body: "ok", loadNotice: async () => ({ workspaceId: "ws-vin", at: NOW - hours(5) }), sticky: { target: { key: "manager:ws-mine" }, at: NOW - hours(3) } }));
    expect(older).toMatchObject({ source: "sticky", target: { key: "manager:ws-mine" } });
  });

  it("the last pick lasts 12 hours, then the work number they texted decides, then the question", async () => {
    const stale = { target: { key: "resident:ws-res" }, at: NOW - hours(13) };
    expect(await decideSenderContext(base({ body: "hi there", sticky: stale, numberDefault: { key: "manager:ws-mine" } }))).toMatchObject({ source: "number", target: { key: "manager:ws-mine" } });
    expect((await decideSenderContext(base({ body: "hi there", sticky: stale }))).kind).toBe("reply");
  });

  it("a pick they no longer hold is dropped, never trusted", async () => {
    const gone = { target: { key: "manager:ws-removed" }, at: NOW - 1000 };
    expect((await decideSenderContext(base({ body: "hi there", sticky: gone }))).kind).toBe("reply");
    expect((await decideSenderContext(base({ body: "hi there", sticky: { target: { key: "admin", workspaceId: "ws-nope" }, at: NOW - 1000 } }))).kind).toBe("reply");
  });

  it("a sender with a single context is never asked, tagged or rerouted", async () => {
    for (const only of [mine, admin, resident]) {
      expect(await decideSenderContext(base({ contexts: [only], body: "what is going on today?" }))).toEqual({ kind: "unchanged" });
      expect(await decideSenderContext(base({ contexts: [only], body: "switch" }))).toEqual({ kind: "unchanged" });
    }
    expect(await decideSenderContext(base({ contexts: [], body: "hi" }))).toEqual({ kind: "unchanged" });
  });

  it('"switch off the heat in 5257" is an ordinary text that names a home, not a switch', async () => {
    expect(await decideSenderContext(base({ body: "switch off the heat in 5257 Brooklyn" }))).toMatchObject({ kind: "run", source: "named", body: "switch off the heat in 5257 Brooklyn" });
  });

  it("an unreadable home read adds nothing: the text falls through to the rest of the order", async () => {
    const d = await decideSenderContext(base({ body: "status 5257 Brooklyn", loadHomes: async () => { throw new Error("down"); }, numberDefault: { key: "manager:ws-mine" } }));
    expect(d).toMatchObject({ kind: "run", source: "number" });
  });
});

describe("admin by text: the registry off the PropLane line", () => {
  // Oracle: AGENTS.md § AI Agent & Tool Layer — "Admin by text reads and never writes, except on the PropLane line".
  // The pipeline marks the admin target `readOnly` whenever the text did not arrive on that line, and the registry is
  // what makes that real. A plausible wrong behaviour this rejects: a write tool stays callable off the line.
  it("holds no write tool at all when the target is read-only, and the same access keeps its writes on the line", async () => {
    const { buildManagerSmsRegistry } = await import("@/lib/tools");
    const access = { mode: "owner" as const, workspacePropertyIds: ["prop-a1"] };
    const onLine = buildManagerSmsRegistry(access as never);
    const offLine = buildManagerSmsRegistry({ ...access, readOnly: true } as never);
    expect([...onLine.values()].filter((tool) => tool.kind === "write").length).toBeGreaterThan(0);
    expect([...offLine.values()].filter((tool) => tool.kind === "write")).toEqual([]);
    expect([...offLine.values()].filter((tool) => tool.kind !== "write").length).toBeGreaterThan(0);
  });
});

describe("sender context: fails closed", () => {
  it("an unreadable database changes nothing: the text keeps the context the number already proved", async () => {
    const { resolveSenderContext } = await import("@/lib/sms/sender-context.server");
    const broken = { from: () => { throw new Error("db down"); } } as never;
    expect(await resolveSenderContext(broken, { actorUserId: "u1", fromPhone: "+12065550100", body: "hi", messageSid: "SM1", numberWorkspaceId: null })).toEqual({ kind: "unchanged" });
  });
});
