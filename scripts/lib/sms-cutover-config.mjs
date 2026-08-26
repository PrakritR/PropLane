const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

export const SMS_CUTOVER_PHASES = [
  "dormant",
  "scheduler-ready",
  "provisioning-canary",
  "runtime-canary",
];

export const SMS_TWILIO_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_VERIFY_SERVICE_SID",
  "TWILIO_CAMPAIGN_SID",
  "TWILIO_WEBHOOK_URL",
  "TWILIO_STATUS_CALLBACK_URL",
  "TWILIO_EVENT_STREAMS_SINK_URL",
];

export const SMS_FOUNDATION_KEYS = [
  ...SMS_TWILIO_KEYS,
  "CRON_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "AXIS_PROD_SUPABASE_REF",
];

export const SMS_ACTIVATION_KEYS = [
  "SMS_PROVISIONING_ENABLED",
  "SMS_OUTBOX_SCHEDULER_READY",
  "SMS_RUNTIME_ENABLED",
];

export const SMS_CALLBACK_PATHS = {
  TWILIO_WEBHOOK_URL: "/api/twilio/inbound",
  TWILIO_STATUS_CALLBACK_URL: "/api/twilio/status",
  TWILIO_EVENT_STREAMS_SINK_URL: "/api/twilio/events",
};

export function parseVercelEnvironmentNames(output) {
  const names = new Set();
  for (const rawLine of String(output ?? "").replace(ANSI_ESCAPE, "").split("\n")) {
    const match = rawLine.match(/^\s*([A-Z][A-Z0-9_]*)\s+(?:Encrypted|Sensitive|Plaintext)\b/);
    if (match) names.add(match[1]);
  }
  return names;
}

export function assessVercelEnvironmentNames(output, requiredNames) {
  const configured = parseVercelEnvironmentNames(output);
  if (configured.size === 0) {
    return { enumerated: false, configured, missing: [] };
  }
  return {
    enumerated: true,
    configured,
    missing: requiredNames.filter((key) => !configured.has(key)),
  };
}

export function normalizeSmsCutoverPhase(value) {
  const phase = String(value ?? "").trim();
  return SMS_CUTOVER_PHASES.includes(phase) ? phase : null;
}

export function expectedActivationForPhase(phase) {
  switch (phase) {
    case "scheduler-ready":
      return {
        SMS_PROVISIONING_ENABLED: "0",
        SMS_OUTBOX_SCHEDULER_READY: "1",
        SMS_RUNTIME_ENABLED: "0",
      };
    case "provisioning-canary":
      return {
        SMS_PROVISIONING_ENABLED: "1",
        SMS_OUTBOX_SCHEDULER_READY: "1",
        SMS_RUNTIME_ENABLED: "0",
      };
    case "runtime-canary":
      return {
        SMS_PROVISIONING_ENABLED: "1",
        SMS_OUTBOX_SCHEDULER_READY: "1",
        SMS_RUNTIME_ENABLED: "1",
      };
    case "dormant":
    default:
      return {
        SMS_PROVISIONING_ENABLED: "0",
        SMS_OUTBOX_SCHEDULER_READY: "0",
        SMS_RUNTIME_ENABLED: "0",
      };
  }
}

function validSid(value, prefixes) {
  const pattern = new RegExp(`^(?:${prefixes.join("|")})[A-Za-z0-9]{32}$`);
  return pattern.test(String(value ?? "").trim());
}

function projectRef(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return "";
    return parsed.hostname.endsWith(".supabase.co") ? parsed.hostname.split(".")[0] ?? "" : "";
  } catch {
    return "";
  }
}

function validateCallbackUrl(key, rawValue, target) {
  const errors = [];
  try {
    const value = new URL(String(rawValue ?? "").trim());
    if (value.protocol !== "https:") errors.push(`${key} must use HTTPS.`);
    if (value.pathname !== SMS_CALLBACK_PATHS[key]) {
      errors.push(`${key} must end at ${SMS_CALLBACK_PATHS[key]}.`);
    }
    if (value.username || value.password || value.search || value.hash) {
      errors.push(`${key} must not include credentials, query parameters, or a fragment.`);
    }
    if (target === "production" && value.origin !== "https://prop-lane.space") {
      errors.push(`${key} must use the canonical production origin https://prop-lane.space.`);
    }
  } catch {
    errors.push(`${key} must be an absolute URL.`);
  }
  return errors;
}

