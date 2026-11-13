import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The voice webhooks end to end at the TwiML level: the kill switch, signature (fail closed on Vercel), routing by caller,
 * funding, consent BEFORE recording, silence and goodbye, and the pages texted after the call.
 */
const mocks = vi.hoisted(() => ({
  resolveVoiceCallRoute: vi.fn(),
  reserveVoiceCallFunding: vi.fn(),
  findVoiceCallPayer: vi.fn(),
  fundedVoiceGather: vi.fn(),
  settleCommsCreditQuantity: vi.fn(async () => undefined),
  runVoiceCallTurn: vi.fn(),
  logVoiceCallStarted: vi.fn(async () => true),
  logVoiceCallTurnNotes: vi.fn(async () => undefined),
  loadCallOfferedPages: vi.fn(async () => []),
  resolveEscalationTarget: vi.fn(),
  sendEscalationSummary: vi.fn(async () => true),
  mayRingNow: vi.fn(() => true),
  loadVoiceCallTranscript: vi.fn(async () => [{ direction: "inbound", body: "can I talk to someone about my lease" }]),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/twilio-client.server", () => ({ twilioWebhookAuthToken: () => "test-token", createTwilioRestClient: () => null }));
vi.mock("@/lib/voice/voice-call-routing.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/voice/voice-call-routing.server")>("@/lib/voice/voice-call-routing.server").catch(() => null);
  return {
    MANAGER_VOICE_UNCONFIGURED_PROMPT: "This number is not configured.",
    resolveVoiceCallRoute: mocks.resolveVoiceCallRoute,
    voiceCallLogIdentity: () => ({ managerUserId: "owner", actorUserId: "owner", actorPhone: "+13105550999", workNumber: "+12066781909", counterpartyRole: "prospect" }),
    voiceGreetingForRoute: (route: { kind: string }) => (route.kind === "prospect" ? "Thanks for calling PropLane. Which house are you asking about?" : "Hello."),
    ...(actual ? {} : {}),
  };
});
vi.mock("@/lib/comms-billing/voice-credit.server", () => ({
  VOICE_CREDIT_UNAVAILABLE: "This number cannot take calls right now. Please try again later.",
  reserveVoiceCallFunding: mocks.reserveVoiceCallFunding,
  findVoiceCallPayer: mocks.findVoiceCallPayer,
  fundedVoiceGather: mocks.fundedVoiceGather,
}));
vi.mock("@/lib/comms-billing/wallet.server", () => ({ settleCommsCreditQuantity: mocks.settleCommsCreditQuantity }));
vi.mock("@/lib/voice/log-voice-call-notes.server", () => ({ logVoiceCallStarted: mocks.logVoiceCallStarted, logVoiceCallTurnNotes: mocks.logVoiceCallTurnNotes }));
vi.mock("@/lib/voice/voice-call-turn.server", () => ({
  runVoiceCallTurn: mocks.runVoiceCallTurn,
  queueBrowseLinkForCall: vi.fn(async () => undefined),
  VOICE_TURN_FALLBACK_REPLY: "Sorry, I could not process that right now. Please try again or text this number instead.",
}));
vi.mock("@/lib/voice/voice-call-links.server", () => ({ loadCallOfferedPages: mocks.loadCallOfferedPages }));
vi.mock("@/lib/voice/voice-transfer.server", () => ({
  callerWantsHuman: (speech: string) => /\b(person|human|manager|someone)\b/i.test(speech),
  transferUnavailablePrompt: () => "You are already the account owner on this line.",
}));
vi.mock("@/lib/voice/voice-escalation.server", () => ({
  callerIsFrustrated: (speech: string) => /useless|not helping/i.test(speech),
  escalationSummaryText: () => "Call back +13105550999: a prospect asked for a person.",
  escalationIsUrgent: (reason: string) => reason === "emergency",
  mayRingNow: mocks.mayRingNow,
  resolveEscalationTarget: mocks.resolveEscalationTarget,
  sendEscalationSummary: mocks.sendEscalationSummary,
}));
vi.mock("@/lib/voice/voice-call-summary.server", () => ({ loadVoiceCallTranscript: mocks.loadVoiceCallTranscript }));

import { POST as inbound } from "@/app/api/twilio/voice/inbound/route";
import { POST as turn } from "@/app/api/twilio/voice/turn/route";

const CALL = "CA0123456789abcdef0123456789abcdef";
const PAYER = { ownerId: "owner", workspaceId: "ws", allowUnfunded: false };
const PROSPECT = {
  ok: true,
  managerId: "owner",
  workspaceId: "ws",
  workNumber: "+12066781909",
  line: "shared",
  billing: { primary: { ownerId: "owner", workspaceId: "ws" }, platform: null },
  route: { kind: "prospect" },
};

function form(params: Record<string, string>, url = "https://proplane.ai/api/twilio/voice/inbound") {
  return new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: "+13105550999", To: "+12066781909", CallSid: CALL, ...params }).toString() });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MANAGER_VOICE_AGENT_ENABLED", "1");
  vi.stubEnv("TWILIO_VOICE_RECORDING", "");
  mocks.resolveVoiceCallRoute.mockResolvedValue(PROSPECT);
  mocks.reserveVoiceCallFunding.mockResolvedValue(PAYER);
  mocks.findVoiceCallPayer.mockResolvedValue(PAYER);
  mocks.mayRingNow.mockReturnValue(true);
  mocks.resolveEscalationTarget.mockResolvedValue({ toPhone: "+12065550142", firstName: "Marcus", via: "covering_member", userId: "staff-1" });
  mocks.fundedVoiceGather.mockImplementation(async (_db: unknown, a: { prompt: string; phase: string }) => `<Gather phase="${a.phase}"><Say>${a.prompt}</Say></Gather>`);
});
afterEach(() => vi.unstubAllEnvs());

