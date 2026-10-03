"use client";

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PasswordInput } from "@/components/ui/password-input";
import {
  PortalSettingsRow,
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
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    if (!email) {
      setError("Sign in to change your password.");
      return;
    }
    // Only an account that HAS a password can be asked to confirm it.
    if (!settingFirstPassword && !oldPassword.trim()) {
      setError("Enter your current password.");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(
        settingFirstPassword
          ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
          : `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(settingFirstPassword ? "Passwords do not match." : "New passwords do not match.");
      return;
    }
    if (!settingFirstPassword && oldPassword === newPassword) {
      setError("Choose a new password that is different from your current one.");
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
          setError("Current password is incorrect.");
          return;
        }
      }

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        setError(error.message || "Could not update password.");
        return;
      }

      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setOpen(false);
      if (settingFirstPassword) {
        // The account now has one, so this panel becomes the ordinary update flow —
        // including the current-password confirmation — without a reload.
        setHasPassword(true);
        showToast("Password set. You can now sign in with your email and password.");
        return;
      }
      showToast("Password updated.");
    } catch {
      setError("Could not update password.");
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

  const close = () => {
    if (passwordBusy || resetBusy) return;
    setOpen(false);
    setOldPassword(""); setNewPassword(""); setConfirmPassword(""); setError(null);
  };

  return (
    <>
      <PortalSettingsSection title="Sign in">
        <PortalSettingsGroup>
          <PortalSettingsRow label="Email"><span className="break-all text-[15px] text-muted">{email}</span></PortalSettingsRow>
          <PortalSettingsRow label="Password">
            <div className="flex items-center gap-3">
              <span className="text-[15px] text-muted">{!resolved ? "Loading…" : settingFirstPassword ? "Not set" : "••••••••"}</span>
              <PortalIconAction icon={Pencil} label={settingFirstPassword ? "Set password" : "Change password"} disabled={!resolved}
                onClick={() => { setError(null); setOpen(true); }} />
            </div>
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>
      <PortalDialog open={open} onClose={close} title={settingFirstPassword ? "Set password" : "Change password"}
        primaryAction={{ label: settingFirstPassword ? "Set password" : "Update password", onClick: changePassword,
          disabled: passwordBusy || resetBusy, dataAttr: settingFirstPassword ? "set-password" : "update-password" }}>
        <div className="space-y-4">
          {!settingFirstPassword ? <div className="space-y-2">
            <label htmlFor="portal-old-password" className="text-xs font-medium uppercase text-muted">Current password</label>
            <PasswordInput id="portal-old-password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} autoComplete="current-password" disabled={passwordBusy || resetBusy} />
          </div> : null}
          <div className="space-y-2">
            <label htmlFor="portal-new-password" className="text-xs font-medium uppercase text-muted">{settingFirstPassword ? "Password" : "New password"}</label>
            <PasswordInput id="portal-new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" disabled={passwordBusy || resetBusy} />
          </div>
          <div className="space-y-2">
            <label htmlFor="portal-confirm-password" className="text-xs font-medium uppercase text-muted">Confirm password</label>
            <PasswordInput id="portal-confirm-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" disabled={passwordBusy || resetBusy} />
          </div>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
          {!settingFirstPassword ? <button type="button" className="text-sm text-primary" disabled={resetBusy || passwordBusy || !email} onClick={sendResetLink}>
            {resetBusy ? "Sending…" : "Send a reset link to your email"}
          </button> : null}
        </div>
      </PortalDialog>
    </>
  );
}
