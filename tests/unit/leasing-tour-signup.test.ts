// A prospect on the PropLane line who asks to tour or apply and has no account is offered the existing sign-up by text
// (not a link into a sign-in wall); finishing it texts the sign-in link and the tour page for the home they asked about.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { linksFakeDb } from "../helpers/links-fake-db";

vi.mock("server-only", () => ({}));
const rate = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: rate.ok })), clientIpFrom: () => "1.1.1.1" }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ phoneOwners: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/signup/provision.server", () => ({ provisionSmsSignupAccount: vi.fn() }));
vi.mock("@/lib/one-number/signup/sign-in-link.server", () => ({ mintPhoneSignInLink: vi.fn(async () => null) }));

import { handleSmsSignupText, startTourSignup, type SignupDeps } from "@/lib/one-number/signup/flow.server";
import type { SmsSignupInput, SmsSignupResult } from "@/lib/one-number/signup/provision.server";

const PHONE = "+12065550143";
const T0 = new Date("2026-11-10T20:00:00Z");
const PROPERTY = "prop_4709a";
const LINK = "https://proplane.ai/auth/confirm?token_hash=HASH&type=magiclink";

function world(over: Partial<SignupDeps> = {}) {
  const f = linksFakeDb();
  const state = { sid: 0, owners: [] as string[] };
  const provisioned: SmsSignupInput[] = [];
  const deps: SignupDeps = {
    now: () => T0,
    origin: "https://proplane.ai",
    findOwners: async () => state.owners,
    provision: async (_db, input): Promise<SmsSignupResult> => {
      provisioned.push(input);
      return { ok: true, userId: "user-1", email: "x@phone.proplane.invalid" };
    },
    signInLink: async () => LINK,
    ...over,
  };
  const say = async (body: string) => {
    state.sid += 1;
    const turn = await handleSmsSignupText(f.db, { phoneE164: PHONE, body, messageSid: `SM${state.sid}` }, deps);
    return turn.handled ? turn.reply : null;
  };
  return { f, state, deps, provisioned, say };
}

beforeEach(() => {
  rate.ok = true;
});

describe("startTourSignup: the leasing agent's way into the existing sign-up", () => {
  it("starts a resident sign-up that asks only the name, skips 'which home do you live in', and creates nothing yet", async () => {
    const w = world();
    const started = await startTourSignup(w.f.db, { phoneE164: PHONE, propertyId: PROPERTY }, w.deps);
    expect(started).toMatchObject({ started: true });
    expect(started.started && started.reply).toContain("full name");
    expect(w.provisioned).toHaveLength(0);
    expect(await w.say("Maya Chen")).toContain("email"); // name -> (no home question) -> email
  });

  it("finishing the code echo creates the account and texts the sign-in link AND that home's tour page", async () => {
    const w = world();
    await startTourSignup(w.f.db, { phoneE164: PHONE, propertyId: PROPERTY }, w.deps);
    await w.say("Maya Chen");
    const code = /code: (\d{6})/.exec((await w.say("skip")) ?? "")?.[1] ?? "";
    expect(code).toMatch(/^\d{6}$/);
    const done = await w.say(code);
    expect(w.provisioned).toEqual([expect.objectContaining({ role: "resident", phoneE164: PHONE })]);
    expect(done).toContain(LINK);
    expect(done).toContain(`https://proplane.ai/resident/tour/schedule?propertyId=${PROPERTY}`);
    expect(done).not.toContain("property manager will connect");
  });

  it("a wrong code creates nothing", async () => {
    const w = world();
    await startTourSignup(w.f.db, { phoneE164: PHONE, propertyId: PROPERTY }, w.deps);
    await w.say("Maya Chen");
    await w.say("skip");
    await w.say("000000");
    expect(w.provisioned).toHaveLength(0);
  });

  it("never starts for a phone that already has an account: the agent keeps the ordinary links", async () => {
    const w = world();
    w.state.owners = ["user-9"];
    expect(await startTourSignup(w.f.db, { phoneE164: PHONE, propertyId: PROPERTY }, w.deps)).toEqual({ started: false, reason: "has_account" });
  });

  it("an unreadable owner check starts nothing", async () => {
    const w = world({ findOwners: async () => { throw new Error("down"); } });
    expect(await startTourSignup(w.f.db, { phoneE164: PHONE, propertyId: PROPERTY }, w.deps)).toEqual({ started: false, reason: "unavailable" });
  });

  it("does not overwrite a sign-up already in progress", async () => {
    const w = world();
    await startTourSignup(w.f.db, { phoneE164: PHONE, propertyId: PROPERTY }, w.deps);
    expect(await startTourSignup(w.f.db, { phoneE164: PHONE, propertyId: "other" }, w.deps)).toEqual({ started: false, reason: "in_progress" });
  });

  it("is rate limited like any sign-up start, and refuses a non-US number", async () => {
    const w = world();
    rate.ok = false;
    expect(await startTourSignup(w.f.db, { phoneE164: PHONE, propertyId: PROPERTY }, w.deps)).toEqual({ started: false, reason: "busy" });
    rate.ok = true;
    expect(await startTourSignup(w.f.db, { phoneE164: "+442079460958", propertyId: PROPERTY }, w.deps)).toEqual({ started: false, reason: "unavailable" });
  });
});

describe("the leasing agent offers sign-up instead of a dead link", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("registers start_prospect_signup on the SMS registry and drops it from email and channel turns", () => {
    expect(read("src/lib/tools/index.ts")).toMatch(/leasingSmsAgentRegistry = buildRegistry\(\[[\s\S]*startProspectSignupTool/);
    expect(read("src/lib/agent/leasing-email-agent.server.ts")).toContain("startProspectSignupTool.name");
  });

  it("the tool only runs for the SMS channel on the PropLane line, reading the phone from the turn, never the model", () => {
    const tool = read("src/lib/tools/domains/leasing-sms.ts");
    const body = tool.slice(tool.indexOf("export const startProspectSignupTool"), tool.indexOf("export function proplaneSiteLinks"));
    expect(body).toContain('scope.channel !== "sms"');
    expect(body).toContain("isServiceCatalog(ctx)");
    expect(body).toContain("ctx.leasingScope");
    expect(body).toContain("loadResolvableListing(ctx, input.propertyId)");
    expect(body).not.toMatch(/phone:\s*z\./);
  });

  it("the prompt sends the tool's reply and invents no URL", () => {
    const prompt = read("src/lib/agent/leasing-sms-system-prompt.ts");
    expect(prompt).toContain("start_prospect_signup");
    expect(prompt).toContain("send its reply text exactly as written and no link");
    expect(prompt).toContain("Never write a sign-in link, a sign-up link or a tour page address yourself");
    expect(prompt).toContain("If it returns started:false");
  });
});
