import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  GENERIC_ASSISTANT_ERROR_DEAD_END,
  formatAgentChatUserError,
  formatSmsAgentTurnError,
  isAssistantBillingFailure,
  userFacingAssistantError,
} from "@/lib/agent/assistant-turn-error";
import { messagesNeedVisionModel } from "@/lib/agent/assistant-vision-turn";

describe("formatAgentChatUserError", () => {
  it("never returns the banned generic dead-end string", () => {
    const cases: unknown[] = [
      new Error("boom"),
      new Anthropic.APIError(500, undefined, "server error", undefined),
      new Anthropic.APIError(429, undefined, "rate limited", undefined),
      new Anthropic.APIError(400, undefined, "prompt is too long: tokens", undefined),
    ];
    for (const err of cases) {
      expect(formatAgentChatUserError(err).message).not.toBe(GENERIC_ASSISTANT_ERROR_DEAD_END);
      expect(formatAgentChatUserError(err).message.length).toBeGreaterThan(20);
      expect(userFacingAssistantError(err).message).toBe(formatAgentChatUserError(err).message);
    }
  });

  it("maps rate limits to 429", () => {
    const err = new Anthropic.APIError(429, undefined, "rate limited", undefined);
    expect(formatAgentChatUserError(err).httpStatus).toBe(429);
  });

  // The provider stamps `invalid_request_error` into the message of every 400,
  // so a mapping that keys on "invalid" reports every failure — billing, auth,
  // a malformed tool schema — as an attachment problem. This is the verbatim
  // body the live API returned for a spent credit balance; it is what made the
  // assistant tell managers to remove a file they never attached (F-AI-1/2).
  const SPENT_CREDIT_400 =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

  const ATTACHMENT_COPY = /attachment could not be processed/i;

  it("does not blame an attachment for a spent credit balance", () => {
    const err = new Anthropic.APIError(400, undefined, SPENT_CREDIT_400, undefined);
    const { message } = formatAgentChatUserError(err);
    expect(message).not.toMatch(ATTACHMENT_COPY);
    expect(message).toMatch(/service account/i);
    expect(isAssistantBillingFailure(err)).toBe(true);
    expect(formatSmsAgentTurnError(err)).toBe(
      "Sorry, I couldn't reply just now. Please try again in a minute.",
    );
  });

  it("does not blame an attachment for unrelated 400s", () => {
    const unrelated = [
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.0.custom.input_schema: unexpected keyword"}}',
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: roles must alternate"}}',
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be greater than 0"}}',
    ];
    for (const raw of unrelated) {
      const err = new Anthropic.APIError(400, undefined, raw, undefined);
      expect(formatAgentChatUserError(err).message).not.toMatch(ATTACHMENT_COPY);
    }
  });

  it("still reports a genuine media failure as an attachment problem", () => {
    const err = new Anthropic.APIError(
      400,
      undefined,
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.1.image.source.base64: image exceeds 5 MB maximum"}}',
      undefined,
    );
    expect(formatAgentChatUserError(err).message).toMatch(ATTACHMENT_COPY);
  });

  it("still reports context exhaustion as a too-long conversation", () => {
    const err = new Anthropic.APIError(
      400,
      undefined,
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
      undefined,
    );
    expect(formatAgentChatUserError(err).message).toMatch(/conversation is too long/i);
  });
});

describe("messagesNeedVisionModel", () => {
  it("detects image blocks on the user turn", () => {
    expect(
      messagesNeedVisionModel([
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } },
          ],
        },
      ]),
    ).toBe(true);
  });
});
