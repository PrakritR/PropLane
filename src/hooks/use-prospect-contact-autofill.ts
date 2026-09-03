"use client";

import { useEffect, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { normalizePortalRoles } from "@/lib/auth/portal-roles";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { safeBrowserGetSession } from "@/lib/supabase/safe-browser-session";

export type ProspectContactAutofill = {
  ready: boolean;
  userId: string | null;
  hasResidentRole: boolean;
  name: string;
  email: string;
  phone: string;
};

const EMPTY: ProspectContactAutofill = {
  ready: false,
  userId: null,
  hasResidentRole: false,
  name: "",
  email: "",
  phone: "",
};

/** Prefill public tour/message forms from the signed-in portal account. */
export function useProspectContactAutofill(): ProspectContactAutofill {
  const [state, setState] = useState<ProspectContactAutofill>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const supabase = createSupabaseBrowserClient();

    async function sync(session: Session | null) {
      if (!session?.user) {
        if (!cancelled) setState({ ...EMPTY, ready: true });
        return;
      }

      const user = session.user;
      try {
        const [{ data: profile }, { data: roleRows }] = await Promise.all([
          supabase.from("profiles").select("full_name, email, phone, role").eq("id", user.id).maybeSingle(),
          supabase.from("profile_roles").select("role").eq("user_id", user.id),
        ]);

        if (cancelled) return;

        const roles = normalizePortalRoles(roleRows, profile?.role ?? user.user_metadata?.role);
        const meta = user.user_metadata as { full_name?: string; name?: string } | undefined;
        setState({
          ready: true,
          userId: user.id,
          hasResidentRole: roles.includes("resident"),
          name: profile?.full_name?.trim() || meta?.full_name?.trim() || meta?.name?.trim() || "",
          email: profile?.email?.trim() || user.email?.trim() || "",
          phone: profile?.phone?.trim() || "",
        });
      } catch {
        if (cancelled) return;
        const meta = user.user_metadata as { full_name?: string; name?: string } | undefined;
        setState({
          ready: true,
          userId: user.id,
          hasResidentRole: false,
          name: meta?.full_name?.trim() || meta?.name?.trim() || "",
          email: user.email?.trim() || "",
          phone: "",
        });
      }
    }

    void safeBrowserGetSession(supabase).then(({ session }) => {
      void sync(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      void sync(session);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  return state;
}
