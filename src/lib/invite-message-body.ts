/**
 * Auto-format the New message body for invite sends.
 *
 * Every fact collected on the invite step must appear here. The manager can
 * edit the draft; this builder must not drop a field. See
 * `docs/agents/send-message-compose.md`.
 */

export type InviteMessageKind = "workspace" | "vendor";

export type InviteMessageFacts = {
  kind: InviteMessageKind;
  inviterName: string;
  workspaceName?: string;
  propertyLabels?: string[];
  inviteUrl?: string;
  proplaneCode?: string;
  phone?: string;
  email?: string;
  vendorName?: string;
  trade?: string;
};

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function formatInviteMessageSubject(facts: InviteMessageFacts): string {
  const inviter = clean(facts.inviterName) || "A property manager";
  if (facts.kind === "vendor") {
    const vendor = clean(facts.vendorName);
    return vendor ? `${inviter} invited ${vendor} as a vendor` : `${inviter} invited you as a vendor`;
  }
  const workspace = clean(facts.workspaceName) || "a workspace";
  return `${inviter} invited you to ${workspace}`;
}

export function formatInviteMessageBody(facts: InviteMessageFacts): string {
  const inviter = clean(facts.inviterName) || "A property manager";
  const lines: string[] = [];

  if (facts.kind === "vendor") {
    const vendor = clean(facts.vendorName) || "you";
    lines.push(`${inviter} invited ${vendor} to join the vendor directory on PropLane.`);
    const trade = clean(facts.trade);
    if (trade) lines.push(`Trade: ${trade}`);
  } else {
    const workspace = clean(facts.workspaceName) || "a workspace";
    lines.push(`${inviter} invited you to ${workspace} on PropLane.`);
    const houses = (facts.propertyLabels ?? []).map((label) => label.trim()).filter(Boolean);
    lines.push(houses.length > 0 ? `Houses: ${houses.join(", ")}` : "Houses: no houses yet");
  }

  const code = clean(facts.proplaneCode);
  if (code) lines.push(`PropLane ID: ${code}`);
  const phone = clean(facts.phone);
  if (phone) lines.push(`Phone: ${phone}`);
  const email = clean(facts.email);
  if (email) lines.push(`Email: ${email}`);

  const url = clean(facts.inviteUrl);
  if (url) {
    lines.push("");
    lines.push(`Join: ${url}`);
  }

  lines.push("");
  lines.push("— PropLane");
  return lines.join("\n");
}
