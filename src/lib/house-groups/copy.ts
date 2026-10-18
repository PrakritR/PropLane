import { toGsm7 } from "@/lib/one-number/segments";
import { EMERGENCY_SAFETY_REPLY } from "@/lib/one-number/contracts";
import type { GroupMember } from "./types";

/**
 * Every line the RA or the group manager says. All of it is plain GSM-7 (no emoji, curly quotes or
 * long dashes), short, and says a first name and a room at most: never a surname, an amount or a
 * complaint's author.
 */

export const LEAVE_GROUP_HINT = 'Text me "leave group" anytime to opt out.';

export function memberLine(member: Pick<GroupMember, "firstName" | "roomLabel">): string {
  const name = member.firstName.trim() || "A housemate";
  const room = member.roomLabel.trim();
  return room ? `${name} (${room})` : name;
}

export function introText(members: readonly GroupMember[], opts: { replacing: boolean; newcomers?: readonly GroupMember[] }): string {
  const names = members.map(memberLine).join(", ");
  const lead = opts.replacing ? "This is the new house thread, the old one is retired. " : "";
  const welcome =
    opts.replacing && opts.newcomers && opts.newcomers.length > 0
      ? `Welcome ${opts.newcomers.map(memberLine).join(", ")}. `
      : "";
  return toGsm7(
    `${lead}${welcome}Hi, I'm PropLane, your house assistant. In this thread: ${names}. Say "PropLane" to ask me about Wi-Fi, trash day or parking. ${LEAVE_GROUP_HINT}`,
  );
}

export const COMPLAINT_ACK = "Got it, I'll follow up with you directly.";

export function complaintFollowUp(firstName: string): string {
  const name = firstName.trim();
  return toGsm7(`${name ? `Hi ${name}, ` : "Hi, "}this is PropLane. I saw your note in the house thread. Tell me more here and I'll pass it to the property team.`);
}

export function leaverGoodbye(firstName: string, houseLabel: string, checklistUrl: string | null): string {
  const name = firstName.trim();
  const house = houseLabel.trim();
  return toGsm7(
    `${name ? `Hi ${name}, ` : "Hi, "}you've been removed from the ${house ? `${house} ` : ""}house thread. Housemates will use a new thread. ${checklistUrl ? `Move-out checklist: ${checklistUrl}` : "Reply here if you need the move-out checklist."}`,
  );
}

export const RETIRED_REPLY = "This thread is retired. Please use the new house thread.";

export const RULES_REMINDER_NOISE = "Friendly reminder: please keep noise down during quiet hours. Thanks, everyone.";
export const RULES_REMINDER_SPACES = "Friendly reminder: please keep shared spaces tidy for everyone. Thanks, all.";
export const RULES_REMINDER_GENERAL = "Friendly reminder to follow the house rules so everyone is comfortable. Thanks, all.";

export { EMERGENCY_SAFETY_REPLY };

export const LEAVE_CONFIRM = "Done. You won't be added to the house thread. House news will come to you here instead. Text \"join group\" to come back.";
export const JOIN_CONFIRM = "You're set. You'll be added to your house thread shortly. Text \"leave group\" anytime to opt out.";
export const JOIN_NEEDS_THREAD = "Got it. You'll be added when your house has a thread. Text \"leave group\" anytime to opt out.";

/** The 1:1 offer a resident gets when their house has a group but they have not agreed to join. */
export function joinOffer(firstName: string): string {
  const name = firstName.trim();
  return toGsm7(
    `${name ? `Hi ${name}, ` : "Hi, "}your house can have a group text with PropLane and your housemates. Housemates would see your number. Text "join group" to be added.`,
  );
}

export function answerText(firstName: string, answer: string): string {
  const name = firstName.trim();
  return toGsm7(name ? `${name}, ${answer}` : answer);
}

export const PRIVATE_FACT_NOTE = "I'm texting you that privately.";
export const UNKNOWN_FACT_REPLY = "Let me check with your landlord and get back to you.";
