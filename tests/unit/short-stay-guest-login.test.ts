import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const findAuthUserIdByEmail = vi.fn(async (..._args: unknown[]): Promise<string | null> => null);
vi.mock("@/lib/auth/find-auth-user-id-by-email", () => ({ findAuthUserIdByEmail: (...args: unknown[]) => findAuthUserIdByEmail(...args) }));
const ensureProfileRoleRow = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@/lib/auth/profile-role-row", () => ({ ensureProfileRoleRow: (...args: unknown[]) => ensureProfileRoleRow(...args) }));
const provision = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, axisId: "AXIS-1", linkedApplication: false }));
vi.mock("@/lib/auth/provision-resident-account", () => ({ provisionResidentAccountByEmail: (...args: unknown[]) => provision(...args) }));

import { ensureGuestLogin, guestPlaceholderEmail, guestSignInConfirmUrl } from "@/lib/short-stay/guest-login.server";
import { createFakeDb } from "../helpers/fake-table-db";

function dbFor(rows: { profiles?: Array<Record<string, unknown>>; roles?: Array<Record<string, unknown>> }) {
  const fake = createFakeDb({ profiles: rows.profiles ?? [], profile_roles: rows.roles ?? [] });
  const createUser = vi.fn(async (input: { email: string }) => ({ data: { user: { id: "new-user", email: input.email } }, error: null }));
  const generateLink = vi.fn(async (input: { email: string }) => ({ data: { properties: { hashed_token: `hash-for-${input.email}` } }, error: null }));
  return { db: Object.assign(fake, { auth: { admin: { createUser, generateLink } } }) as never, createUser, generateLink };
}

beforeEach(() => {
  vi.clearAllMocks();
  findAuthUserIdByEmail.mockResolvedValue(null);
});

describe("the one-time sign-in link", () => {
  it("is a token_hash confirm link, never a PKCE code", () => {
    const url = guestSignInConfirmUrl("https://proplane.ai/", "abc 123");
    expect(url).toBe("https://proplane.ai/auth/confirm?token_hash=abc%20123&type=magiclink");
    expect(url).not.toMatch(/[?&]code=/);
  });

  it("the placeholder login is keyed on the phone", () => {
    expect(guestPlaceholderEmail("+12065550142")).toBe("guest.12065550142@import.proplane.local");
  });
});

describe("ensureGuestLogin", () => {
  const input = { name: "Priya Shah", phone: "+12065550142", email: "priya@example.com" };

  it("creates a resident login on the PLACEHOLDER, never the typed email, and mints the link for it", async () => {
    const { db, createUser, generateLink } = dbFor({});
    const login = await ensureGuestLogin(db, input);
    const placeholder = "guest.12065550142@import.proplane.local";
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ email: placeholder, email_confirm: true }));
    expect(provision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "new-user", email: placeholder, phone: "+12065550142", inheritFromApplication: false, emailProven: false }),
    );
    expect(JSON.stringify(provision.mock.calls)).not.toContain("priya@example.com");
    expect(ensureProfileRoleRow).toHaveBeenCalledWith(expect.anything(), "new-user", "resident");
    expect(generateLink).toHaveBeenCalledWith({ type: "magiclink", email: placeholder });
    expect(login).toMatchObject({ userId: "new-user", created: true, loginEmail: placeholder });
    expect(login?.signInUrl).toContain("/auth/confirm?token_hash=hash-for-guest.12065550142%40import.proplane.local&type=magiclink");
  });

  it("a victim's email (existing account, applications, inbox threads) is never looked up, attached or used", async () => {
    findAuthUserIdByEmail.mockResolvedValue("victim-user");
    const { db, createUser, generateLink } = dbFor({});
    const login = await ensureGuestLogin(db, { ...input, email: "victim@example.com" });
    expect(findAuthUserIdByEmail).not.toHaveBeenCalled();
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ email: "guest.12065550142@import.proplane.local" }));
    expect(generateLink).toHaveBeenCalledWith({ type: "magiclink", email: "guest.12065550142@import.proplane.local" });
    // The only provisioning call is on the placeholder with every email-keyed inheritance switched off.
    expect(provision).toHaveBeenCalledTimes(1);
    const opts = provision.mock.calls[0]![1] as { email: string; emailProven: boolean; inheritFromApplication: boolean };
    expect(opts).toMatchObject({ email: "guest.12065550142@import.proplane.local", emailProven: false, inheritFromApplication: false });
    expect(JSON.stringify(provision.mock.calls)).not.toContain("victim@example.com");
    expect(login?.userId).toBe("new-user");
  });

  it("works with no typed email at all", async () => {
    const { db, createUser } = dbFor({});
    const login = await ensureGuestLogin(db, { ...input, email: "" });
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ email: "guest.12065550142@import.proplane.local" }));
    expect(login?.created).toBe(true);
  });

  it("reuses the resident account that holds this phone: the link goes to that phone's own owner", async () => {
    const { db, createUser, generateLink } = dbFor({
      profiles: [{ id: "u-priya", email: "p@home.test", phone: "+12065550142" }],
      roles: [{ user_id: "u-priya", role: "resident" }],
    });
    const login = await ensureGuestLogin(db, input);
    expect(createUser).not.toHaveBeenCalled();
    expect(generateLink).toHaveBeenCalledWith({ type: "magiclink", email: "p@home.test" });
    expect(login).toMatchObject({ userId: "u-priya", created: false });
  });

  it("does not hand a manager who shares the number a resident role from a stranger's booking", async () => {
    const { db, createUser } = dbFor({ profiles: [{ id: "u-mgr", email: "m@home.test", phone: "+12065550142" }], roles: [{ user_id: "u-mgr", role: "manager" }] });
    const login = await ensureGuestLogin(db, input);
    expect(createUser).toHaveBeenCalled();
    expect(login?.userId).toBe("new-user");
    expect(ensureProfileRoleRow).not.toHaveBeenCalledWith(expect.anything(), "u-mgr", "resident");
  });

  it("gives up (no link, no account) when two accounts claim the phone or the account service refuses", async () => {
    const two = dbFor({ profiles: [{ id: "a", email: "a@x.test", phone: "+12065550142" }, { id: "b", email: "b@x.test", phone: "+12065550142" }] });
    expect(await ensureGuestLogin(two.db, input)).toBeNull();
    expect(two.createUser).not.toHaveBeenCalled();
    const refused = dbFor({});
    (refused.createUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { user: null }, error: { message: "nope" } } as never);
    expect(await ensureGuestLogin(refused.db, input)).toBeNull();
  });
});
