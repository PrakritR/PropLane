import "server-only";

import { createHash } from "node:crypto";
import { isProvisioningEnabled } from "@/lib/sms/number-registration-policy";
import type { VendorWorkIdentityProvider } from "@/lib/vendor-work-identity.server";
import type { VendorDeliveryProvider } from "@/lib/vendor-work-identity-delivery.server";

/**
 * Dry run for the vendor work number: the whole claim -> receive -> forward ->
 * reply path runs against the real database rows but never reaches Twilio. A
 * "purchased" number is a fictional 555-01xx line and every text is captured
 * in memory.
 *
 * It exists so the flow can be driven end to end on a dev box that carries real
 * Twilio credentials. It is impossible to turn on in production (`NODE_ENV`,
 * `VERCEL`) and impossible alongside real provisioning
 * (`SMS_PROVISIONING_ENABLED=1`): those two always win.
 */
export function isVendorNumberDryRun(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NODE_ENV === "production" || env.VERCEL) return false;
  if (isProvisioningEnabled(env)) return false;
  return env.VENDOR_WORK_NUMBER_DRY_RUN === "1";
}

export type DryRunCapturedSms = { from: string; to: string; text: string; id: string };
const captured: DryRunCapturedSms[] = [];
const purchasedBySid = new Map<string, string>();

/** The last texts a dry run would have sent (newest last, capped). Test and dev inspection only. */
export function dryRunCapturedSms(): readonly DryRunCapturedSms[] {
  return captured;
}
export function clearDryRunCapturedSms(): void {
  captured.length = 0;
}

function dryRunId(prefix: string, seed: string): string {
  return `${prefix}dryrun${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

/** Reserved fictional lines: +1 <area> 555 0100-0199. */
export function dryRunCandidateNumbers(areaCode: string, count: number): string[] {
  const digits = areaCode.replace(/\D/g, "").slice(0, 3);
  if (!/^[2-9]\d{2}$/.test(digits)) return [];
  return Array.from({ length: Math.max(1, Math.min(count, 10)) }, (_, index) => `+1${digits}5550${String(177 + index).padStart(3, "0")}`);
}

export function createDryRunVendorWorkIdentityProvider(base: Pick<VendorWorkIdentityProvider, "emailConfigured" | "emailDomainReadiness">): VendorWorkIdentityProvider {
  return {
    emailConfigured: () => base.emailConfigured(),
    emailDomainReadiness: (domain) => base.emailDomainReadiness(domain),
    smsConfigured: () => true,
    async findSmsByOperation() {
      return null;
    },
    async searchSmsCandidates({ areaCode, count }) {
      return dryRunCandidateNumbers(areaCode, count).map((phoneNumber) => ({ phoneNumber }));
    },
    async purchaseSms({ operationId, phoneNumber }) {
      const number = phoneNumber ?? dryRunCandidateNumbers("206", 1)[0]!;
      const phoneSid = dryRunId("PN", operationId);
      purchasedBySid.set(phoneSid, number);
      return { phoneNumber: number, phoneSid };
    },
    async attachSms() {
      return { attached: true, carrierReady: true };
    },
    async inspectSms({ phoneSid }) {
      return { phoneNumber: purchasedBySid.get(phoneSid) ?? "", attached: true, carrierReady: true };
    },
  };
}

export function createDryRunVendorDeliveryProvider(): VendorDeliveryProvider {
  return {
    configured: (channel) => channel === "sms",
    async email() {
      throw new Error("dry run sends no email");
    },
    async sms(input) {
      const id = dryRunId("SM", input.idempotencyKey);
      captured.push({ from: input.from, to: input.to, text: input.text, id });
      if (captured.length > 200) captured.shift();
      return { id };
    },
  };
}