describe("inbound call", () => {
  it("flag off: the disabled line and a hangup, and nothing is routed or reserved", async () => {
    vi.stubEnv("MANAGER_VOICE_AGENT_ENABLED", "");
    const xml = await (await inbound(form({}))).text();
    expect(xml).toContain("The voice assistant is not enabled yet");
    expect(xml).toContain("<Hangup/>");
    expect(mocks.resolveVoiceCallRoute).not.toHaveBeenCalled();
    expect(mocks.reserveVoiceCallFunding).not.toHaveBeenCalled();
  });

  it("flag on: routes the caller, reserves funding, and greets with a speech Gather", async () => {
    const xml = await (await inbound(form({}))).text();
    expect(mocks.resolveVoiceCallRoute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fromPhone: "+13105550999", toPhone: "+12066781909", callSid: CALL }));
    expect(xml).toContain("Which house are you asking about?");
    expect(xml).not.toContain("<Hangup/>");
    expect(mocks.logVoiceCallStarted).toHaveBeenCalled();
  });

  it("fails closed on Vercel without a signature", async () => {
    vi.stubEnv("VERCEL", "1");
    const res = await inbound(form({}));
    expect(res.status).toBe(403);
    expect(mocks.resolveVoiceCallRoute).not.toHaveBeenCalled();
  });

  it("an unconfigured number is told so", async () => {
    mocks.resolveVoiceCallRoute.mockResolvedValue({ ok: false, reason: "unconfigured" });
    const xml = await (await inbound(form({}))).text();
    expect(xml).toContain("This number is not configured.");
    expect(xml).toContain("<Hangup/>");
  });

  it("a workspace with a number of its own, or a vendor, is told once and the call ends", async () => {
    mocks.resolveVoiceCallRoute.mockResolvedValue({ ...PROSPECT, route: { kind: "redirect", reply: "5259 Brooklyn texts from (206) 555-0111. Please text that number." } });
    const xml = await (await inbound(form({}))).text();
    expect(xml).toContain("Please text that number.");
    expect(xml).toContain("<Hangup/>");
    expect(mocks.reserveVoiceCallFunding).not.toHaveBeenCalled();
  });

  it("credit refusal: a caller nobody can fund hears so and the call ends, before any model work", async () => {
    mocks.reserveVoiceCallFunding.mockResolvedValue(null);
    const xml = await (await inbound(form({}))).text();
    expect(xml).toContain("This number cannot take calls right now.");
    expect(xml).toContain("<Hangup/>");
    expect(mocks.fundedVoiceGather).not.toHaveBeenCalled();
  });

  it("recording on: the consent line comes first and nothing is recorded yet", async () => {
    vi.stubEnv("TWILIO_VOICE_RECORDING", "1");
    const xml = await (await inbound(form({}))).text();
    expect(xml).toContain('phase="consent"');
    expect(xml).toContain("may be recorded");
    expect(xml).not.toContain("<Recording");
    expect(mocks.logVoiceCallStarted).not.toHaveBeenCalled();
  });
});

