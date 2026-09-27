import { transitionApplicationBucket } from "@/lib/application-review";
import { backgroundCheckStatusFromCheckr } from "@/lib/application-background-check";
import { buildDemoBackgroundCheck } from "@/lib/checkr/demo-simulate";
import { CANONICAL_DEMO_GUIDED_NAME } from "@/lib/demo/demo-canonical-accounts";
import { DEMO_GUIDED_EMAIL, resolveDemoManagerScopeUserId } from "@/lib/demo/demo-session";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  replaceManagerApplicationRowInCache,
} from "@/lib/manager-applications-storage";
import {
  LEASE_PIPELINE_EVENT,
  generateLeaseHtmlForRow,
  managerSignLease,
  readLeasePipeline,
  residentSignLease,
  sendLeaseToResident,
} from "@/lib/lease-pipeline-storage";

export function demoLeaseRowIdForApplication(axisId: string): string {
  return `lease_app_${axisId.trim()}`;
}

export function runDemoScreeningForApplication(axisId: string): boolean {
  const row = readManagerApplicationRows().find((r) => r.id === axisId);
  if (!row) return false;
  const bg = buildDemoBackgroundCheck(row, { packageSlug: "essential" });
  replaceManagerApplicationRowInCache({
    ...row,
    backgroundCheck: bg,
    backgroundCheckStatus: backgroundCheckStatusFromCheckr(bg),
  });
  window.dispatchEvent(new Event(MANAGER_APPLICATIONS_EVENT));
  return true;
}

export async function approveDemoApplication(axisId: string): Promise<boolean> {
  const managerUserId = resolveDemoManagerScopeUserId();
  const result = await transitionApplicationBucket(axisId, "approved", {
    userId: managerUserId,
    skipWelcomeEmail: true,
  });
  if (result && !result.blocked) {
    window.dispatchEvent(new Event(MANAGER_APPLICATIONS_EVENT));
    window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
  }
  return Boolean(result && !result.blocked);
}

export function runDemoGenerateLease(axisId: string): boolean {
  const leaseId = demoLeaseRowIdForApplication(axisId);
  const managerUserId = resolveDemoManagerScopeUserId();
  const gen = generateLeaseHtmlForRow(leaseId, managerUserId);
  if (gen.ok) {
    window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
    return true;
  }
  return false;
}

export async function runDemoSendLeaseToResident(axisId: string): Promise<boolean> {
  const leaseId = demoLeaseRowIdForApplication(axisId);
  const managerUserId = resolveDemoManagerScopeUserId();
  const res = await sendLeaseToResident(leaseId, managerUserId);
  if (res.ok) window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
  return res.ok;
}

export async function runDemoResidentSignLease(
  email = DEMO_GUIDED_EMAIL,
  name = CANONICAL_DEMO_GUIDED_NAME,
): Promise<boolean> {
  const result = await residentSignLease(email.trim(), name.trim());
  if (result.ok) window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
  return result.ok;
}

export async function runDemoManagerSignLease(
  axisId: string,
  name = CANONICAL_DEMO_GUIDED_NAME,
): Promise<boolean> {
  const leaseId = demoLeaseRowIdForApplication(axisId);
  const managerUserId = resolveDemoManagerScopeUserId();
  const result = await managerSignLease(leaseId, name.trim(), managerUserId);
  if (result.ok) window.dispatchEvent(new Event(LEASE_PIPELINE_EVENT));
  return result.ok;
}

export function demoLeaseRowForApplication(axisId: string) {
  const managerUserId = resolveDemoManagerScopeUserId();
  const leaseId = demoLeaseRowIdForApplication(axisId);
  return readLeasePipeline(managerUserId).find((r) => r.id === leaseId) ?? null;
}
