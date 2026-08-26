import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  setManagerRegistrationState,
} from "@/lib/sms/manager-number-provisioning.server";
import { normalizeRegistrationState } from "@/lib/sms/number-registration-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Reflect a manager's messaging-registration decision (ISV/reseller model). Set
 * to `approved` and their already-active number becomes sendable with no other
 * surgery; `pending`/`rejected` keep it unable to send. Optionally kicks a
 * bounded provisioning sweep for that manager so an approved manager who has no
 * number yet gets one.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (!(await isAdminUser(user.id))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      managerUserId?: string;
      state?: string;
      ref?: string | null;
      provision?: boolean;
    };
    const managerUserId = String(body.managerUserId ?? "").trim();
    if (!managerUserId) {
      return NextResponse.json({ error: "managerUserId is required." }, { status: 400 });
    }
    const state = normalizeRegistrationState(body.state);

    const db = createSupabaseServiceRoleClient();
    await setManagerRegistrationState(db, managerUserId, state, "ref" in body ? { ref: body.ref } : undefined);

    if (body.provision) {
      return NextResponse.json(
        { error: "Number purchases must be requested by the owner in Settings → Messaging." },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true, managerUserId, registrationState: state, sweep: null });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to update registration state.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
