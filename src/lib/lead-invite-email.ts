import type { ListingShareSummary } from "@/lib/listing-share-summary";

export type LeadInviteKind = "apply" | "tour" | "listing" | "lease";

export function leadInviteSubject(kind: LeadInviteKind, propertyTitle: string, listingCount?: number): string {
  const title = propertyTitle.trim() || "your property";
  if (kind === "listing") {
    if (listingCount && listingCount > 1) return `${listingCount} listings for you — PropLane`;
    return `Listing: ${title} — PropLane`;
  }
  if (kind === "lease") {
    return `Sign your lease — ${title} — PropLane`;
  }
  if (kind === "tour" && listingCount && listingCount > 1) {
    return `Schedule a tour — choose your property — PropLane`;
  }
  if (kind === "apply" && listingCount && listingCount > 1) {
    return `${listingCount} homes to apply for — PropLane`;
  }
  return kind === "apply" ? `Apply for ${title} — PropLane` : `Schedule a tour — ${title}`;
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function buildLeadInviteEmailBody(params: {
  kind: LeadInviteKind;
  prospectName?: string;
  propertyTitle: string;
  linkUrl: string;
  listingPageUrl?: string;
  tourUrl?: string;
  listingSummary?: ListingShareSummary;
  managerNote?: string;
  /** When sharing several listings at once, the count powers the multi-listing copy. */
  listingCount?: number;
  /** When sharing a portfolio tour link, the count powers the multi-property copy. */
  tourCount?: number;
}): string {
  const greeting = params.prospectName?.trim() ? `Hi ${params.prospectName.trim()},` : "Hi,";
  const propertyTitle = params.propertyTitle.trim() || "a property";

  if (params.kind === "listing" && (params.listingCount ?? 0) > 1) {
    const lines = [
      greeting,
      "",
      `Your property manager shared ${params.listingCount} homes with you on PropLane.`,
      "",
      `Browse them here: ${params.linkUrl}`,
    ];
    if (params.managerNote?.trim()) {
      lines.push("", "Note from your property manager:", params.managerNote.trim());
    }
    lines.push("", "— PropLane");
    return lines.join("\n");
  }

  if (params.kind === "tour" && (params.tourCount ?? 0) > 1) {
    const lines = [
      greeting,
      "",
      `Your property manager invited you to schedule a tour. Choose from ${params.tourCount} available properties on PropLane.`,
      "",
      `Schedule your tour here: ${params.linkUrl}`,
    ];
    if (params.managerNote?.trim()) {
      lines.push("", "Note from your property manager:", params.managerNote.trim());
    }
    lines.push("", "— PropLane");
    return lines.join("\n");
  }

  if (params.kind === "apply" && (params.listingCount ?? 0) > 1) {
    const lines = [
      greeting,
      "",
      `Your property manager invited you to apply for one of ${params.listingCount} homes on PropLane.`,
      "",
      `Browse them here: ${params.linkUrl}`,
    ];
    if (params.managerNote?.trim()) {
      lines.push("", "Note from your property manager:", params.managerNote.trim());
    }
    lines.push("", "— PropLane");
    return lines.join("\n");
  }

  if (params.kind === "listing" && params.listingSummary) {
    const lines = [greeting, "", `Here are the details for ${propertyTitle}:`, ""];
    for (const detail of params.listingSummary.detailLines) {
      lines.push(`• ${detail}`);
    }
    lines.push("");
    if (params.listingPageUrl) lines.push(`View listing: ${params.listingPageUrl}`);
    lines.push(`Apply: ${params.linkUrl}`);
    if (params.tourUrl) lines.push(`Schedule a tour: ${params.tourUrl}`);
    if (params.managerNote?.trim()) {
      lines.push("", "Note from your property manager:", params.managerNote.trim());
    }
    lines.push("", "— PropLane");
    return lines.join("\n");
  }

  const intro =
    params.kind === "apply"
      ? `Your property manager invited you to apply for ${propertyTitle} on PropLane.`
      : params.kind === "lease"
        ? `Your property manager invited you to review and sign your lease for ${propertyTitle} on PropLane.`
        : `Your property manager invited you to schedule a tour for ${propertyTitle} on PropLane.`;
  const cta =
    params.kind === "apply"
      ? "Start your application here:"
      : params.kind === "lease"
        ? "Create your resident account (or sign in) to open your lease:"
        : "Schedule your tour here:";
  const lines = [greeting, "", intro, "", cta, params.linkUrl];
  if (params.managerNote?.trim()) {
    lines.push("", "Note from your property manager:", params.managerNote.trim());
  }
  lines.push("", "— PropLane");
  return lines.join("\n");
}

/** Short SMS copy for manager-initiated listing / apply / tour shares. */
export function buildLeadInviteSmsText(params: {
  kind: LeadInviteKind;
  prospectName?: string;
  propertyTitle: string;
  linkUrl: string;
  listingCount?: number;
  tourCount?: number;
  managerNote?: string;
}): string {
  const hi = params.prospectName?.trim() ? `Hi ${params.prospectName.trim()}, ` : "";
  const title = params.propertyTitle.trim() || "a property";
  const note = params.managerNote?.trim();

  let lead = "";
  if (params.kind === "listing" && (params.listingCount ?? 0) > 1) {
    lead = `${hi}Your property manager shared ${params.listingCount} homes on PropLane: ${params.linkUrl}`;
  } else if (params.kind === "tour" && (params.tourCount ?? 0) > 1) {
    lead = `${hi}Schedule a tour — choose from ${params.tourCount} properties on PropLane: ${params.linkUrl}`;
  } else if (params.kind === "apply" && (params.listingCount ?? 0) > 1) {
    lead = `${hi}Apply for one of ${params.listingCount} homes on PropLane: ${params.linkUrl}`;
  } else if (params.kind === "listing") {
    lead = `${hi}Listing for ${title} on PropLane: ${params.linkUrl}`;
  } else if (params.kind === "apply") {
    lead = `${hi}Apply for ${title} on PropLane: ${params.linkUrl}`;
  } else if (params.kind === "lease") {
    lead = `${hi}Sign your lease for ${title} on PropLane: ${params.linkUrl}`;
  } else {
    lead = `${hi}Schedule a tour for ${title} on PropLane: ${params.linkUrl}`;
  }

  if (!note) return lead;
  const withNote = `${lead}\n\nNote: ${note}`;
  return withNote.length > 1600 ? `${lead}\n\nNote: ${note.slice(0, 1600 - lead.length - 10)}…` : withNote;
}

export function buildLeadInviteEmailHtml(params: {
  kind: LeadInviteKind;
  prospectName?: string;
  propertyTitle: string;
  linkUrl: string;
  listingPageUrl?: string;
  tourUrl?: string;
  listingSummary?: ListingShareSummary;
  managerNote?: string;
  listingCount?: number;
  tourCount?: number;
}): string {
  const greeting = params.prospectName?.trim()
    ? `Hi ${escapeHtmlText(params.prospectName.trim())},`
    : "Hi,";
  const propertyTitle = escapeHtmlText(params.propertyTitle.trim() || "a property");
  const href = escapeHtmlAttr(params.linkUrl);
  const urlPlain = escapeHtmlText(params.linkUrl);
  const noteBlock = params.managerNote?.trim()
    ? `<p style="margin:16px 0 0 0;padding:12px 14px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0"><strong>Note:</strong> ${escapeHtmlText(params.managerNote.trim())}</p>`
    : "";

  if (params.kind === "listing" && (params.listingCount ?? 0) > 1) {
    return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#0f172a;font-size:15px;background:#f8fafc">
<div style="max-width:36rem;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
<p style="margin:0 0 12px 0">${greeting}</p>
<p style="margin:0 0 16px 0">Your property manager shared <strong>${params.listingCount} homes</strong> with you on PropLane.</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 12px 0">
<tr><td style="border-radius:10px;background:#2563eb">
<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Browse the homes</a>
</td></tr></table>
<p style="margin:0;font-size:13px;color:#64748b;word-break:break-all">${urlPlain}</p>
${noteBlock}
<p style="margin:16px 0 0 0;color:#64748b;font-size:14px">— PropLane</p>
</div>
</body>
</html>`;
  }

  if (params.kind === "tour" && (params.tourCount ?? 0) > 1) {
    return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#0f172a;font-size:15px;background:#f8fafc">
<div style="max-width:36rem;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
<p style="margin:0 0 12px 0">${greeting}</p>
<p style="margin:0 0 16px 0">Your property manager invited you to schedule a tour. Choose from <strong>${params.tourCount} available properties</strong> on PropLane.</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 12px 0">
<tr><td style="border-radius:10px;background:#2563eb">
<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Choose property & schedule</a>
</td></tr></table>
<p style="margin:0;font-size:13px;color:#64748b;word-break:break-all">${urlPlain}</p>
${noteBlock}
<p style="margin:16px 0 0 0;color:#64748b;font-size:14px">— PropLane</p>
</div>
</body>
</html>`;
  }

  if (params.kind === "apply" && (params.listingCount ?? 0) > 1) {
    return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#0f172a;font-size:15px;background:#f8fafc">
<div style="max-width:36rem;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
<p style="margin:0 0 12px 0">${greeting}</p>
<p style="margin:0 0 16px 0">Your property manager invited you to apply for one of <strong>${params.listingCount} homes</strong> on PropLane.</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 12px 0">
<tr><td style="border-radius:10px;background:#2563eb">
<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Browse the homes</a>
</td></tr></table>
<p style="margin:0;font-size:13px;color:#64748b;word-break:break-all">${urlPlain}</p>
${noteBlock}
<p style="margin:16px 0 0 0;color:#64748b;font-size:14px">— PropLane</p>
</div>
</body>
</html>`;
  }

  if (params.kind === "listing" && params.listingSummary) {
    const bullets = params.listingSummary.detailLines
      .map((line) => `<li style="margin:4px 0">${escapeHtmlText(line)}</li>`)
      .join("");
    const listingHref = params.listingPageUrl ? escapeHtmlAttr(params.listingPageUrl) : "";
    const listingPlain = params.listingPageUrl ? escapeHtmlText(params.listingPageUrl) : "";
    const tourHref = params.tourUrl ? escapeHtmlAttr(params.tourUrl) : "";
    const tourPlain = params.tourUrl ? escapeHtmlText(params.tourUrl) : "";
    return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#0f172a;font-size:15px;background:#f8fafc">
<div style="max-width:36rem;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
<p style="margin:0 0 12px 0">${greeting}</p>
<p style="margin:0 0 12px 0">Here are the details for <strong>${propertyTitle}</strong>:</p>
<ul style="margin:0 0 16px 0;padding-left:20px;color:#334155">${bullets}</ul>
${listingHref ? `<p style="margin:0 0 8px 0;font-size:14px"><a href="${listingHref}" style="color:#2563eb">View full listing</a></p>` : ""}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 12px 0">
<tr><td style="border-radius:10px;background:#2563eb">
<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Apply</a>
</td></tr></table>
${tourHref ? `<p style="margin:0;font-size:13px;color:#64748b"><a href="${tourHref}" style="color:#2563eb">Schedule a tour</a> · <span style="word-break:break-all">${tourPlain}</span></p>` : ""}
${listingPlain ? `<p style="margin:8px 0 0 0;font-size:13px;color:#64748b;word-break:break-all">${listingPlain}</p>` : ""}
${noteBlock}
<p style="margin:16px 0 0 0;color:#64748b;font-size:14px">— PropLane</p>
</div>
</body>
</html>`;
  }

  const intro =
    params.kind === "apply"
      ? `Your property manager invited you to apply for <strong>${propertyTitle}</strong> on PropLane.`
      : params.kind === "lease"
        ? `Your property manager invited you to review and sign your lease for <strong>${propertyTitle}</strong> on PropLane.`
        : `Your property manager invited you to schedule a tour for <strong>${propertyTitle}</strong> on PropLane.`;
  const ctaLabel =
    params.kind === "apply" ? "Start application" : params.kind === "lease" ? "Open lease to sign" : "Schedule tour";
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#0f172a;font-size:15px;background:#f8fafc">
<div style="max-width:36rem;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
<p style="margin:0 0 12px 0">${greeting}</p>
<p style="margin:0 0 16px 0">${intro}</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 16px 0">
<tr><td style="border-radius:10px;background:#2563eb">
<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${ctaLabel}</a>
</td></tr></table>
<p style="margin:0;font-size:13px;color:#64748b">Or copy this link: <span style="word-break:break-all;color:#334155">${urlPlain}</span></p>
${noteBlock}
<p style="margin:16px 0 0 0;color:#64748b;font-size:14px">— PropLane</p>
</div>
</body>
</html>`;
}

export function buildLeadInviteMailtoHref(params: {
  to: string;
  kind: LeadInviteKind;
  prospectName?: string;
  propertyTitle: string;
  linkUrl: string;
  listingPageUrl?: string;
  tourUrl?: string;
  listingSummary?: ListingShareSummary;
  managerNote?: string;
  listingCount?: number;
}): string {
  const subject = encodeURIComponent(leadInviteSubject(params.kind, params.propertyTitle, params.listingCount));
  const body = encodeURIComponent(
    buildLeadInviteEmailBody({
      kind: params.kind,
      prospectName: params.prospectName,
      propertyTitle: params.propertyTitle,
      linkUrl: params.linkUrl,
      listingPageUrl: params.listingPageUrl,
      tourUrl: params.tourUrl,
      listingSummary: params.listingSummary,
      managerNote: params.managerNote,
      listingCount: params.listingCount,
    }),
  );
  return `mailto:${encodeURIComponent(params.to.trim())}?subject=${subject}&body=${body}`;
}