const TURN_URL = (phase: string, extra = "") => `https://proplane.ai/api/twilio/voice/turn?phase=${phase}&turn=${"a".repeat(32)}${extra}`;

describe("consent and turns", () => {
  it("a yes starts the recording and then the greeting; the recording is in the same response as the yes, never before it", async () => {
    vi.stubEnv("TWILIO_VOICE_RECORDING", "1");
    const xml = await (await turn(form({ SpeechResult: "yes" }, TURN_URL("consent"), ))).text();
    expect(xml.indexOf("<Start><Recording")).toBeGreaterThanOrEqual(0);
    expect(xml.indexOf("<Start><Recording")).toBeLessThan(xml.indexOf("<Gather"));
    expect(mocks.logVoiceCallStarted).toHaveBeenCalled();
  });

  it("'okay' counts as a yes", async () => {
    vi.stubEnv("TWILIO_VOICE_RECORDING", "1");
    expect(await (await turn(form({ SpeechResult: "okay" }, TURN_URL("consent")))).text()).toContain("<Recording");
  });

  it("a no ends the call with no recording and settles the recording hold to zero", async () => {
    vi.stubEnv("TWILIO_VOICE_RECORDING", "1");
    const xml = await (await turn(form({ SpeechResult: "no" }, TURN_URL("consent")))).text();
    expect(xml).not.toContain("<Recording");
    expect(xml).toContain("<Hangup/>");
    expect(mocks.settleCommsCreditQuantity).toHaveBeenCalledWith(expect.anything(), "owner", `voice_recording_minute:${CALL}`, 0);
  });

  it("silence on the consent line is asked again once, then it ends", async () => {
    vi.stubEnv("TWILIO_VOICE_RECORDING", "1");
    const again = await (await turn(form({}, TURN_URL("consent")))).text();
    expect(again).toContain("it okay if this call is recorded");
    expect(again).not.toContain("<Hangup/>");
    const end = await (await turn(form({}, TURN_URL("consent", "&attempt=1")))).text();
    expect(end).toContain("<Hangup/>");
    expect(end).not.toContain("<Recording");
  });

  it("silence during the call is re-asked once, then a goodbye that promises the texted links", async () => {
    const reask = await (await turn(form({}, TURN_URL("agent", "&attempt=1")))).text();
    expect(reask).toContain("I did not catch that");
    mocks.resolveEscalationTarget.mockResolvedValue(null);
    mocks.loadCallOfferedPages.mockResolvedValue([{ kind: "tour", url: "https://proplane.ai/rent/tours-contact?propertyId=x" }] as never);
    const end = await (await turn(form({}, TURN_URL("agent", "&attempt=2")))).text();
    expect(end).toContain("I will text you those links now");
    expect(end).toContain("<Hangup/>");
  });

  it("a closing line gets a graceful goodbye, not another question", async () => {
    const xml = await (await turn(form({ SpeechResult: "no, that's all, thanks" }, TURN_URL("agent")))).text();
    expect(xml).toContain("Goodbye.");
    expect(xml).toContain("<Hangup/>");
    expect(mocks.runVoiceCallTurn).not.toHaveBeenCalled();
  });

  it("a spoken answer is followed by 'Anything else?'", async () => {
    mocks.runVoiceCallTurn.mockResolvedValue({ reply: "Rooms run $1,000 to $1,200 a month. I will text you the link.", offered: 2 });
    const xml = await (await turn(form({ SpeechResult: "how much is a room" }, TURN_URL("agent")))).text();
    expect(xml).toContain("Rooms run $1,000 to $1,200 a month.");
    expect(xml).toContain("Anything else?");
    expect(mocks.runVoiceCallTurn).toHaveBeenCalledWith(expect.objectContaining({ speechResult: "how much is a room", payer: PAYER }));
  });

  it("when the agent has nothing, a prospect is promised a text and the call ends", async () => {
    mocks.runVoiceCallTurn.mockResolvedValue({ reply: null, offered: 0 });
    mocks.resolveEscalationTarget.mockResolvedValue(null);
    const xml = await (await turn(form({ SpeechResult: "tell me about the rooms" }, TURN_URL("agent")))).text();
    expect(xml).toContain("I will text you a link");
    expect(xml).toContain("<Hangup/>");
  });

  it("a call nobody funded is ended, not answered", async () => {
    mocks.findVoiceCallPayer.mockResolvedValue(null);
    const xml = await (await turn(form({ SpeechResult: "hello" }, TURN_URL("agent")))).text();
    expect(xml).toContain("cannot take calls");
    expect(mocks.runVoiceCallTurn).not.toHaveBeenCalled();
  });

  it("an ambiguous caller is asked which home, once", async () => {
    mocks.resolveVoiceCallRoute.mockResolvedValue({ ...PROSPECT, route: { kind: "ambiguous", candidates: [], question: "Is this about 5257 Brooklyn or 5259 Brooklyn?" } });
    const asked = await (await turn(form({ SpeechResult: "hi" }, TURN_URL("agent")))).text();
    expect(asked).toContain("Is this about 5257 Brooklyn or 5259 Brooklyn?");
    const gaveUp = await (await turn(form({ SpeechResult: "I do not know" }, TURN_URL("agent", "&attempt=1")))).text();
    expect(gaveUp).toContain("A teammate will text you");
    expect(gaveUp).toContain("<Hangup/>");
  });
});

