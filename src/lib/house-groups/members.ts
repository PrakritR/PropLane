import { createHash } from "node:crypto";
import {
  GROUP_MEMBER_CAP,
  GROUP_MIN_MEMBERS,
  type ExclusionReason,
  type GroupMember,
  type ResidentCandidate,
} from "./types";

/** Digest of the sorted phone keys: a group is DEFINED by its member list. */
export function memberHash(phoneKeys: readonly string[]): string {
  const sorted = [...new Set(phoneKeys.map((k) => k.trim()).filter(Boolean))].sort();
  return createHash("sha256").update(sorted.join("|")).digest("hex");
}

const moveInKey = (m: { moveIn: string | null }) => m.moveIn ?? "9999-12-31";

function toMember(c: ResidentCandidate): GroupMember {
  return {
    phoneKey: c.phoneKey,
    phoneE164: c.phoneE164,
    userId: c.userId,
    firstName: c.firstName,
    roomLabel: c.roomLabel,
    moveIn: c.moveIn,
  };
}

export type MemberSelection = {
  /** Who belongs in the group, earliest move-in first, at most `GROUP_MEMBER_CAP`. */
  members: GroupMember[];
  /** Eligible residents past the cap: they stay on 1:1 texts and the manager sees a warning. */
  overflow: GroupMember[];
  excluded: { phoneKey: string; reason: ExclusionReason }[];
  /** True when fewer than two residents qualify: no group is made (1:1 only). */
  tooFew: boolean;
};

/**
 * Who a house's group should hold. A short stay never joins; a resident needs a verified phone,
 * group consent, no "leave group", and no STOP. Two candidates on one phone count once (the earlier
 * move-in). More than nine: the first nine by move-in date stay, the rest get 1:1.
 */
export function selectGroupMembers(candidates: readonly ResidentCandidate[], cap = GROUP_MEMBER_CAP): MemberSelection {
  const excluded: MemberSelection["excluded"] = [];
  const eligible: ResidentCandidate[] = [];
  const seen = new Set<string>();
  const ordered = [...candidates].sort((a, b) => moveInKey(a).localeCompare(moveInKey(b)) || a.phoneKey.localeCompare(b.phoneKey));
  for (const c of ordered) {
    const reason: ExclusionReason | null = !c.longTerm
      ? "short_stay"
      : c.stopped
        ? "stopped"
        : c.optedOut
          ? "left_group"
          : !c.verifiedPhone
            ? "unverified_phone"
            : !c.consented
              ? "no_consent"
              : seen.has(c.phoneKey)
                ? "duplicate"
                : null;
    if (reason) {
      excluded.push({ phoneKey: c.phoneKey, reason });
      continue;
    }
    seen.add(c.phoneKey);
    eligible.push(c);
  }
  const members = eligible.slice(0, cap).map(toMember);
  const overflow = eligible.slice(cap).map(toMember);
  return { members, overflow, excluded, tooFew: members.length < GROUP_MIN_MEMBERS };
}

export type MemberDiff = { same: boolean; added: string[]; removed: string[] };

/** Phone keys only: names and rooms changing never makes a new group. */
export function diffMembers(currentKeys: readonly string[], desiredKeys: readonly string[]): MemberDiff {
  const current = new Set(currentKeys);
  const desired = new Set(desiredKeys);
  const added = [...desired].filter((k) => !current.has(k)).sort();
  const removed = [...current].filter((k) => !desired.has(k)).sort();
  return { same: added.length === 0 && removed.length === 0, added, removed };
}
