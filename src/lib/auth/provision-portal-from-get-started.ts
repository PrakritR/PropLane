"use client";

import type { AuthPortalPickerId } from "@/lib/auth/auth-portal-picker-options";
import { detectNativePlatformSync } from "@/lib/native/detect-native";

/** Where a freshly provisioned manager chooses Free / Pro / Business. */
export const MANAGER_ENTRY_PLAN_PATH = "/auth/manager/choose-plan";

export type ProvisionPortalResult =
  | { ok: true; redirectTo: string; direct?: boolean }
  | { ok: false; error: string };

async function setActivePortal(role: AuthPortalPickerId): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch("/api/auth/set-active-portal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error || "Could not open the property portal." };
  }
  return { ok: true };
}

function managerProvisionError(body: { error?: string; reason?: string; skipped?: boolean }): string {
  if (body.error) return body.error;
  if (body.reason === "resident_only") {
    return "This login is set up as a resident account. Open the resident portal or sign out and try a different email.";
  }
  if (body.reason === "unlinked_paid_purchase") {
    return "Finish linking your paid manager plan before opening the property portal.";
  }
  return "Could not set up your property manager account. Please try again.";
}

/** Provision the chosen portal role for a signed-in user with no role yet (get-started chooser). */
export async function provisionPortalFromGetStarted(role: AuthPortalPickerId): Promise<ProvisionPortalResult> {
  if (role === "manager") {
    const res = await fetch("/api/auth/provision-pending-manager", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trial: true }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      reason?: string;
      skipped?: boolean;
      redirectTo?: string;
    };
    if (!res.ok || body.skipped) {
      return { ok: false, error: managerProvisionError(body) };
    }
    const setResult = await setActivePortal("manager");
    if (!setResult.ok) {
      return { ok: false, error: setResult.error };
    }
    // A just-provisioned manager chooses their plan (Free / Pro / Business)
    // before entering the portal — a `direct` destination, so the caller doesn't
    // let the post-auth resolver skip the step. Native shells go straight to the
    // portal instead: the chooser is a subscription-purchase surface (App Store
    // Guideline 2.1(b)); IAP in Settings is the native purchase path.
    if (!detectNativePlatformSync()) {
      return { ok: true, redirectTo: MANAGER_ENTRY_PLAN_PATH, direct: true };
    }
    return { ok: true, redirectTo: body.redirectTo?.startsWith("/") ? body.redirectTo : "/portal/dashboard" };
  }

  if (role === "resident") {
    const res = await fetch("/api/auth/create-resident-account", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { error?: string; redirectTo?: string };
    if (!res.ok) {
      return { ok: false, error: body.error || "Could not set up your resident account. Please try again." };
    }
    return {
      ok: true,
      redirectTo: body.redirectTo?.startsWith("/") ? body.redirectTo : "/resident/applications/apply",
    };
  }

  const res = await fetch("/api/auth/register-vendor-oauth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; redirectTo?: string };
  if (!res.ok) {
    return { ok: false, error: body.error || "Could not set up your vendor account. Please try again." };
  }
  const setResult = await setActivePortal("vendor");
  if (!setResult.ok) {
    return { ok: false, error: setResult.error };
  }
  return { ok: true, redirectTo: body.redirectTo?.startsWith("/") ? body.redirectTo : "/vendor/dashboard" };
}
