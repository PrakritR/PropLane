/**
 * The people who text PropLane, in the one order and with the one set of names every surface uses (captain #27):
 * the homepage hero strip, How it works (and its "Every home" diagram), and the blue panel on the auth screens.
 * `caption` is the short line (auth panel); `detail` is How it works' line. Change a role here, never on a surface.
 */
export const HOME_ROLES = [
  { id: "prospects", label: "Prospects", caption: "Ask about a room", detail: "Ask about a room. Book the tour." },
  { id: "residents", label: "Residents", caption: "Pay rent, report a leak", detail: "Pay rent. Report a leak." },
  { id: "vendors", label: "Vendors", caption: "Accept the job", detail: "Accept the job. Keep everyone posted." },
  { id: "managers", label: "Managers", caption: "Ask about your houses and prospects", detail: "Ask about your houses and prospects." },
  { id: "owners", label: "Owners", caption: "Ask how your home is doing", detail: "Ask how your home is doing." },
] as const;

export type HomeRoleId = (typeof HOME_ROLES)[number]["id"];

export function homeRole(id: HomeRoleId) {
  return HOME_ROLES.find((role) => role.id === id)!;
}