export function validateTwilioProviderEnvironment(env, { target = "production" } = {}) {
  const errors = [];
  const missing = SMS_TWILIO_KEYS.filter((key) => !String(env[key] ?? "").trim());
  if (missing.length > 0) errors.push(`Missing Twilio values: ${missing.join(", ")}.`);

  if (env.TWILIO_ACCOUNT_SID && !validSid(env.TWILIO_ACCOUNT_SID, ["AC"])) {
    errors.push("TWILIO_ACCOUNT_SID has an invalid SID shape.");
  }
  if (env.TWILIO_AUTH_TOKEN && !/^[a-fA-F0-9]{32}$/.test(String(env.TWILIO_AUTH_TOKEN).trim())) {
    errors.push("TWILIO_AUTH_TOKEN has an invalid token shape.");
  }
  if (env.TWILIO_API_KEY_SID && !validSid(env.TWILIO_API_KEY_SID, ["SK"])) {
    errors.push("TWILIO_API_KEY_SID has an invalid restricted-key SID shape.");
  }
  if (env.TWILIO_API_KEY_SECRET && String(env.TWILIO_API_KEY_SECRET).trim().length < 24) {
    errors.push("TWILIO_API_KEY_SECRET is unexpectedly short.");
  }
  if (env.TWILIO_MESSAGING_SERVICE_SID && !validSid(env.TWILIO_MESSAGING_SERVICE_SID, ["MG"])) {
    errors.push("TWILIO_MESSAGING_SERVICE_SID has an invalid SID shape.");
  }
  if (env.TWILIO_VERIFY_SERVICE_SID && !validSid(env.TWILIO_VERIFY_SERVICE_SID, ["VA"])) {
    errors.push("TWILIO_VERIFY_SERVICE_SID has an invalid SID shape.");
  }
  if (env.TWILIO_CAMPAIGN_SID && !validSid(env.TWILIO_CAMPAIGN_SID, ["QE", "CM"])) {
    errors.push("TWILIO_CAMPAIGN_SID has an invalid SID shape.");
  }

  for (const [key] of Object.entries(SMS_CALLBACK_PATHS)) {
    if (env[key]) errors.push(...validateCallbackUrl(key, env[key], target));
  }
  const callbackUrls = Object.keys(SMS_CALLBACK_PATHS)
    .map((key) => String(env[key] ?? "").trim())
    .filter(Boolean);
  if (new Set(callbackUrls).size !== callbackUrls.length) {
    errors.push("Inbound, status, and Event Streams callbacks must be three distinct URLs.");
  }

  return errors;
}

/**
 * Inspect injected deployment values without returning any secret or identifier.
 * The caller receives only pass/fail findings suitable for CI/log output.
 */
export function inspectSmsCutoverEnvironment(
  env,
  { target = "production", phase = "dormant" } = {},
) {
  const errors = [];
  const warnings = [];
  const missing = SMS_FOUNDATION_KEYS.filter((key) => !String(env[key] ?? "").trim());
  if (missing.length > 0) errors.push(`Missing environment values: ${missing.join(", ")}.`);
  errors.push(...validateTwilioProviderEnvironment(env, { target }));
  if (env.CRON_SECRET && String(env.CRON_SECRET).trim().length < 32) {
    errors.push("CRON_SECRET must be at least 32 characters.");
  }

  if (target === "production") {
    const configuredRef = projectRef(String(env.NEXT_PUBLIC_SUPABASE_URL ?? ""));
    const expectedRef = String(env.AXIS_PROD_SUPABASE_REF ?? "").trim();
    if (configuredRef && expectedRef && configuredRef !== expectedRef) {
      errors.push("NEXT_PUBLIC_SUPABASE_URL does not match AXIS_PROD_SUPABASE_REF.");
    }
  }

  const expectedActivation = expectedActivationForPhase(phase);
  for (const [key, expected] of Object.entries(expectedActivation)) {
    const actual = String(env[key] ?? "").trim();
    if (actual !== expected) {
      errors.push(`${key} must be exactly ${expected} during the ${phase} phase.`);
    }
  }
  if (phase !== "runtime-canary") {
    warnings.push(`Managed SMS remains intentionally fail-closed in the ${phase} phase.`);
  }

  return { ok: errors.length === 0, errors, warnings };
}
