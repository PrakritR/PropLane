import { describe, expect, it } from "vitest";
import {
  assessVercelEnvironmentNames,
  expectedActivationForPhase,
  inspectSmsCutoverEnvironment,
  parseVercelEnvironmentNames,
  validateTwilioProviderEnvironment,
} from "../../scripts/lib/sms-cutover-config.mjs";

function sid(prefix: string, character = "1") {
  return `${prefix}${character.repeat(32)}`;
}

function validEnvironment() {
  return {
    TWILIO_ACCOUNT_SID: sid("AC"),
    TWILIO_AUTH_TOKEN: "a".repeat(32),
    TWILIO_API_KEY_SID: sid("SK"),
    TWILIO_API_KEY_SECRET: "b".repeat(32),
    TWILIO_MESSAGING_SERVICE_SID: sid("MG"),
    TWILIO_VERIFY_SERVICE_SID: sid("VA"),
    TWILIO_CAMPAIGN_SID: sid("QE"),
    TWILIO_WEBHOOK_URL: "https://prop-lane.space/api/twilio/inbound",
    TWILIO_STATUS_CALLBACK_URL: "https://prop-lane.space/api/twilio/status",
    TWILIO_EVENT_STREAMS_SINK_URL: "https://prop-lane.space/api/twilio/events",
    CRON_SECRET: "c".repeat(32),
    NEXT_PUBLIC_SUPABASE_URL: "https://productionref.supabase.co",
    AXIS_PROD_SUPABASE_REF: "productionref",
    SMS_PROVISIONING_ENABLED: "0",
    SMS_OUTBOX_SCHEDULER_READY: "0",
    SMS_RUNTIME_ENABLED: "0",
  };
}

describe("managed SMS cutover configuration", () => {
  it("parses the current Vercel table format instead of treating CLI prose as names", () => {
    const output = `
Vercel CLI 54.18.6
 name                          value       environments   created
 TWILIO_ACCOUNT_SID            Encrypted   Production     41d ago
 CRON_SECRET                   Sensitive   Production     32d ago
 SMS_RUNTIME_ENABLED           Plaintext   Production     1m ago
`;

    expect([...parseVercelEnvironmentNames(output)]).toEqual([
      "TWILIO_ACCOUNT_SID",
      "CRON_SECRET",
      "SMS_RUNTIME_ENABLED",
    ]);
  });

  it("classifies suppressed non-TTY output as unavailable instead of falsely missing every key", () => {
    const coverage = assessVercelEnvironmentNames(
      "Vercel CLI 54.18.6\nRetrieving project…\n",
      ["TWILIO_ACCOUNT_SID", "CRON_SECRET"],
    );

    expect(coverage.enumerated).toBe(false);
    expect(coverage.missing).toEqual([]);
  });

  it("keeps each rollout phase explicit and fail closed", () => {
    expect(expectedActivationForPhase("dormant")).toEqual({
      SMS_PROVISIONING_ENABLED: "0",
      SMS_OUTBOX_SCHEDULER_READY: "0",
      SMS_RUNTIME_ENABLED: "0",
    });
    expect(expectedActivationForPhase("provisioning-canary")).toEqual({
      SMS_PROVISIONING_ENABLED: "1",
      SMS_OUTBOX_SCHEDULER_READY: "1",
      SMS_RUNTIME_ENABLED: "0",
    });
    expect(expectedActivationForPhase("runtime-canary")).toEqual({
      SMS_PROVISIONING_ENABLED: "1",
      SMS_OUTBOX_SCHEDULER_READY: "1",
      SMS_RUNTIME_ENABLED: "1",
    });
  });

  it("accepts a canonical dormant production configuration without exposing values", () => {
    const result = inspectSmsCutoverEnvironment(validEnvironment(), {
      target: "production",
      phase: "dormant",
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a wrong callback path, duplicate endpoint, and non-exact activation flag", () => {
    const env = validEnvironment();
    env.TWILIO_STATUS_CALLBACK_URL = env.TWILIO_WEBHOOK_URL;
    env.SMS_RUNTIME_ENABLED = "true";
    const result = inspectSmsCutoverEnvironment(env, {
      target: "production",
      phase: "dormant",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("TWILIO_STATUS_CALLBACK_URL must end at /api/twilio/status.");
    expect(result.errors).toContain(
      "Inbound, status, and Event Streams callbacks must be three distinct URLs.",
    );
    expect(result.errors).toContain(
      "SMS_RUNTIME_ENABLED must be exactly 0 during the dormant phase.",
    );
  });

  it("rejects production credentials pointed at another origin or Supabase project", () => {
    const env = validEnvironment();
    env.TWILIO_WEBHOOK_URL = "https://preview.example.com/api/twilio/inbound";
    env.AXIS_PROD_SUPABASE_REF = "anotherproject";
    const result = inspectSmsCutoverEnvironment(env, {
      target: "production",
      phase: "dormant",
    });

    expect(result.errors).toContain(
      "TWILIO_WEBHOOK_URL must use the canonical production origin https://prop-lane.space.",
    );
    expect(result.errors).toContain(
      "NEXT_PUBLIC_SUPABASE_URL does not match AXIS_PROD_SUPABASE_REF.",
    );
  });

  it("rejects malformed provider identities before an env sync can mutate Vercel", () => {
    const env = validEnvironment();
    env.TWILIO_API_KEY_SID = sid("AC");
    env.TWILIO_CAMPAIGN_SID = "campaign";

    expect(validateTwilioProviderEnvironment(env, { target: "production" })).toEqual(
      expect.arrayContaining([
        "TWILIO_API_KEY_SID has an invalid restricted-key SID shape.",
        "TWILIO_CAMPAIGN_SID has an invalid SID shape.",
      ]),
    );
  });
});