describe("a live person for a call the assistant cannot finish", () => {
  it("asking for a person rings the resolved person, from the line's own number, for a short ring, with the action back to the turn route", async () => {
    const xml = await (await turn(form({ SpeechResult: "can I talk to a person" }, TURN_URL("agent")))).text();
    expect(xml).toContain("One moment, connecting you to Marcus.");
    expect(xml).toMatch(/<Dial [^>]*callerId="\+12066781909"[^>]*timeout="20"[^>]*action="[^"]*phase=escalation[^"]*reason=asked_for_person[^"]*"/);
    expect(xml).toContain("+12065550142</Number>");
    expect(xml).toContain("/api/twilio/voice/whisper?kind=prospect");
    expect(mocks.runVoiceCallTurn).not.toHaveBeenCalled();
    expect(mocks.logVoiceCallTurnNotes).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reply: "Connecting the caller to Marcus." }));
  });

  it("an emergency says the safety line and rings, even in quiet hours", async () => {
    mocks.mayRingNow.mockImplementation(((reason: string) => reason === "emergency") as never);
    const xml = await (await turn(form({ SpeechResult: "there is a gas leak in the kitchen" }, TURN_URL("agent")))).text();
    expect(xml).toMatch(/911|danger|emergency/i);
    expect(xml).toContain("<Dial");
    expect(mocks.mayRingNow).toHaveBeenCalledWith("emergency");
  });

  it("a frustrated caller is handed to a person", async () => {
    const xml = await (await turn(form({ SpeechResult: "this is useless" }, TURN_URL("agent")))).text();
    expect(xml).toContain("<Dial");
  });

  it("an agent that handed the question to the manager says so, then the call is bridged", async () => {
    mocks.runVoiceCallTurn.mockResolvedValue({ reply: "That one is for the manager.", offered: 0, needsHuman: true });
    const xml = await (await turn(form({ SpeechResult: "can you waive the deposit" }, TURN_URL("agent")))).text();
    expect(xml.indexOf("That one is for the manager.")).toBeLessThan(xml.indexOf("<Dial"));
  });

  it("an agent with no answer tries a person before it gives up", async () => {
    mocks.runVoiceCallTurn.mockResolvedValue({ reply: null, offered: 0 });
    const xml = await (await turn(form({ SpeechResult: "something odd" }, TURN_URL("agent")))).text();
    expect(xml).toContain("<Dial");
  });

  it("quiet hours: a routine escalation is not rung, the caller is promised a call-back and the person is texted", async () => {
    mocks.mayRingNow.mockReturnValue(false);
    const xml = await (await turn(form({ SpeechResult: "can I talk to a person" }, TURN_URL("agent")))).text();
    expect(xml).not.toContain("<Dial");
    expect(xml).toContain("call you back first thing");
    expect(xml).toContain("anything else I can help with?");
    expect(mocks.sendEscalationSummary).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ urgent: false, callSid: CALL }));
  });

  it("nobody to ring: the caller is told the team will get the message, and the assistant carries on", async () => {
    mocks.resolveEscalationTarget.mockResolvedValue(null);
    const xml = await (await turn(form({ SpeechResult: "can I talk to a person" }, TURN_URL("agent")))).text();
    expect(xml).not.toContain("<Dial");
    expect(xml).toContain("make sure the team gets your message");
  });

  it("no answer within the ring: the assistant takes the call back, promises a call-back, and texts the person the caller's number", async () => {
    const xml = await (await turn(form({ DialCallStatus: "no-answer" }, TURN_URL("escalation", "&reason=asked_for_person")))).text();
    expect(xml).toContain("not available right now.");
    expect(xml).toContain("anything else I can help with?");
    expect(xml).toContain("call you back");
    expect(xml).not.toContain("<Hangup/>");
    expect(mocks.sendEscalationSummary).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callSid: CALL, text: expect.stringContaining("+13105550999"), urgent: false }));
    expect(mocks.logVoiceCallTurnNotes).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reply: expect.stringContaining("did not answer") }));
  });

  it("busy and failed rings fall back the same way", async () => {
    for (const status of ["busy", "failed", "canceled"]) {
      const xml = await (await turn(form({ DialCallStatus: status }, TURN_URL("escalation", "&reason=cannot_answer")))).text();
      expect(xml).toContain("call you back");
    }
  });

  it("an answered bridge that finished ends the call", async () => {
    const xml = await (await turn(form({ DialCallStatus: "completed" }, TURN_URL("escalation", "&reason=asked_for_person")))).text();
    expect(xml).toContain("<Hangup/>");
    expect(mocks.sendEscalationSummary).not.toHaveBeenCalled();
  });

  it("the manager on their own line is never bridged to themselves", async () => {
    mocks.resolveVoiceCallRoute.mockResolvedValue({ ...PROSPECT, route: { kind: "manager", identity: {} } });
    const xml = await (await turn(form({ SpeechResult: "can I talk to a person" }, TURN_URL("agent")))).text();
    expect(xml).not.toContain("<Dial");
    expect(xml).toContain("already the account owner");
  });
});
