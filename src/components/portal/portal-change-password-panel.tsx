"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import {
  PortalSettingsFormBody,
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { fetchCurrentUserHasPassword } from "@/lib/auth/current-user-has-password";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { requestPasswordReset } from "@/lib/auth/request-password-reset";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { normalizeAuthEmail } from "@/lib/auth/normalize-auth-email";

const MIN_PASSWORD_LENGTH = 8;

export function PortalChangePasswordPanel({ accountEmail }: { accountEmail: string }) {
  const { showToast } = useAppUi();
  const email = accountEmail.trim();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  // null until the server answers. A Google/Apple-only account has no password, so it
  // must be asked to SET one rather than for a "current password" that cannot exist.
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);

  useEffect(() => {
    // /demo renders both profile panels with no real session, and every authed fetch
    // from a demo surface is gated (see the demo-sandbox invariant in AGENTS.md). The
    // RPC would be refused there anyway and fail closed to the same state, so this
    // costs the sandbox nothing but a round trip and a "Loading…" flash.
    if (isDemoModeActive()) {
      setHasPassword(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      const resolved = await fetchCurrentUserHasPassword(createSupabaseBrowserClient());
      if (!cancelled) setHasPassword(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resolved = hasPassword !== null;
  const settingFirstPassword = hasPassword === false;

  const changePassword = async () => {
    if (!email) {
      showToast("Sign in to change your password.");
      return;
    }
    // Only an account that HAS a password can be asked to confirm it.
    if (!settingFirstPassword && !oldPassword.trim()) {
      showToast("Enter your current password.");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      showToast(
        settingFirstPassword
          ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
          : `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      showToast(settingFirstPassword ? "Passwords do not match." : "New passwords do not match.");
      return;
    }
    if (!settingFirstPassword && oldPassword === newPassword) {
      showToast("Choose a new password that is different from your current one.");
      return;
    }

    setPasswordBusy(true);
    try {
      const supabase = createSupabaseBrowserClient();
      if (!settingFirstPassword) {
        const { error: verifyError } = await supabase.auth.signInWithPassword({
          email: normalizeAuthEmail(email),
          password: oldPassword,
        });
        if (verifyError) {
          showToast("Current password is incorrect.");
          return;
        }
      }

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        showToast(error.message || "Could not update password.");
        return;
      }

      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      if (settingFirstPassword) {
        // The account now has one, so this panel becomes the ordinary update flow —
        // including the current-password confirmation — without a reload.
        setHasPassword(true);
        showToast("Password set. You can now sign in with your email and password.");
        return;
      }
      showToast("Password updated.");
    } catch {
      showToast("Could not update password.");
    } finally {
      setPasswordBusy(false);
    }
  };

  const sendResetLink = async () => {
    if (!email) {
      showToast("No email on file for this account.");
      return;
    }
    setResetBusy(true);
    try {
      const result = await requestPasswordReset(email);
      if (!result.ok) {
        showToast(result.message);
        return;
      }
      showToast(`Reset link sent to ${email}. Check your inbox.`);
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <PortalSettingsSection
      title="Login & security"
      description={
        settingFirstPassword
          ? "You sign in with Google or Apple. Set a password to also sign in with your email."
          : "Update your password or request a reset link."
      }
      action={
        resolved ? (
          <Button
            type="button"
            variant="primary"
            className="px-4 text-[13px]"
            data-attr={settingFirstPassword ? "set-password" : "update-password"}
            disabled={passwordBusy || resetBusy}
            onClick={() => changePassword()}
          >
            {passwordBusy
              ? settingFirstPassword
                ? "Setting…"
                : "Updating…"
              : settingFirstPassword
                ? "Set password"
                : "Update password"}
          </Button>
        ) : undefined
      }
    >
      <PortalSettingsGroup>
        <PortalSettingsFormBody>
          {!resolved ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {settingFirstPassword ? null : (
                  <div className="space-y-2 sm:col-span-2">
                    <label className="text-sm font-medium text-foreground" htmlFor="portal-old-password">
                      Current password
                    </label>
                    <PasswordInput
                      id="portal-old-password"
                      value={oldPassword}
                      onChange={(e) => setOldPassword(e.target.value)}
                      autoComplete="current-password"
                      disabled={passwordBusy || resetBusy}
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="portal-new-password">
                    {settingFirstPassword ? "Password" : "New password"}
                  </label>
                  <PasswordInput
                    id="portal-new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoComplete="new-password"
                    disabled={passwordBusy || resetBusy}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="portal-confirm-password">
                    {settingFirstPassword ? "Confirm password" : "Confirm new password"}
                  </label>
                  <PasswordInput
                    id="portal-confirm-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    disabled={passwordBusy || resetBusy}
                  />
                </div>
              </div>

              {settingFirstPassword ? null : (
                <p className="text-sm leading-relaxed text-muted">
                  Forgot your current password?{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground underline underline-offset-2 transition hover:opacity-80 disabled:opacity-60"
                    disabled={resetBusy || passwordBusy || !email}
                    onClick={() => void sendResetLink()}
                  >
                    {resetBusy ? "Sending…" : "Send a reset link to your email"}
                  </button>
                </p>
              )}
            </>
          )}
        </PortalSettingsFormBody>
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}
